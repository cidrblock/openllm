import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider';
import { ModelConfig, ChatMessage, ContentPart, Tool, StreamChunk, ToolCall } from '../types';
import { toAnthropicTools } from '../utils/toolTranslator';

/**
 * Anthropic Claude API provider implementation
 */
export class AnthropicProvider extends BaseProvider {
  get name(): string {
    return 'anthropic';
  }

  protected getDefaultApiBase(): string {
    return 'https://api.anthropic.com';
  }

  async streamChat(
    messages: vscode.LanguageModelChatMessage[],
    model: ModelConfig,
    options: {
      temperature?: number;
      maxTokens?: number;
      stop?: string[];
      tools?: Tool[];
      toolChoice?: 'auto' | 'none' | 'required';
    },
    token: vscode.CancellationToken
  ): Promise<AsyncIterable<StreamChunk>> {
    const apiBase = this.getApiBase(model);
    const url = `${apiBase}/v1/messages`;

    const convertedMessages = this.convertMessages(messages);
    
    // Anthropic requires system message to be separate
    const { systemMessage, chatMessages } = this.separateSystemMessage(convertedMessages);

    this.logger.debug(`Anthropic request to ${url} with model ${model.model}, tools: ${options.tools?.length ?? 0}`);

    const abortController = new AbortController();
    
    const cancelListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const requestBody: Record<string, unknown> = {
        model: model.model,
        messages: chatMessages,
        stream: true,
        max_tokens: options.maxTokens ?? 4096,
        ...(options.temperature !== undefined && { temperature: options.temperature }),
        ...(options.stop && { stop_sequences: options.stop }),
      };

      if (systemMessage) {
        requestBody.system = systemMessage;
      }

      // Add tools if provided
      if (options.tools && options.tools.length > 0) {
        requestBody.tools = toAnthropicTools(options.tools);
        if (options.toolChoice === 'required') {
          requestBody.tool_choice = { type: 'any' };
        } else if (options.toolChoice === 'none') {
          // Don't send tools at all if none
          delete requestBody.tools;
        } else {
          requestBody.tool_choice = { type: 'auto' };
        }
      }

      const response = await this.fetchWithError(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': model.apiKey!,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(requestBody),
          signal: abortController.signal,
        },
        'Anthropic'
      );

