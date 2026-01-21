import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SecretResolver } from './SecretResolver';
import { ModelConfig } from '../types';
import { getLogger } from '../utils/logger';

// We'll use dynamic import for js-yaml since it's a CommonJS module
let yaml: typeof import('js-yaml') | undefined;

interface ContinueModel {
  provider?: string;
  model?: string;
  apiKey?: string;
  apiBase?: string;
  uses?: string;
  with?: Record<string, string>;
  roles?: string[];
  name?: string;
  title?: string;
}

interface ContinueConfig {
  models?: ContinueModel[];
  tabAutocompleteModel?: ContinueModel;
  embeddingsProvider?: ContinueModel;
  reranker?: ContinueModel;
}

/**
 * Reads and parses Continue configuration files
 */
export class ContinueConfigReader {
  private configPath: string | undefined;
  private secretResolver: SecretResolver;
  private logger = getLogger();

  constructor(secretResolver: SecretResolver) {
    this.secretResolver = secretResolver;
    this.configPath = this.findConfigPath();
  }

  /**
   * Find the Continue config file path
   */
  private findConfigPath(): string | undefined {
    const continueDir = path.join(os.homedir(), '.continue');
    
    // Try config.yaml first, then config.json
    const yamlPath = path.join(continueDir, 'config.yaml');
    if (fs.existsSync(yamlPath)) {
      return yamlPath;
    }

    const jsonPath = path.join(continueDir, 'config.json');
    if (fs.existsSync(jsonPath)) {
      return jsonPath;
    }

    return undefined;
  }

  /**
   * Check if Continue config exists
   */
  exists(): boolean {
    return this.configPath !== undefined;
  }

  /**
   * Get the config file path
   */
  getConfigPath(): string | undefined {
    return this.configPath;
  }

  /**
   * Read and parse the Continue config
   */
  async readConfig(): Promise<ContinueConfig | null> {
    if (!this.configPath) {
      return null;
    }

    try {
      const content = fs.readFileSync(this.configPath, 'utf-8');
      
      if (this.configPath.endsWith('.yaml') || this.configPath.endsWith('.yml')) {
        // Dynamically import js-yaml
        if (!yaml) {
          yaml = await import('js-yaml');
        }
        return yaml.load(content) as ContinueConfig;
      } else {
        return JSON.parse(content);
      }
    } catch (error) {
      this.logger.error('Error reading Continue config:', error);
      return null;
    }
  }

  /**
   * Extract provider and model from "uses" syntax
   * e.g., "anthropic/claude-3-5-sonnet-20241022" -> { provider: "anthropic", model: "claude-3-5-sonnet-20241022" }
   */
  private parseUses(uses: string): { provider: string; model: string } {
    const parts = uses.split('/');
    return {
      provider: parts[0],
      model: parts.slice(1).join('/'),
    };
  }

  /**
   * Extract API key from model config
   */
  private extractApiKey(model: ContinueModel): string | undefined {
    // Direct apiKey
    if (model.apiKey) {
      return this.secretResolver.resolve(model.apiKey);
    }

    // Check "with" clause for API key
    if (model.with) {
      for (const [key, value] of Object.entries(model.with)) {
        const keyLower = key.toLowerCase();
        if (keyLower.includes('api_key') || keyLower.includes('apikey')) {
          return this.secretResolver.resolve(value);
        }
      }
    }

    // Try to get from environment based on provider
    const provider = model.provider || (model.uses ? this.parseUses(model.uses).provider : undefined);
    if (provider) {
      const envKeyNames = this.getProviderEnvKeyNames(provider);
      for (const envKey of envKeyNames) {
        const value = this.secretResolver.get(envKey);
        if (value) {
          return value;
        }
      }
    }

    return undefined;
  }

  /**
   * Get environment variable names for a provider's API key
   */
  private getProviderEnvKeyNames(provider: string): string[] {
    const providerLower = provider.toLowerCase();
    const names: string[] = [];

    switch (providerLower) {
      case 'openai':
        names.push('OPENAI_API_KEY');
        break;
      case 'anthropic':
        names.push('ANTHROPIC_API_KEY');
        break;
      case 'google':
      case 'gemini':
        names.push('GOOGLE_API_KEY', 'GEMINI_API_KEY');
        break;
      case 'mistral':
        names.push('MISTRAL_API_KEY');
        break;
      case 'azure':
        names.push('AZURE_OPENAI_API_KEY', 'AZURE_API_KEY');
        break;
      case 'ollama':
        // Ollama typically doesn't need an API key
        break;
      default:
        names.push(`${provider.toUpperCase()}_API_KEY`);
    }

    return names;
  }

