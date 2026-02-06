import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from '../utils/logger';
import { getNative } from '../utils/nativeLoader';

// Import native KeychainSecretStore
let KeychainSecretStore: any = null;
try {
  const native = getNative();
  KeychainSecretStore = native.KeychainSecretStore;
} catch (e) {
  // Native module not available
}

/**
 * Primary store type for API keys
 */
export type PrimaryStoreType = 'vscode' | 'keychain';

/**
 * Secret storage settings
 */
export interface SecretSettings {
  /** Primary storage location */
  primaryStore: PrimaryStoreType;
  /** Check environment variables as fallback */
  checkEnvironment: boolean;
  /** Check .env files as fallback */
  checkDotEnv: boolean;
}

/**
 * API key source information
 */
export interface ApiKeySource {
  /** Whether an API key is available */
  available: boolean;
  /** Where the key came from */
  source: 'secretStorage' | 'keychain' | 'environment' | 'dotenv' | 'none';
  /** Environment variable name if from environment */
  envVarName?: string;
}

/**
 * Resolves API keys from multiple sources based on settings
 * 
 * Resolution order (configurable):
 * 1. Primary store (VS Code SecretStorage or System Keychain)
 * 2. Environment variables (if enabled)
 * 3. .env files (if enabled)
 */
export class SecretResolver {
  private envVars: Map<string, string> = new Map();
  private dotEnvVars: Map<string, string> = new Map();
  private logger = getLogger();
  private secretStorage?: vscode.SecretStorage;
  private keychainStore?: any;
  private dotEnvLoaded = false;

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
    this.initKeychainStore();
  }

  /**
   * Initialize the keychain store if available
   */
  private initKeychainStore(): void {
    if (KeychainSecretStore) {
      try {
        this.keychainStore = new KeychainSecretStore();
        this.logger.debug('KeychainSecretStore initialized');
      } catch (e) {
        this.logger.warn('Failed to initialize KeychainSecretStore:', e);
      }
    }
  }

  /**
   * Get current secret storage settings from VS Code configuration
   */
  getSettings(): SecretSettings {
    const config = vscode.workspace.getConfiguration('openLLM.secrets');
    return {
      primaryStore: config.get<PrimaryStoreType>('primaryStore', 'vscode'),
      checkEnvironment: config.get<boolean>('checkEnvironment', true),
      checkDotEnv: config.get<boolean>('checkDotEnv', false),
    };
  }

  /**
   * Check if keychain is available on this system
   */
  isKeychainAvailable(): boolean {
    return this.keychainStore?.isAvailable() ?? false;
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
   * Load variables from a .env file into dotEnvVars
   */
  loadEnvFile(filePath: string): void {
    if (!fs.existsSync(filePath)) {
      return;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      this.parseEnvContent(content, this.dotEnvVars);
      this.logger.info(`Loaded env file: ${filePath}`);
    } catch (error) {
      this.logger.error(`Failed to load env file: ${filePath}`, error);
    }
  }

  /**
   * Parse .env file content into a target map
   */
  private parseEnvContent(content: string, target: Map<string, string>): void {
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
        
        target.set(key, value);
      }
    }
  }

  /**
   * Load env files from standard locations (if setting enabled)
   */
  loadStandardEnvFiles(workspacePath?: string): void {
    const settings = this.getSettings();
    if (!settings.checkDotEnv) {
      return;
    }

    const locations = [
      path.join(os.homedir(), '.config', 'openllm', '.env'),
    ];

    if (workspacePath) {
      locations.push(
        path.join(workspacePath, '.config', 'openllm', '.env'),
        path.join(workspacePath, '.env') // Also check root .env for convenience
      );
    }

    for (const location of locations) {
      this.loadEnvFile(location);
    }
    this.dotEnvLoaded = true;
  }

  /**
   * Ensure .env files are loaded if setting is enabled
   */
  private ensureDotEnvLoaded(): void {
    const settings = this.getSettings();
    if (settings.checkDotEnv && !this.dotEnvLoaded) {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const workspacePath = workspaceFolders?.[0]?.uri.fsPath;
      this.loadStandardEnvFiles(workspacePath);
    }
  }

  /**
   * Get API key for a provider
   * 
   * Resolution order (based on settings):
   * 1. Primary store (VS Code SecretStorage or System Keychain)
   * 2. Environment variables (if enabled)
   * 3. .env files (if enabled)
   */
  async getApiKey(providerId: string): Promise<string | undefined> {
    const normalizedId = providerId.toLowerCase();
    const settings = this.getSettings();

    // 1. Check primary store
    if (settings.primaryStore === 'vscode' && this.secretStorage) {
      const storageKey = `openllm.${normalizedId}.apiKey`;
      const secretValue = await this.secretStorage.get(storageKey);
      if (secretValue) {
        this.logger.debug(`API key for ${providerId} found in VS Code SecretStorage`);
        return secretValue;
      }
    } else if (settings.primaryStore === 'keychain' && this.keychainStore) {
      try {
        const value = await this.keychainStore.get(normalizedId);
        if (value) {
          this.logger.debug(`API key for ${providerId} found in system keychain`);
          return value;
        }
      } catch (e) {
        this.logger.warn(`Failed to get key from keychain for ${providerId}:`, e);
      }
    }

    // 2. Check environment variables (if enabled)
    if (settings.checkEnvironment) {
      const envVarNames = SecretResolver.ENV_VAR_NAMES[normalizedId] || [];
      for (const envVarName of envVarNames) {
        const value = this.envVars.get(envVarName);
        if (value) {
          this.logger.debug(`API key for ${providerId} found in env var ${envVarName}`);
          return value;
        }
      }
    }

    // 3. Check .env files (if enabled)
    if (settings.checkDotEnv) {
      this.ensureDotEnvLoaded();
      const envVarNames = SecretResolver.ENV_VAR_NAMES[normalizedId] || [];
      for (const envVarName of envVarNames) {
        const value = this.dotEnvVars.get(envVarName);
        if (value) {
          this.logger.debug(`API key for ${providerId} found in .env file (${envVarName})`);
          return value;
        }
      }
    }

    return undefined;
  }

  /**
   * Get information about where an API key comes from
   */
  async getApiKeySource(providerId: string): Promise<ApiKeySource> {
    const normalizedId = providerId.toLowerCase();
    const settings = this.getSettings();

    // 1. Check primary store
    if (settings.primaryStore === 'vscode' && this.secretStorage) {
      const storageKey = `openllm.${normalizedId}.apiKey`;
      const secretValue = await this.secretStorage.get(storageKey);
      if (secretValue) {
        return { available: true, source: 'secretStorage' };
      }
    } else if (settings.primaryStore === 'keychain' && this.keychainStore) {
      try {
        const value = await this.keychainStore.get(normalizedId);
        if (value) {
          return { available: true, source: 'keychain' };
        }
      } catch (e) {
        // Keychain access failed
      }
    }

    // 2. Check environment variables (if enabled)
    if (settings.checkEnvironment) {
      const envVarNames = SecretResolver.ENV_VAR_NAMES[normalizedId] || [];
      for (const envVarName of envVarNames) {
        const value = this.envVars.get(envVarName);
        if (value) {
          return { available: true, source: 'environment', envVarName };
        }
      }
    }

    // 3. Check .env files (if enabled)
    if (settings.checkDotEnv) {
      this.ensureDotEnvLoaded();
      const envVarNames = SecretResolver.ENV_VAR_NAMES[normalizedId] || [];
      for (const envVarName of envVarNames) {
        const value = this.dotEnvVars.get(envVarName);
        if (value) {
          return { available: true, source: 'dotenv', envVarName };
        }
      }
    }

    return { available: false, source: 'none' };
  }

  /**
   * Store an API key in the primary store
   */
  async storeApiKey(providerId: string, apiKey: string): Promise<void> {
    const normalizedId = providerId.toLowerCase();
    const settings = this.getSettings();

    if (settings.primaryStore === 'vscode') {
      if (!this.secretStorage) {
        throw new Error('VS Code SecretStorage not configured');
      }
      const storageKey = `openllm.${normalizedId}.apiKey`;
      await this.secretStorage.store(storageKey, apiKey);
      this.logger.info(`Stored API key for ${providerId} in VS Code SecretStorage`);
    } else if (settings.primaryStore === 'keychain') {
      if (!this.keychainStore) {
        throw new Error('System keychain not available');
      }
      await this.keychainStore.store(normalizedId, apiKey);
      this.logger.info(`Stored API key for ${providerId} in system keychain`);
    }
  }

  /**
   * Delete an API key from the primary store
   */
  async deleteApiKey(providerId: string): Promise<void> {
    const normalizedId = providerId.toLowerCase();
    const settings = this.getSettings();

    if (settings.primaryStore === 'vscode') {
      if (!this.secretStorage) {
        throw new Error('VS Code SecretStorage not configured');
      }
      const storageKey = `openllm.${normalizedId}.apiKey`;
      await this.secretStorage.delete(storageKey);
      this.logger.info(`Deleted API key for ${providerId} from VS Code SecretStorage`);
    } else if (settings.primaryStore === 'keychain') {
      if (!this.keychainStore) {
        throw new Error('System keychain not available');
      }
      await this.keychainStore.delete(normalizedId);
      this.logger.info(`Deleted API key for ${providerId} from system keychain`);
    }
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
    this.dotEnvVars.clear();
    this.dotEnvLoaded = false;
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