      return this.createAnthropicStream(response, token);
    } finally {
      cancelListener.dispose();
    }
  }

  /**
   * Create streaming response with tool call support for Anthropic
   */
  private createAnthropicStream(
    response: Response,
    token: vscode.CancellationToken
  ): AsyncIterable<StreamChunk> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const logger = this.logger;

    // Track current tool use block
    let currentToolUse: { id: string; name: string; inputJson: string } | null = null;

    return {
      async *[Symbol.asyncIterator]() {
        let buffer = '';

        try {
          while (true) {
            if (token.isCancellationRequested) {
              logger.debug('Request cancelled, aborting stream');
              await reader.cancel();
              break;
            }

            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) {
                continue;
              }

              const data = trimmed.slice(6).trim();

              try {
                const json = JSON.parse(data);

                // Handle different event types
                switch (json.type) {
                  case 'content_block_start':
                    if (json.content_block?.type === 'tool_use') {
                      currentToolUse = {
                        id: json.content_block.id,
                        name: json.content_block.name,
                        inputJson: ''
                      };
                    }
                    break;

                  case 'content_block_delta':
                    if (json.delta?.type === 'text_delta') {
                      yield { type: 'text', text: json.delta.text };
                    } else if (json.delta?.type === 'input_json_delta' && currentToolUse) {
                      currentToolUse.inputJson += json.delta.partial_json || '';
                    }
                    break;

                  case 'content_block_stop':
                    if (currentToolUse) {
                      let input: Record<string, unknown> = {};
                      try {
                        input = JSON.parse(currentToolUse.inputJson || '{}');
                      } catch {
                        logger.warn('Failed to parse Anthropic tool input:', currentToolUse.inputJson);
                      }

                      const toolCall: ToolCall = {
                        id: currentToolUse.id,
                        name: currentToolUse.name,
                        input
                      };
                      yield { type: 'tool_call', toolCall };
                      currentToolUse = null;
                    }
                    break;
                }
              } catch {
                // Skip invalid JSON
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }

  /**
   * Convert messages to Anthropic format with tool support
   */
  protected override convertMessages(
    messages: vscode.LanguageModelChatMessage[]
  ): ChatMessage[] {
    return messages.map(m => {
      let role: 'system' | 'user' | 'assistant';
      
      if (m.role === vscode.LanguageModelChatMessageRole.User) {
        role = 'user';
      } else if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
        role = 'assistant';
      } else {
        role = 'user';
      }

      // Check for tool-related content
      const contentParts: ContentPart[] = [];
      let textContent = '';
      
      for (const part of m.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          // Tool call from assistant - Anthropic format
          contentParts.push({
            type: 'tool_use',
            id: part.callId,
            name: part.name,
            input: part.input as Record<string, unknown>
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          // Tool result from user - Anthropic format
          let resultContent = '';
          for (const resultPart of part.content) {
            if (resultPart instanceof vscode.LanguageModelTextPart) {
              resultContent += resultPart.value;
            }
          }
          contentParts.push({
            type: 'tool_result',
            tool_use_id: part.callId,
            content: resultContent || '[No output]'
          });
        }
      }

      // If we have structured content (tool calls/results), return that
      if (contentParts.length > 0) {
        if (textContent) {
          contentParts.unshift({ type: 'text', text: textContent });
        }
        return { role, content: contentParts };
      }

      // Otherwise return plain text
      return { role, content: textContent || ' ' };
    });
  }

  /**
   * Separate system message from chat messages (Anthropic requirement)
   * Also handles tool use and tool result content blocks
   */
  private separateSystemMessage(messages: ChatMessage[]): {
    systemMessage: string | undefined;
    chatMessages: Array<{ role: 'user' | 'assistant'; content: string | object[] }>;
  } {
    let systemMessage: string | undefined;
    const chatMessages: Array<{ role: 'user' | 'assistant'; content: string | object[] }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Concatenate multiple system messages
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        systemMessage = systemMessage 
          ? `${systemMessage}\n\n${content}` 
          : content;
      } else {
        // Ensure non-empty content
        let content: string | object[] = '';
        if (typeof msg.content === 'string') {
          content = msg.content || ' '; // Anthropic doesn't allow empty content
        } else if (Array.isArray(msg.content)) {
          // Handle structured content (tool calls/results)
          content = msg.content;
        } else {
          content = String(msg.content) || ' ';
        }
        
        // Skip if content is still effectively empty
        if (content === '' || (Array.isArray(content) && content.length === 0)) {
          content = ' '; // Placeholder to avoid empty content error
        }
        
        chatMessages.push({
          role: msg.role as 'user' | 'assistant',
          content,
        });
      }
    }

    // Anthropic requires alternating user/assistant messages starting with user
    // If there are consecutive messages of the same role, we need to merge them
    const mergedMessages: Array<{ role: 'user' | 'assistant'; content: string | object[] }> = [];
    
    for (const msg of chatMessages) {
      const lastMsg = mergedMessages[mergedMessages.length - 1];
      if (lastMsg && lastMsg.role === msg.role) {
        // Merge consecutive messages of the same role
        if (typeof lastMsg.content === 'string' && typeof msg.content === 'string') {
          lastMsg.content += '\n\n' + msg.content;
        } else if (Array.isArray(lastMsg.content) && Array.isArray(msg.content)) {
          lastMsg.content = [...lastMsg.content, ...msg.content];
        } else if (typeof lastMsg.content === 'string' && Array.isArray(msg.content)) {
          lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...msg.content];
        } else if (Array.isArray(lastMsg.content) && typeof msg.content === 'string') {
          lastMsg.content = [...lastMsg.content, { type: 'text', text: msg.content }];
        }
      } else {
        mergedMessages.push({ 
          role: msg.role, 
          content: typeof msg.content === 'string' ? msg.content : [...(msg.content as object[])]
        });
      }
    }

    // Final pass: ensure no empty content
    for (const msg of mergedMessages) {
      if (typeof msg.content === 'string' && msg.content.trim() === '') {
        msg.content = ' ';
      }
    }

    return { systemMessage, chatMessages: mergedMessages };
  }

  private parseSSELine(line: string): string | null {
    if (!line.startsWith('data: ')) {
      return null;
    }

    const data = line.slice(6).trim();

    try {
      const json = JSON.parse(data);
      
      // Handle different event types
      if (json.type === 'content_block_delta') {
        return json.delta?.text || null;
      }
      
      return null;
    } catch {
      return null;
    }
  }

  async countTokens(text: string): Promise<number> {
    // Approximate token count (Claude uses similar tokenization to GPT)
    return Math.ceil(text.length / 3.5);
  }
}