  /**
   * Get default context length for a model
   */
  private getContextLength(provider: string, model: string): number {
    const key = `${provider.toLowerCase()}-${model.toLowerCase()}`;
    
    const contextLengths: Record<string, number> = {
      // OpenAI
      'openai-gpt-4': 128000,
      'openai-gpt-4o': 128000,
      'openai-gpt-4o-mini': 128000,
      'openai-gpt-4-turbo': 128000,
      'openai-gpt-3.5-turbo': 16385,
      'openai-o1': 200000,
      'openai-o1-mini': 128000,
      
      // Anthropic
      'anthropic-claude-3-5-sonnet': 200000,
      'anthropic-claude-3-5-haiku': 200000,
      'anthropic-claude-3-opus': 200000,
      'anthropic-claude-3-sonnet': 200000,
      'anthropic-claude-3-haiku': 200000,
      
      // Google
      'google-gemini-2.0-flash': 1000000,
      'google-gemini-1.5-pro': 2000000,
      'google-gemini-1.5-flash': 1000000,
      'gemini-gemini-2.0-flash': 1000000,
      'gemini-gemini-1.5-pro': 2000000,
      
      // Mistral
      'mistral-mistral-large': 128000,
      'mistral-mistral-small': 32000,
      'mistral-codestral': 32000,
    };

    // Check for exact match
    if (contextLengths[key]) {
      return contextLengths[key];
    }

    // Check for partial match
    for (const [pattern, length] of Object.entries(contextLengths)) {
      if (key.includes(pattern.split('-').slice(1).join('-'))) {
        return length;
      }
    }

    // Default context length
    return 8192;
  }

  /**
   * Check if provider supports images
   */
  private supportsImages(provider: string): boolean {
    return ['openai', 'anthropic', 'google', 'gemini'].includes(provider.toLowerCase());
  }

  /**
   * Check if provider supports tools
   */
  private supportsTools(provider: string): boolean {
    return ['openai', 'anthropic', 'google', 'gemini'].includes(provider.toLowerCase());
  }

  /**
   * Convert a Continue model config to our ModelConfig format
   */
  private convertModel(model: ContinueModel, index: number): ModelConfig | null {
    let provider = model.provider || '';
    let modelName = model.model || '';

    // Handle "uses" syntax
    if (model.uses) {
      const parsed = this.parseUses(model.uses);
      provider = parsed.provider;
      modelName = parsed.model;
    }

    if (!provider || !modelName) {
      this.logger.warn('Skipping model with missing provider or model name:', model);
      return null;
    }

    const apiKey = this.extractApiKey(model);
    const apiBase = model.apiBase ? this.secretResolver.resolve(model.apiBase) : undefined;

    // Skip models without API keys (except Ollama)
    if (!apiKey && provider.toLowerCase() !== 'ollama') {
      this.logger.debug(`Skipping model ${provider}/${modelName} - no API key found`);
      return null;
    }

    const id = `continue-${provider}-${modelName.replace(/[^a-zA-Z0-9-]/g, '-')}-${index}`;
    const displayName = model.title || model.name || `${provider}/${modelName}`;

    return {
      id,
      name: displayName,
      provider,
      model: modelName,
      apiKey,
      apiBase,
      roles: model.roles || ['chat'],
      contextLength: this.getContextLength(provider, modelName),
      capabilities: {
        imageInput: this.supportsImages(provider),
        toolCalling: this.supportsTools(provider),
        streaming: true,
      },
    };
  }

  /**
   * Get all models from Continue config with resolved secrets
   */
  async getModels(): Promise<ModelConfig[]> {
    const config = await this.readConfig();
    if (!config || !config.models) {
      return [];
    }

    const models: ModelConfig[] = [];

    for (let i = 0; i < config.models.length; i++) {
      const model = this.convertModel(config.models[i], i);
      if (model) {
        models.push(model);
      }
    }

    this.logger.info(`Loaded ${models.length} models from Continue config`);
    return models;
  }
}
