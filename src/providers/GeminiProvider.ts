import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider';
import { ModelConfig, ChatMessage, Tool, StreamChunk, ToolCall } from '../types';
import { toGeminiTools } from '../utils/toolTranslator';

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
      tools?: Tool[];
      toolChoice?: 'auto' | 'none' | 'required';
    },
    token: vscode.CancellationToken
  ): Promise<AsyncIterable<StreamChunk>> {
    const apiBase = this.getApiBase(model);
    const url = `${apiBase}/v1beta/models/${model.model}:streamGenerateContent?key=${model.apiKey}`;

    const convertedMessages = this.convertMessages(messages);
    const { systemInstruction, contents } = this.convertToGeminiFormat(convertedMessages);

    this.logger.debug(`Gemini request to model ${model.model}, tools: ${options.tools?.length ?? 0}`);

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

      // Add tools if provided
      if (options.tools && options.tools.length > 0) {
        requestBody.tools = toGeminiTools(options.tools);
        if (options.toolChoice === 'required') {
          requestBody.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
        } else if (options.toolChoice === 'none') {
          requestBody.toolConfig = { functionCallingConfig: { mode: 'NONE' } };
        } else {
          requestBody.toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
        }
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

      return this.createGeminiStreamWithTools(response, token);
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
   * Create stream from Gemini response with tool call support
   */
  private createGeminiStreamWithTools(
    response: Response,
    token: vscode.CancellationToken
  ): AsyncIterable<StreamChunk> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const logger = this.logger;
    let toolCallCounter = 0;

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

            // Try to parse complete JSON objects from the buffer
            // Gemini returns an array of response objects
            try {
              // Look for complete JSON objects in the buffer
              const jsonMatches = buffer.match(/\{[\s\S]*?"candidates"[\s\S]*?\}(?=\s*[,\]]|$)/g);
              
              if (jsonMatches) {
                for (const jsonStr of jsonMatches) {
                  try {
                    const parsed = JSON.parse(jsonStr);
                    const candidate = parsed.candidates?.[0];
                    const parts = candidate?.content?.parts;

                    if (parts) {
                      for (const part of parts) {
                        // Handle text content
                        if (part.text) {
                          yield { type: 'text', text: part.text };
                        }

                        // Handle function calls
                        if (part.functionCall) {
                          const toolCall: ToolCall = {
                            id: `gemini_call_${toolCallCounter++}_${Date.now()}`,
                            name: part.functionCall.name,
                            input: part.functionCall.args || {}
                          };
                          yield { type: 'tool_call', toolCall };
                        }
                      }
                    }
                  } catch {
                    // Skip unparseable JSON
                  }
                }
              }

              // Also try simple text extraction for simpler responses
              const textMatches = buffer.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
              for (const match of textMatches) {
                try {
                  const text = JSON.parse(`"${match[1]}"`);
                  if (text) {
                    yield { type: 'text', text };
                  }
                } catch {
                  // Skip
                }
              }
            } catch {
              // Continue accumulating buffer
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
