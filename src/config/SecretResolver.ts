import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from '../utils/logger';

/**
 * API key source information
 */
export interface ApiKeySource {
  /** Whether an API key is available */
  available: boolean;
  /** Where the key came from */
  source: 'secretStorage' | 'environment' | 'none';
  /** Environment variable name if from environment */
  envVarName?: string;
}

/**
 * Resolves API keys from SecretStorage and environment variables
 * 
 * Resolution order:
 * 1. VS Code SecretStorage (openllm.{provider}.apiKey)
 * 2. Environment variables ({PROVIDER}_API_KEY)
 */
export class SecretResolver {
  private envVars: Map<string, string> = new Map();
  private logger = getLogger();
  private secretStorage?: vscode.SecretStorage;

  /** Standard environment variable names for each provider */
  private static readonly ENV_VAR_NAMES: Record<string, string[]> = {
    'openai': ['OPENAI_API_KEY'],
    'anthropic': ['ANTHROPIC_API_KEY'],
    'gemini': ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    'google': ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    'mistral': ['MISTRAL_API_KEY'],
    'azure': ['AZURE_API_KEY', 'AZURE_OPENAI_API_KEY'],
    'openrouter': ['OPENROUTER_API_KEY'],
    'ollama': [], // Ollama doesn't need an API key
  };

  constructor() {
    this.loadEnvironmentVariables();
  }

  /**
   * Set the VS Code SecretStorage instance
   */
  setSecretStorage(storage: vscode.SecretStorage): void {
    this.secretStorage = storage;
    this.logger.debug('SecretStorage configured');
  }

  /**
   * Load environment variables from process.env
   */
  private loadEnvironmentVariables(): void {
    for (const [key, value] of Object.entries(process.env)) {
      if (value) {
        this.envVars.set(key, value);
      }
    }
  }

  /**
   * Load variables from a .env file
   */
  loadEnvFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.parseEnvContent(content);
      this.logger.info(`Loaded env file: ${filePath}`);
    } catch (error) {
      this.logger.error(`Failed to load env file: ${filePath}`, error);
    }
  }

  /**
   * Parse .env file content
   */
  private parseEnvContent(content: string): void {
    const lines = content.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        let value = match[2].trim();
        
        // Remove surrounding quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        
        this.envVars.set(key, value);
      }
    }
  }

  /**
   * Load env files from standard locations
   */
  loadStandardEnvFiles(workspacePath?: string): void {
    const locations = [
      path.join(os.homedir(), '.openllm', '.env'),
    ];

    if (workspacePath) {
      locations.push(
        path.join(workspacePath, '.openllm', '.env'),
        path.join(workspacePath, '.env')
      );
    }

    for (const location of locations) {
      this.loadEnvFile(location);
    }
  }

  /**
   * Get API key for a provider
   * 
   * Resolution order:
   * 1. VS Code SecretStorage (openllm.{provider}.apiKey)
   * 2. Environment variables ({PROVIDER}_API_KEY)
   */
  async getApiKey(providerId: string): Promise<string | undefined> {
    const normalizedId = providerId.toLowerCase();

    // 1. Check SecretStorage first
    if (this.secretStorage) {
      const storageKey = `openllm.${normalizedId}.apiKey`;
      const secretValue = await this.secretStorage.get(storageKey);
      if (secretValue) {
        this.logger.debug(`API key for ${providerId} found in SecretStorage`);
        return secretValue;
      }
    }

    // 2. Check environment variables
    const envVarNames = SecretResolver.ENV_VAR_NAMES[normalizedId] || [];
    for (const envVarName of envVarNames) {
      const value = this.envVars.get(envVarName);
      if (value) {
        this.logger.debug(`API key for ${providerId} found in env var ${envVarName}`);
        return value;
      }
    }

    return undefined;
  }

  /**
   * Get information about where an API key comes from
   */
  async getApiKeySource(providerId: string): Promise<ApiKeySource> {
    const normalizedId = providerId.toLowerCase();

    // 1. Check SecretStorage first
    if (this.secretStorage) {
      const storageKey = `openllm.${normalizedId}.apiKey`;
      const secretValue = await this.secretStorage.get(storageKey);
      if (secretValue) {
        return { available: true, source: 'secretStorage' };
      }
    }

    // 2. Check environment variables
    const envVarNames = SecretResolver.ENV_VAR_NAMES[normalizedId] || [];
    for (const envVarName of envVarNames) {
      const value = this.envVars.get(envVarName);
      if (value) {
        return { available: true, source: 'environment', envVarName };
      }
    }

    return { available: false, source: 'none' };
  }

  /**
   * Store an API key in SecretStorage
   */
  async storeApiKey(providerId: string, apiKey: string): Promise<void> {
    if (!this.secretStorage) {
      throw new Error('SecretStorage not configured');
    }
    
    const storageKey = `openllm.${providerId.toLowerCase()}.apiKey`;
    await this.secretStorage.store(storageKey, apiKey);
    this.logger.info(`Stored API key for ${providerId}`);
  }

  /**
   * Delete an API key from SecretStorage
   */
  async deleteApiKey(providerId: string): Promise<void> {
    if (!this.secretStorage) {
      throw new Error('SecretStorage not configured');
    }
    
    const storageKey = `openllm.${providerId.toLowerCase()}.apiKey`;
    await this.secretStorage.delete(storageKey);
    this.logger.info(`Deleted API key for ${providerId}`);
  }

  /**
   * Check if a provider has an API key available
   */
  async hasApiKey(providerId: string): Promise<boolean> {
    const source = await this.getApiKeySource(providerId);
    return source.available;
  }

  /**
   * Get custom base URL for a provider (stored in globalState, not secrets)
   */
  getBaseUrl(providerId: string, globalState: vscode.Memento): string | undefined {
    const key = `openllm.${providerId.toLowerCase()}.baseUrl`;
    return globalState.get<string>(key);
  }

  /**
   * Store custom base URL for a provider
   */
  async storeBaseUrl(providerId: string, baseUrl: string, globalState: vscode.Memento): Promise<void> {
    const key = `openllm.${providerId.toLowerCase()}.baseUrl`;
    await globalState.update(key, baseUrl);
    this.logger.info(`Stored base URL for ${providerId}: ${baseUrl}`);
  }

  /**
   * Clear cached environment variables and reload from process.env
   */
  clear(): void {
    this.envVars.clear();
    this.loadEnvironmentVariables();
  }

  /**
   * Get an environment variable by name
   */
  getEnvVar(name: string): string | undefined {
    return this.envVars.get(name);
  }

  /**
   * Alias for getEnvVar (backwards compatibility)
   */
  get(name: string): string | undefined {
    return this.getEnvVar(name);
  }

  // Legacy compatibility methods - kept for backwards compat but deprecated

  /**
   * @deprecated Use getApiKey instead
   */
  resolve(template: string | undefined): string | undefined {
    if (!template) {
      return undefined;
    }
    // Just return the template as-is - this is only for backwards compat
    return template;
  }

  /**
   * @deprecated Use getApiKey instead
   */
  async resolveAsync(template: string | undefined): Promise<string | undefined> {
    return this.resolve(template);
  }

  /**
   * @deprecated Use getApiKey instead
   */
  async getProviderApiKey(providerId: string): Promise<string | undefined> {
    return this.getApiKey(providerId);
  }
}
