import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider';
import { ModelConfig, ChatMessage } from '../types';

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
    },
    token: vscode.CancellationToken
  ): Promise<AsyncIterable<string>> {
    const apiBase = this.getApiBase(model);
    const url = `${apiBase}/v1/messages`;

    const convertedMessages = this.convertMessages(messages);
    
    // Anthropic requires system message to be separate
    const { systemMessage, chatMessages } = this.separateSystemMessage(convertedMessages);

    this.logger.debug(`Anthropic request to ${url} with model ${model.model}`);

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

      return this.createStreamFromResponse(response, token, this.parseSSELine.bind(this));
    } finally {
      cancelListener.dispose();
    }
  }

  /**
   * Separate system message from chat messages (Anthropic requirement)
   */
  private separateSystemMessage(messages: ChatMessage[]): {
    systemMessage: string | undefined;
    chatMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } {
    let systemMessage: string | undefined;
    const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Concatenate multiple system messages
        systemMessage = systemMessage 
          ? `${systemMessage}\n\n${msg.content as string}` 
          : msg.content as string;
      } else {
        chatMessages.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content as string,
        });
      }
    }

    // Anthropic requires alternating user/assistant messages starting with user
    // If there are consecutive messages of the same role, we need to merge them
    const mergedMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    
    for (const msg of chatMessages) {
      const lastMsg = mergedMessages[mergedMessages.length - 1];
      if (lastMsg && lastMsg.role === msg.role) {
        lastMsg.content += '\n\n' + msg.content;
      } else {
        mergedMessages.push({ ...msg });
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
