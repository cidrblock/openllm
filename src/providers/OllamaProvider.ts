import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider';
import { ModelConfig, Tool, StreamChunk, ToolCall } from '../types';
import { toOpenAITools } from '../utils/toolTranslator';

/**
 * Ollama local LLM provider implementation
 * Supports tool calling for models that have it enabled (e.g., llama3.1, mistral)
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
      tools?: Tool[];
      toolChoice?: 'auto' | 'none' | 'required';
    },
    token: vscode.CancellationToken
  ): Promise<AsyncIterable<StreamChunk>> {
    const apiBase = this.getApiBase(model);
    const url = `${apiBase}/api/chat`;

    const convertedMessages = this.convertMessages(messages);

    this.logger.debug(`Ollama request to ${url} with model ${model.model}, tools: ${options.tools?.length ?? 0}`);

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

      // Add tools if provided (Ollama uses OpenAI-compatible format)
      if (options.tools && options.tools.length > 0) {
        requestBody.tools = toOpenAITools(options.tools);
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
        'Ollama'
      );

      return this.createOllamaStream(response, token);
    } finally {
      cancelListener.dispose();
    }
  }

  /**
   * Create stream with tool call support
   */
  private createOllamaStream(
    response: Response,
    token: vscode.CancellationToken
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
              if (!trimmed) continue;

              try {
                const json = JSON.parse(trimmed);
                const message = json.message as Record<string, unknown> | undefined;

                if (message) {
                  // Handle text content
                  if (typeof message.content === 'string' && message.content) {
                    yield { type: 'text', text: message.content };
                  }

                  // Handle tool calls (Ollama returns them in tool_calls array)
                  const toolCalls = message.tool_calls as Array<{
                    function: { name: string; arguments: Record<string, unknown> | string };
                  }> | undefined;

                  if (toolCalls && toolCalls.length > 0) {
                    for (let i = 0; i < toolCalls.length; i++) {
                      const tc = toolCalls[i];
                      let input: Record<string, unknown> = {};
                      
                      if (typeof tc.function.arguments === 'string') {
                        try {
                          input = JSON.parse(tc.function.arguments);
                        } catch {
                          logger.warn('Failed to parse Ollama tool arguments');
                        }
                      } else {
                        input = tc.function.arguments || {};
                      }

                      const toolCall: ToolCall = {
                        id: `ollama_call_${i}_${Date.now()}`,
                        name: tc.function.name,
                        input
                      };
                      yield { type: 'tool_call', toolCall };
                    }
                  }
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
