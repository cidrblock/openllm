import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider';
import { ModelConfig } from '../types';

/**
 * Mistral AI API provider implementation
 */
export class MistralProvider extends BaseProvider {
  get name(): string {
    return 'mistral';
  }

  protected getDefaultApiBase(): string {
    return 'https://api.mistral.ai/v1';
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
    const url = `${apiBase}/chat/completions`;

    const convertedMessages = this.convertMessages(messages);

    this.logger.debug(`Mistral request to ${url} with model ${model.model}`);

    const abortController = new AbortController();
    
    const cancelListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const response = await this.fetchWithError(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${model.apiKey}`,
          },
          body: JSON.stringify({
            model: model.model,
            messages: convertedMessages,
            stream: true,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 4096,
            ...(options.stop && { stop: options.stop }),
          }),
          signal: abortController.signal,
        },
        'Mistral'
      );

      return this.createStreamFromResponse(response, token, this.parseSSELine.bind(this));
    } finally {
      cancelListener.dispose();
    }
  }

  private parseSSELine(line: string): string | null {
    if (!line.startsWith('data: ')) {
      return null;
    }

    const data = line.slice(6).trim();
    
    if (data === '[DONE]') {
      return null;
    }

    try {
      const json = JSON.parse(data);
      return json.choices?.[0]?.delta?.content || null;
    } catch {
      return null;
    }
  }

  async countTokens(text: string): Promise<number> {
    // Approximate token count
    return Math.ceil(text.length / 4);
  }
}
