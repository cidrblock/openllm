import { createNativeProvider, NativeProviderAdapter } from '../adapters';
import { ProviderMetadata } from '../types';
import { getLogger } from '../utils/logger';
import { getNative } from '../utils/nativeLoader';

// Supported provider names
const SUPPORTED_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'gemini',
  'ollama',
  'mistral',
  'azure',
  'azure-openai',
  'openrouter',
];

/**
 * Registry of available LLM providers
 * Uses native (Rust) providers for high performance
 */
export class ProviderRegistry {
  private instances: Map<string, NativeProviderAdapter> = new Map();
  private logger = getLogger();

  constructor() {
    this.logger.info('OpenLLM: Using native (Rust) providers');
  }

  /**
   * Get or create a provider instance
   */
  getProvider(name: string): NativeProviderAdapter | undefined {
    const normalizedName = name.toLowerCase();
    
    // Check for existing instance
    if (this.instances.has(normalizedName)) {
      return this.instances.get(normalizedName);
    }

    // Create native provider
    const nativeProvider = createNativeProvider(normalizedName);
    if (nativeProvider) {
      this.instances.set(normalizedName, nativeProvider);
      this.logger.debug(`Created provider: ${normalizedName}`);
      return nativeProvider;
    }

    this.logger.warn(`Provider not found: ${name}`);
    return undefined;
  }

  /**
   * Check if a provider is supported
   */
  hasProvider(name: string): boolean {
    return SUPPORTED_PROVIDERS.includes(name.toLowerCase());
  }

  /**
   * Get list of supported provider names
   */
  getSupportedProviders(): string[] {
    return [...SUPPORTED_PROVIDERS];
  }

  /**
   * Get metadata for all supported providers from native module
   */
  getProviderMetadata(): ProviderMetadata[] {
    try {
      const native = getNative();
      const providers = native.listProviders();
      
      return providers.map((p: any) => ({
        id: p.id,
        displayName: p.displayName,
        defaultApiBase: p.defaultApiBase,
        requiresApiKey: p.requiresApiKey,
        defaultModels: p.defaultModels.map((m: any) => ({
          id: m.id,
          name: m.name,
          contextLength: m.contextLength,
          capabilities: {
            imageInput: m.capabilities.imageInput,
            toolCalling: m.capabilities.toolCalling,
            streaming: m.capabilities.streaming,
          },
        })),
      }));
    } catch (e) {
      this.logger.error('Failed to get provider metadata from native module', e);
      return [];
    }
  }

  /**
   * Clear all cached provider instances
   */
  clearInstances(): void {
    this.instances.clear();
  }
}
