import { BaseProvider } from '../providers/BaseProvider';
import { OpenAIProvider } from '../providers/OpenAIProvider';
import { AnthropicProvider } from '../providers/AnthropicProvider';
import { GeminiProvider } from '../providers/GeminiProvider';
import { OllamaProvider } from '../providers/OllamaProvider';
import { MistralProvider } from '../providers/MistralProvider';
import { AzureOpenAIProvider } from '../providers/AzureOpenAIProvider';
import { OpenRouterProvider } from '../providers/OpenRouterProvider';
import { ProviderMetadata } from '../types';
import { getLogger } from '../utils/logger';

type ProviderConstructor = new () => BaseProvider;

/**
 * Registry of available LLM providers
 */
export class ProviderRegistry {
  private providers: Map<string, ProviderConstructor> = new Map();
  private instances: Map<string, BaseProvider> = new Map();
  private logger = getLogger();

  constructor() {
    this.registerBuiltinProviders();
  }

  /**
   * Register all built-in providers
   */
  private registerBuiltinProviders(): void {
    this.register('openai', OpenAIProvider);
    this.register('anthropic', AnthropicProvider);
    this.register('google', GeminiProvider);
    this.register('gemini', GeminiProvider);
    this.register('ollama', OllamaProvider);
    this.register('mistral', MistralProvider);
    this.register('azure', AzureOpenAIProvider);
    this.register('azure-openai', AzureOpenAIProvider);
    this.register('openrouter', OpenRouterProvider);
    
    this.logger.debug(`Registered ${this.providers.size} providers`);
  }

  /**
   * Register a provider
   */
  register(name: string, providerClass: ProviderConstructor): void {
    this.providers.set(name.toLowerCase(), providerClass);
  }

  /**
   * Get a provider class by name
   */
  getProviderClass(name: string): ProviderConstructor | undefined {
    return this.providers.get(name.toLowerCase());
  }

  /**
   * Get or create a provider instance
   */
  getProvider(name: string): BaseProvider | undefined {
    const normalizedName = name.toLowerCase();
    
    // Check for existing instance
    if (this.instances.has(normalizedName)) {
      return this.instances.get(normalizedName);
    }

    // Create new instance
    const ProviderClass = this.providers.get(normalizedName);
    if (!ProviderClass) {
      this.logger.warn(`Provider not found: ${name}`);
      return undefined;
    }

    const instance = new ProviderClass();
    this.instances.set(normalizedName, instance);
    return instance;
  }

  /**
   * Check if a provider is registered
   */
  hasProvider(name: string): boolean {
    return this.providers.has(name.toLowerCase());
  }

  /**
   * Get list of supported provider names
   */
  getSupportedProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Get metadata for all supported providers
   */
  getProviderMetadata(): ProviderMetadata[] {
    return [
      {
        id: 'openai',
        displayName: 'OpenAI',
        defaultApiBase: 'https://api.openai.com/v1',
        requiresApiKey: true,
        defaultModels: [
          { id: 'gpt-4o', name: 'GPT-4o', contextLength: 128000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
          { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextLength: 128000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
          { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', contextLength: 128000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
          { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo', contextLength: 16385, capabilities: { imageInput: false, toolCalling: true, streaming: true } },
          { id: 'o1', name: 'o1', contextLength: 200000, capabilities: { imageInput: true, toolCalling: false, streaming: true } },
          { id: 'o1-mini', name: 'o1 Mini', contextLength: 128000, capabilities: { imageInput: false, toolCalling: false, streaming: true } },
        ],
      },
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        defaultApiBase: 'https://api.anthropic.com',
        requiresApiKey: true,
        defaultModels: [
          { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextLength: 200000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
          { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextLength: 200000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
          { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus', contextLength: 200000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
        ],
      },
      {
        id: 'google',
        displayName: 'Google (Gemini)',
        defaultApiBase: 'https://generativelanguage.googleapis.com',
        requiresApiKey: true,
        defaultModels: [
          { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash', contextLength: 1000000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
          { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', contextLength: 2000000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
          { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', contextLength: 1000000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
        ],
      },
      {
        id: 'ollama',
        displayName: 'Ollama (Local)',
        defaultApiBase: 'http://localhost:11434',
        requiresApiKey: false,
        defaultModels: [
          { id: 'llama3.2', name: 'Llama 3.2', contextLength: 128000, capabilities: { imageInput: false, toolCalling: false, streaming: true } },
          { id: 'mistral', name: 'Mistral', contextLength: 32000, capabilities: { imageInput: false, toolCalling: false, streaming: true } },
          { id: 'codellama', name: 'Code Llama', contextLength: 16000, capabilities: { imageInput: false, toolCalling: false, streaming: true } },
          { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder', contextLength: 32000, capabilities: { imageInput: false, toolCalling: false, streaming: true } },
        ],
      },
      {
        id: 'mistral',
        displayName: 'Mistral AI',
        defaultApiBase: 'https://api.mistral.ai/v1',
        requiresApiKey: true,
        defaultModels: [
          { id: 'mistral-large-latest', name: 'Mistral Large', contextLength: 128000, capabilities: { imageInput: false, toolCalling: true, streaming: true } },
          { id: 'mistral-small-latest', name: 'Mistral Small', contextLength: 32000, capabilities: { imageInput: false, toolCalling: true, streaming: true } },
          { id: 'codestral-latest', name: 'Codestral', contextLength: 32000, capabilities: { imageInput: false, toolCalling: false, streaming: true } },
        ],
      },
      {
        id: 'azure',
        displayName: 'Azure OpenAI',
        defaultApiBase: '',
        requiresApiKey: true,
        defaultModels: [], // Azure uses deployment names, not standard model names
      },
      {
        id: 'openrouter',
        displayName: 'OpenRouter',
        defaultApiBase: 'https://openrouter.ai/api/v1',
        requiresApiKey: true,
        defaultModels: [
          { id: 'openai/gpt-4o', name: 'GPT-4o (via OpenRouter)', contextLength: 128000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
          { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (via OpenRouter)', contextLength: 200000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
          { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5 (via OpenRouter)', contextLength: 1000000, capabilities: { imageInput: true, toolCalling: true, streaming: true } },
          { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B (via OpenRouter)', contextLength: 128000, capabilities: { imageInput: false, toolCalling: true, streaming: true } },
          { id: 'mistralai/mistral-large', name: 'Mistral Large (via OpenRouter)', contextLength: 128000, capabilities: { imageInput: false, toolCalling: true, streaming: true } },
        ],
      },
    ];
  }

  /**
   * Clear all cached provider instances
   */
  clearInstances(): void {
    this.instances.clear();
  }
}
