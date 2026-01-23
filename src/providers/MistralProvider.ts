import * as vscode from 'vscode';
import { BaseProvider } from './BaseProvider';
import { ModelConfig, Tool, StreamChunk, ToolCall } from '../types';
import { toOpenAITools } from '../utils/toolTranslator';

/**
 * Mistral AI API provider implementation
 * Uses OpenAI-compatible format for tools
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
      tools?: Tool[];
      toolChoice?: 'auto' | 'none' | 'required';
    },
    token: vscode.CancellationToken
  ): Promise<AsyncIterable<StreamChunk>> {
    const apiBase = this.getApiBase(model);
    const url = `${apiBase}/chat/completions`;

    const convertedMessages = this.convertMessages(messages);

    this.logger.debug(`Mistral request to ${url} with model ${model.model}, tools: ${options.tools?.length ?? 0}`);

    const abortController = new AbortController();
    
    const cancelListener = token.onCancellationRequested(() => {
      abortController.abort();
    });

    try {
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

      // Add tools if provided (Mistral uses OpenAI-compatible format)
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
        'Mistral'
      );

      return this.createMistralStream(response, token);
    } finally {
      cancelListener.dispose();
    }
  }

  /**
   * Create streaming response with tool call support (OpenAI-compatible)
   */
  private createMistralStream(
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
              await reader.cancel();
              break;
            }

            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data: ')) continue;

              const data = trimmed.slice(6).trim();
              if (data === '[DONE]') continue;

              try {
                const json = JSON.parse(data);
                const delta = json.choices?.[0]?.delta;

                if (delta?.content) {
                  yield { type: 'text', text: delta.content };
                }

                if (delta?.tool_calls) {
                  for (const toolCall of delta.tool_calls) {
                    const index = toolCall.index ?? 0;
                    if (!pendingToolCalls.has(index)) {
                      pendingToolCalls.set(index, { id: '', name: '', arguments: '' });
                    }
                    const pending = pendingToolCalls.get(index)!;
                    if (toolCall.id) pending.id = toolCall.id;
                    if (toolCall.function?.name) pending.name = toolCall.function.name;
                    if (toolCall.function?.arguments) pending.arguments += toolCall.function.arguments;
                  }
                }

                const finishReason = json.choices?.[0]?.finish_reason;
                if (finishReason === 'tool_calls' || finishReason === 'stop') {
                  for (const [, pending] of pendingToolCalls) {
                    if (pending.id && pending.name) {
                      let input: Record<string, unknown> = {};
                      try {
                        input = JSON.parse(pending.arguments || '{}');
                      } catch {
                        logger.warn('Failed to parse tool arguments');
                      }
                      const toolCall: ToolCall = { id: pending.id, name: pending.name, input };
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
    return Math.ceil(text.length / 4);
  }
}
