import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider';
import { ModelConfig } from '../types';

/**
 * Azure OpenAI API provider implementation
 */
export class AzureOpenAIProvider extends BaseProvider {
  get name(): string {
    return 'azure';
  }

  protected getDefaultApiBase(): string {
    // Azure requires custom endpoint, no sensible default
    return '';
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
    if (!model.apiBase) {
      throw new Error('Azure OpenAI requires an API base URL (your Azure endpoint)');
    }

    // Azure URL format: https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}
    const apiVersion = '2024-02-15-preview';
    const url = `${model.apiBase}/openai/deployments/${model.model}/chat/completions?api-version=${apiVersion}`;

    const convertedMessages = this.convertMessages(messages);

    this.logger.debug(`Azure OpenAI request to ${url}`);

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
            'api-key': model.apiKey!,
          },
          body: JSON.stringify({
            messages: convertedMessages,
            stream: true,
            temperature: options.temperature ?? 0.7,
            max_tokens: options.maxTokens ?? 4096,
            ...(options.stop && { stop: options.stop }),
          }),
          signal: abortController.signal,
        },
        'Azure OpenAI'
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
    // Approximate token count (same as OpenAI)
    return Math.ceil(text.length / 4);
  }
}
