import * as vscode from 'vscode';
import { ModelConfig, ChatMessage, Tool, StreamChunk } from '../types';
import { getLogger } from '../utils/logger';

/**
 * Abstract base class for LLM provider implementations
 */
export abstract class BaseProvider {
  protected logger = getLogger();

  /**
   * Get the provider name
   */
  abstract get name(): string;

  /**
   * Get the default API base URL for this provider
   */
  protected abstract getDefaultApiBase(): string;

  /**
   * Stream a chat completion from the provider
   */
  abstract streamChat(
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
  ): Promise<AsyncIterable<StreamChunk>>;

  /**
   * Count tokens for the given text (approximate)
   */
  abstract countTokens(text: string): Promise<number>;

  /**
   * Get the API base URL, using custom if provided or default
   */
  protected getApiBase(model: ModelConfig): string {
    return model.apiBase || this.getDefaultApiBase();
  }

  /**
   * Convert VS Code LanguageModelChatMessages to provider format
   * Base implementation handles text only. Providers override for tool support.
   */
  protected convertMessages(
    messages: vscode.LanguageModelChatMessage[]
  ): ChatMessage[] {
    return messages.map(m => {
      let role: 'system' | 'user' | 'assistant';
      
      if (m.role === vscode.LanguageModelChatMessageRole.User) {
        role = 'user';
      } else if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
        role = 'assistant';
      } else {
        role = 'user'; // Default to user for unknown roles
      }

      // Extract text content from message parts
      let textContent = '';
      for (const part of m.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textContent += part.value;
        }
        // Tool parts are handled by provider-specific overrides
      }

      // Fallback to prevent empty content
      return { role, content: textContent || ' ' };
    });
  }

  /**
   * Create an async iterable from a fetch Response with SSE streaming
   * Returns StreamChunk for unified handling of text and tool calls
   */
  protected createStreamFromResponse(
    response: Response,
    token: vscode.CancellationToken,
    parser: (line: string) => StreamChunk | null
  ): AsyncIterable<StreamChunk> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const logger = this.logger;

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
              if (!trimmed || trimmed.startsWith(':')) {
                continue;
              }

              const content = parser(trimmed);
              if (content) {
                yield content;
              }
            }
          }

          // Process any remaining content in buffer
          if (buffer.trim()) {
            const content = parser(buffer.trim());
            if (content) {
              yield content;
            }
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }

  /**
   * Legacy text-only stream helper - wraps text in StreamChunk
   */
  protected createTextStreamFromResponse(
    response: Response,
    token: vscode.CancellationToken,
    parser: (line: string) => string | null
  ): AsyncIterable<StreamChunk> {
    return this.createStreamFromResponse(response, token, (line) => {
      const text = parser(line);
      return text ? { type: 'text', text } : null;
    });
  }

  /**
   * Create an async iterable from NDJSON streaming (used by Ollama)
   */
  protected createNDJSONStream(
    response: Response,
    token: vscode.CancellationToken,
    parser: (json: Record<string, unknown>) => StreamChunk | null
  ): AsyncIterable<StreamChunk> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const logger = this.logger;

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
              if (!trimmed) {
                continue;
              }

              try {
                const json = JSON.parse(trimmed);
                const content = parser(json);
                if (content) {
                  yield content;
                }
              } catch {
                // Skip invalid JSON lines
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
   * Legacy text-only NDJSON stream helper
   */
  protected createTextNDJSONStream(
    response: Response,
    token: vscode.CancellationToken,
    parser: (json: Record<string, unknown>) => string | null
  ): AsyncIterable<StreamChunk> {
    return this.createNDJSONStream(response, token, (json) => {
      const text = parser(json);
      return text ? { type: 'text', text } : null;
    });
  }

  /**
   * Make a fetch request with proper error handling
   */
  protected async fetchWithError(
    url: string,
    options: RequestInit,
    providerName: string
  ): Promise<Response> {
    const response = await fetch(url, options);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage: string;

      try {
        const errorJson = JSON.parse(errorText);
        errorMessage = errorJson.error?.message || errorJson.message || errorText;
      } catch {
        errorMessage = errorText;
      }

      throw new Error(`${providerName} API error (${response.status}): ${errorMessage}`);
    }

    return response;
  }
}
