import * as vscode from 'vscode';
import { OpenAIProvider } from './OpenAIProvider';
import { ModelConfig, Tool, StreamChunk } from '../types';

/**
 * OpenRouter API provider implementation
 * OpenRouter provides access to 100+ models via a single OpenAI-compatible API
 * 
 * Supports models from: OpenAI, Anthropic, Google, Meta, Mistral, Cohere, and more
 * Model names use format: provider/model-name (e.g., openai/gpt-4o, anthropic/claude-3.5-sonnet)
 */
export class OpenRouterProvider extends OpenAIProvider {
  get name(): string {
    return 'openrouter';
  }

  protected getDefaultApiBase(): string {
    return 'https://openrouter.ai/api/v1';
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
    // OpenRouter uses the same format as OpenAI, but with extra headers
    // We override to add the recommended headers
    
    const apiBase = this.getApiBase(model);
    const url = `${apiBase}/chat/completions`;

    const convertedMessages = this.convertMessagesForOpenAI(messages);

    this.logger.debug(`OpenRouter request to ${url} with model ${model.model}, tools: ${options.tools?.length ?? 0}`);

    const abortController = new AbortController();
    
    const cancelListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
      // Build request body (same as OpenAI)
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

      // Add tools if provided (OpenRouter supports tool calling for compatible models)
      if (options.tools && options.tools.length > 0) {
        const { toOpenAITools } = await import('../utils/toolTranslator');
        body.tools = toOpenAITools(options.tools);
        body.tool_choice = options.toolChoice || 'auto';
      }

      // OpenRouter-specific headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${model.apiKey}`,
        'HTTP-Referer': 'https://github.com/open-llm-provider', // Recommended by OpenRouter
        'X-Title': 'Open LLM Provider' // App name for OpenRouter dashboard
      };

      const response = await this.fetchWithError(
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: abortController.signal,
        },
        'OpenRouter'
      );

      return this.createOpenAIStreamInternal(response, token);
    } finally {
      cancelListener.dispose();
    }
  }

  /**
   * Create streaming response - reuse OpenAI's streaming logic
   * This is a wrapper to access the parent's private method
   */
  private createOpenAIStreamInternal(
    response: Response,
    token: vscode.CancellationToken
  ): AsyncIterable<StreamChunk> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const logger = this.logger;

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

                // Check if message is finished
                const finishReason = json.choices?.[0]?.finish_reason;
                if (finishReason === 'tool_calls' || finishReason === 'stop') {
                  for (const [, pending] of pendingToolCalls) {
                    if (pending.id && pending.name) {
                      let input: Record<string, unknown> = {};
                      try {
                        input = JSON.parse(pending.arguments || '{}');
                      } catch {
                        logger.warn('Failed to parse tool call arguments:', pending.arguments);
                      }

                      yield { 
                        type: 'tool_call', 
                        toolCall: {
                          id: pending.id,
                          name: pending.name,
                          input
                        }
                      };
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
    // Approximate - varies by model
    return Math.ceil(text.length / 4);
  }
}
