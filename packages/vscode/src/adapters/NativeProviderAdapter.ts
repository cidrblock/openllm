import * as vscode from 'vscode';
import { ModelConfig, Tool, StreamChunk } from '../types';
import { MessageConverter } from './MessageConverter';
import { getNative } from '../utils/nativeLoader';
import { getLogger } from '../utils/logger';

// Import types from native module - will be dynamically loaded
interface NativeStreamChunk {
  chunkType: string;
  text?: string;
  toolCall?: {
    id: string;
    name: string;
    input: string;
  };
  toolCallId?: string;
  toolName?: string;
  toolInputDelta?: string;
}

interface NativeChatMessage {
  role: string;
  content: string;
}

interface NativeProviderRequestConfig {
  model: string;
  apiKey?: string;
  apiBase?: string;
}

interface NativeStreamChatOptions {
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
}

type StreamCallback = (err: Error | null, chunk: NativeStreamChunk | null) => void;

interface NativeProvider {
  name: string;
  metadata(): {
    id: string;
    displayName: string;
    defaultApiBase: string;
    requiresApiKey: boolean;
    defaultModels: Array<{
      id: string;
      name: string;
      contextLength: number;
      capabilities: {
        imageInput: boolean;
        toolCalling: boolean;
        streaming: boolean;
      };
    }>;
  };
  streamChat(
    messages: NativeChatMessage[],
    config: NativeProviderRequestConfig,
    options: NativeStreamChatOptions | undefined,
    callback: StreamCallback
  ): Promise<void>;
}

/**
 * Adapter that wraps a native (Rust) provider to work with VS Code types
 */
export class NativeProviderAdapter {
  private logger = getLogger();
  
  constructor(private nativeProvider: NativeProvider) {}

  /**
   * Get the provider name
   */
  get name(): string {
    return this.nativeProvider.name;
  }

  /**
   * Get provider metadata
   */
  get metadata() {
    return this.nativeProvider.metadata();
  }

