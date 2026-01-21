import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider';
import { ModelConfig } from '../types';

/**
 * Ollama local LLM provider implementation
 */
export class OllamaProvider extends BaseProvider {
  get name(): string {
    return 'ollama';
  }

  protected getDefaultApiBase(): string {
    return 'http://localhost:11434';
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
    const url = `${apiBase}/api/chat`;

    const convertedMessages = this.convertMessages(messages);

    this.logger.debug(`Ollama request to ${url} with model ${model.model}`);

    const abortController = new AbortController();
    
    const cancelListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const requestBody: Record<string, unknown> = {
        model: model.model,
        messages: convertedMessages,
        stream: true,
        options: {
          ...(options.temperature !== undefined && { temperature: options.temperature }),
          ...(options.maxTokens && { num_predict: options.maxTokens }),
          ...(options.stop && { stop: options.stop }),
        },
      };

      const response = await this.fetchWithError(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
          signal: abortController.signal,
        },
        'Ollama'
      );

      return this.createNDJSONStream(response, token, this.parseOllamaLine.bind(this));
    } finally {
      cancelListener.dispose();
    }
  }

  private parseOllamaLine(json: Record<string, unknown>): string | null {
    const message = json.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === 'string') {
      return message.content;
    }
    return null;
  }

  /**
   * List available models from Ollama
   */
  async listModels(apiBase?: string): Promise<string[]> {
    const url = `${apiBase || this.getDefaultApiBase()}/api/tags`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to list models: ${response.status}`);
      }

      const data = await response.json() as { models?: Array<{ name: string }> };
      return data.models?.map(m => m.name) || [];
    } catch (error) {
      this.logger.error('Failed to list Ollama models:', error);
      return [];
    }
  }

  /**
   * Check if Ollama is running and accessible
   */
  async isAvailable(apiBase?: string): Promise<boolean> {
    const url = `${apiBase || this.getDefaultApiBase()}/api/tags`;

    try {
      const response = await fetch(url, { 
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async countTokens(text: string): Promise<number> {
    // Approximate token count
    return Math.ceil(text.length / 4);
  }
}
