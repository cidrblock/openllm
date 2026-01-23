import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider';
import { ModelConfig, Tool, StreamChunk, ToolCall } from '../types';
import { toOpenAITools } from '../utils/toolTranslator';

/**
 * OpenAI message format for API requests
 */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

/**
 * OpenAI API provider implementation
 * Also compatible with OpenAI-compatible APIs (e.g., Together, Groq, etc.)
 */
export class OpenAIProvider extends BaseProvider {
  get name(): string {
    return 'openai';
  }

  protected getDefaultApiBase(): string {
    return 'https://api.openai.com/v1';
  }

  /**
   * Convert messages to OpenAI format with tool support
   */
  protected convertMessagesForOpenAI(
    messages: vscode.LanguageModelChatMessage[]
  ): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    for (const m of messages) {
      let role: 'system' | 'user' | 'assistant' = 'user';
      
      if (m.role === vscode.LanguageModelChatMessageRole.User) {
        role = 'user';
      } else if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
        role = 'assistant';
      }

      // Check for tool-related content
      let textContent = '';
      const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
      const toolResults: Array<{ tool_call_id: string; content: string }> = [];
      
      for (const part of m.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          // Tool call from assistant
          toolCalls.push({
            id: part.callId,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input)
            }
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          // Tool result - needs to be separate message in OpenAI format
          let resultContent = '';
          for (const resultPart of part.content) {
            if (resultPart instanceof vscode.LanguageModelTextPart) {
              resultContent += resultPart.value;
            }
          }
          toolResults.push({
            tool_call_id: part.callId,
            content: resultContent || '[No output]'
          });
        }
      }

      // If assistant message has tool calls
      if (role === 'assistant' && toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls
        });
      } else if (toolResults.length > 0) {
        // Tool results become separate 'tool' role messages
        for (const tr of toolResults) {
          result.push({
            role: 'tool',
            content: tr.content,
            tool_call_id: tr.tool_call_id
          });
        }
      } else {
        // Regular message
        result.push({
          role,
          content: textContent || ' '
        });
      }
    }

    return result;
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
    const url = `${apiBase}/chat/completions`;

    const convertedMessages = this.convertMessagesForOpenAI(messages);

    this.logger.debug(`OpenAI request to ${url} with model ${model.model}, tools: ${options.tools?.length ?? 0}`);

    const abortController = new AbortController();
    
    // Handle cancellation
    const cancelListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      // Build request body
      const body: Record<string, unknown> = {
        model: model.model,
        messages: convertedMessages,
        stream: true,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens ?? 4096,
      };

      if (options.stop) {
        body.stop = options.stop;
      }

      // Add tools if provided
      if (options.tools && options.tools.length > 0) {
        body.tools = toOpenAITools(options.tools);
        body.tool_choice = options.toolChoice || 'auto';
      }

      const response = await this.fetchWithError(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${model.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: abortController.signal,
        },
        'OpenAI'
      );

      return this.createOpenAIStream(response, token);
    } finally {
      cancelListener.dispose();
    }
  }

  /**
   * Create streaming response with tool call support
   */
  private createOpenAIStream(
    response: Response,
    token: vscode.CancellationToken
  ): AsyncIterable<StreamChunk> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const logger = this.logger;

    // Track tool calls being built up from deltas
    const pendingToolCalls = new Map<number, { id: string; name: string; arguments: string }>();

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
              if (data === '[DONE]') {
                continue;
              }

              try {
                const json = JSON.parse(data);
                const delta = json.choices?.[0]?.delta;

                if (!delta) continue;

                // Handle text content
                if (delta.content) {
                  yield { type: 'text', text: delta.content };
                }

                // Handle tool calls
                if (delta.tool_calls) {
                  for (const toolCall of delta.tool_calls) {
                    const index = toolCall.index ?? 0;

                    if (!pendingToolCalls.has(index)) {
                      pendingToolCalls.set(index, {
                        id: toolCall.id || '',
                        name: toolCall.function?.name || '',
                        arguments: ''
                      });
                    }

                    const pending = pendingToolCalls.get(index)!;

                    if (toolCall.id) {
                      pending.id = toolCall.id;
                    }
                    if (toolCall.function?.name) {
                      pending.name = toolCall.function.name;
                    }
                    if (toolCall.function?.arguments) {
                      pending.arguments += toolCall.function.arguments;
                    }
                  }
                }

                // Check if message is finished (finish_reason)
                const finishReason = json.choices?.[0]?.finish_reason;
                if (finishReason === 'tool_calls' || finishReason === 'stop') {
                  // Emit completed tool calls
                  for (const [, pending] of pendingToolCalls) {
                    if (pending.id && pending.name) {
                      let input: Record<string, unknown> = {};
                      try {
                        input = JSON.parse(pending.arguments || '{}');
                      } catch {
                        logger.warn('Failed to parse tool call arguments:', pending.arguments);
                      }

                      const toolCall: ToolCall = {
                        id: pending.id,
                        name: pending.name,
                        input
                      };
                      yield { type: 'tool_call', toolCall };
                    }
                  }
                  pendingToolCalls.clear();
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

  async countTokens(text: string): Promise<number> {
    // Approximate token count (roughly 4 characters per token for English)
    // For production, you'd want to use tiktoken
    return Math.ceil(text.length / 4);
  }
}