  /**
   * Convert VS Code messages to native format
   */
  private convertMessages(messages: vscode.LanguageModelChatMessage[]): NativeChatMessage[] {
    return messages.map(msg => {
      // Get role string
      let role: string;
      switch (msg.role) {
        case vscode.LanguageModelChatMessageRole.User:
          role = 'User';
          break;
        case vscode.LanguageModelChatMessageRole.Assistant:
          role = 'Assistant';
          break;
        default:
          role = 'User';
      }

      // Get content as string
      let content = '';
      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          content += part.value;
        }
      }

      return { role, content };
    });
  }

  /**
   * Convert native chunk to our StreamChunk format
   */
  private convertChunk(nativeChunk: NativeStreamChunk): StreamChunk {
    if (nativeChunk.chunkType === 'text' && nativeChunk.text) {
      return { type: 'text', text: nativeChunk.text };
    } else if (nativeChunk.chunkType === 'tool_call' && nativeChunk.toolCall) {
      return {
        type: 'tool_call',
        toolCall: {
          id: nativeChunk.toolCall.id,
          name: nativeChunk.toolCall.name,
          input: JSON.parse(nativeChunk.toolCall.input)
        }
      };
    } else if (nativeChunk.chunkType === 'tool_call_delta') {
      return {
        type: 'tool_call_delta',
        id: nativeChunk.toolCallId || '',
        name: nativeChunk.toolName,
        inputDelta: nativeChunk.toolInputDelta
      };
    }
    return { type: 'text', text: '' };
  }

  /**
   * Stream chat using VS Code types, delegating to native provider
   */
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
    this.logger.info(`[NativeProviderAdapter.streamChat] Starting for model: ${model.model}`);
    
    const nativeMessages = this.convertMessages(messages);
    this.logger.info(`[NativeProviderAdapter.streamChat] Converted ${messages.length} messages to native format`);
    
    const nativeConfig: NativeProviderRequestConfig = {
      model: model.model,
      apiKey: model.apiKey,
      apiBase: model.apiBase
    };
    this.logger.info(`[NativeProviderAdapter.streamChat] Config: model=${nativeConfig.model}, apiKey=${nativeConfig.apiKey ? 'present' : 'MISSING'}, apiBase=${nativeConfig.apiBase || 'default'}`);

    const nativeOptions: NativeStreamChatOptions = {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stop: options.stop
    };
    this.logger.info(`[NativeProviderAdapter.streamChat] Options: temp=${nativeOptions.temperature}, maxTokens=${nativeOptions.maxTokens}`);

    // Create an async iterable from the callback-based native stream
    const self = this;
    
    return {
      [Symbol.asyncIterator](): AsyncIterator<StreamChunk> {
        const chunks: StreamChunk[] = [];
        let resolveNext: ((value: IteratorResult<StreamChunk>) => void) | null = null;
        let rejectNext: ((reason: Error) => void) | null = null;
        let done = false;
        let error: Error | null = null;
        let streamStarted = false;

        // Start the stream
        const startStream = () => {
          if (streamStarted) return;
          streamStarted = true;
          
          self.logger.info(`[NativeProviderAdapter] Starting native streamChat call...`);

          self.nativeProvider.streamChat(
            nativeMessages,
            nativeConfig,
            nativeOptions,
            (err, chunk) => {
              if (err) {
                self.logger.error(`[NativeProviderAdapter] Stream error:`, err);
                error = err;
                done = true;
                if (rejectNext) {
                  rejectNext(err);
                  rejectNext = null;
                  resolveNext = null;
                }
                return;
              }

              if (chunk) {
                self.logger.debug(`[NativeProviderAdapter] Got chunk: ${chunk.chunkType}`);
                const converted = self.convertChunk(chunk);
                if (resolveNext) {
                  resolveNext({ value: converted, done: false });
                  resolveNext = null;
                  rejectNext = null;
                } else {
                  chunks.push(converted);
                }
              }
            }
          ).then(() => {
            self.logger.info(`[NativeProviderAdapter] Stream completed successfully`);
            done = true;
            if (resolveNext) {
              resolveNext({ value: undefined as any, done: true });
              resolveNext = null;
              rejectNext = null;
            }
          }).catch((err) => {
            self.logger.error(`[NativeProviderAdapter] Stream promise rejected:`, err);
            error = err;
            done = true;
            if (rejectNext) {
              rejectNext(err);
              rejectNext = null;
              resolveNext = null;
            }
          });
        };

        return {
          async next(): Promise<IteratorResult<StreamChunk>> {
            startStream();

            // Check for cancellation
            if (token.isCancellationRequested) {
              return { value: undefined as any, done: true };
            }

            // If we have buffered chunks, return one
            if (chunks.length > 0) {
              return { value: chunks.shift()!, done: false };
            }

            // If already done or errored
            if (done) {
              if (error) {
                throw error;
              }
              return { value: undefined as any, done: true };
            }

            // Wait for next chunk
            return new Promise((resolve, reject) => {
              resolveNext = resolve;
              rejectNext = reject;
            });
          }
        };
      }
    };
  }

  /**
   * Count tokens (approximation based on character count)
   */
  async countTokens(text: string): Promise<number> {
    // Simple approximation: ~4 characters per token
    return Math.ceil(text.length / 4);
  }
}

/**
 * Factory function to create native providers
 */
export function createNativeProvider(providerName: string): NativeProviderAdapter | null {
  try {
    // Try to load the native module
    const native = getNative();
    
    let provider: NativeProvider | null = null;
    
    switch (providerName.toLowerCase()) {
      case 'openai':
        provider = new native.OpenAiProvider();
        break;
      case 'anthropic':
        provider = new native.AnthropicProvider();
        break;
      case 'gemini':
      case 'google':
        provider = new native.GeminiProvider();
        break;
      case 'ollama':
        provider = new native.OllamaProvider();
        break;
      case 'mistral':
        provider = new native.MistralProvider();
        break;
      case 'azure':
      case 'azure-openai':
        provider = new native.AzureOpenAiProvider();
        break;
      case 'openrouter':
        provider = new native.OpenRouterProvider();
        break;
      default:
        return null;
    }

    if (provider) {
      return new NativeProviderAdapter(provider);
    }
  } catch (e) {
    // Native module not available, fall back to TypeScript implementation
    console.warn('Native module not available, using TypeScript providers');
  }
  
  return null;
}

/**
 * Check if native providers are available
 */
export function isNativeAvailable(): boolean {
  try {
    getNative();
    return true;
  } catch {
    return false;
  }
}
