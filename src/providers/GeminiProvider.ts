import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider';
import { ModelConfig, ChatMessage } from '../types';

/**
 * Google Gemini API provider implementation
 */
export class GeminiProvider extends BaseProvider {
  get name(): string {
    return 'gemini';
  }

  protected getDefaultApiBase(): string {
    return 'https://generativelanguage.googleapis.com';
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
    const url = `${apiBase}/v1beta/models/${model.model}:streamGenerateContent?key=${model.apiKey}`;

    const convertedMessages = this.convertMessages(messages);
    const { systemInstruction, contents } = this.convertToGeminiFormat(convertedMessages);

    this.logger.debug(`Gemini request to model ${model.model}`);

    const abortController = new AbortController();
    
    const cancelListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      const requestBody: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0.7,
          maxOutputTokens: options.maxTokens ?? 4096,
          ...(options.stop && { stopSequences: options.stop }),
        },
      };

      if (systemInstruction) {
        requestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
      }

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
        'Gemini'
      );

      return this.createGeminiStream(response, token);
    } finally {
      cancelListener.dispose();
    }
  }

  /**
   * Convert messages to Gemini format
   */
  private convertToGeminiFormat(messages: ChatMessage[]): {
    systemInstruction: string | undefined;
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
  } {
    let systemInstruction: string | undefined;
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = systemInstruction 
          ? `${systemInstruction}\n\n${msg.content as string}` 
          : msg.content as string;
      } else {
        // Gemini uses 'user' and 'model' roles
        const role = msg.role === 'assistant' ? 'model' : 'user';
        contents.push({
          role,
          parts: [{ text: msg.content as string }],
        });
      }
    }

    return { systemInstruction, contents };
  }

  /**
   * Create stream from Gemini response (uses JSON array streaming)
   */
  private createGeminiStream(
    response: Response,
    token: vscode.CancellationToken
  ): AsyncIterable<string> {
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

            // Gemini streams JSON objects, try to parse complete objects
            // The response is a JSON array, so we look for complete objects
            const matches = buffer.matchAll(/\{[^{}]*"text"\s*:\s*"([^"]*)"[^{}]*\}/g);
            
            for (const match of matches) {
              // Extract text from the match
              try {
                const jsonStr = match[0];
                const parsed = JSON.parse(jsonStr);
                const text = parsed.text;
                if (text) {
                  yield text;
                }
              } catch {
                // Try extracting from candidates structure
                try {
                  const text = match[1];
                  if (text) {
                    // Unescape the string
                    yield JSON.parse(`"${text}"`);
                  }
                } catch {
                  // Skip unparseable content
                }
              }
            }

            // Keep unprocessed part of buffer
            const lastBrace = buffer.lastIndexOf('}');
            if (lastBrace !== -1) {
              buffer = buffer.slice(lastBrace + 1);
            }
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }

  async countTokens(text: string): Promise<number> {
    // Approximate token count
    return Math.ceil(text.length / 4);
  }
}
