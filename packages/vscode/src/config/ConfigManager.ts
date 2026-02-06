import * as vscode from 'vscode';
import { ModelConfig } from '../types';
import { getLogger } from '../utils/logger';
import { getNative } from '../utils/nativeLoader';

/**
 * Manages configuration using openllm-core's unified resolvers.
 * 
 * This is a thin wrapper that delegates all config and secret operations
 * to openllm-core via NAPI. The openllm-core resolvers will in turn call
 * back to the VS Code RPC server when they need VS Code-specific data.
 * 
 * Resolution priority (handled by openllm-core):
 * - Secrets: Environment → VS Code (RPC) → System Keychain → .env files
 * - Config: Native YAML user → VS Code user (RPC) → Native YAML workspace → VS Code workspace (RPC)
 */
export class ConfigManager {
  private context: vscode.ExtensionContext;
  private models: Map<string, ModelConfig> = new Map();
  private disposables: vscode.Disposable[] = [];
  private logger = getLogger();
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  
  // NAPI bindings - loaded lazily
  private native: any = null;
  private secretResolver: any = null;
  private configResolver: any = null;

  /** Event fired when configuration changes */
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }
  
  /**
   * Initialize the configuration manager.
   * Must be called AFTER the RPC server is started and registered.
   */
  async initialize(): Promise<void> {
    // Load native bindings
    try {
      this.native = getNative();
      
      // Get user preferences from VS Code settings
      const config = vscode.workspace.getConfiguration('openLLM');
      const configSource = config.get<string>('config.source', 'vscode');
      const secretsStore = config.get<string>('secrets.primaryStore', 'vscode');
      const checkEnvironment = config.get<boolean>('secrets.checkEnvironment', true);
      const checkDotEnv = config.get<boolean>('secrets.checkDotEnv', false);
      
      // Create unified resolvers
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      
      if (this.native.UnifiedSecretResolver) {
        this.secretResolver = new this.native.UnifiedSecretResolver();
        // Set preferences BEFORE any operations
        this.secretResolver.setSecretsStore(secretsStore);
        this.secretResolver.setCheckEnvironment(checkEnvironment);
        this.secretResolver.setCheckDotenv(checkDotEnv);
        this.logger.debug(`UnifiedSecretResolver initialized with store=${secretsStore}`);
      }
      
      if (this.native.UnifiedConfigResolver) {
        this.configResolver = workspacePath 
          ? this.native.UnifiedConfigResolver.withWorkspace(workspacePath)
          : new this.native.UnifiedConfigResolver();
        // Set preferences and load from correct sources (async to prevent event loop deadlock)
        await this.configResolver.setConfigSource(configSource);
        this.logger.debug(`UnifiedConfigResolver initialized with source=${configSource}`);
      }
    } catch (e) {
      this.logger.error('Failed to initialize NAPI bindings:', e);
      throw new Error('openllm-core native bindings not available');
    }

    // Load configurations
    await this.loadConfigurations();

    // Setup watchers
    this.setupWatchers();

    this.logger.info(`ConfigManager initialized with ${this.models.size} models`);
  }

  /**
   * Load configurations from openllm-core's unified resolvers
   */
  private async loadConfigurations(): Promise<void> {
    this.models.clear();

    if (!this.configResolver) {
      this.logger.warn('Config resolver not available');
      return;
    }

    try {
      // Get all providers from unified resolver (merges all sources) - async
      const providers = await this.configResolver.getAllProviders();
      
      this.logger.debug(`Loading ${providers.length} providers from unified resolver`);

      for (const provider of providers) {
        if (provider.enabled === false) {
          this.logger.debug(`Provider ${provider.name} is disabled, skipping`);
          continue;
        }

        // Get API key from unified secret resolver
        const apiKey = await this.getApiKey(provider.name);
        const keySource = this.getApiKeySource(provider.name);
        this.logger.debug(`Provider ${provider.name}: API key ${apiKey ? 'found' : 'NOT found'} (source: ${keySource?.name || 'none'})`);

        const apiBase = provider.apiBase;

        if (!provider.models || provider.models.length === 0) {
          this.logger.warn(`Provider ${provider.name} has no models configured`);
          continue;
        }

        for (const modelName of provider.models) {
          if (typeof modelName !== 'string') {
            this.logger.warn(`Skipping invalid model entry for ${provider.name}: ${JSON.stringify(modelName)}`);
            continue;
          }
          
          const modelId = `unified-${provider.name}-${modelName.replace(/[^a-zA-Z0-9-]/g, '-')}`;

          if (!apiKey && provider.name.toLowerCase() !== 'ollama') {
            this.logger.warn(`Skipping ${provider.name}/${modelName} - no API key`);
            continue;
          }

          this.models.set(modelId, {
            id: modelId,
            name: `${provider.name}/${modelName}`,
            provider: provider.name,
            model: modelName,
            apiKey: apiKey,
            apiBase: apiBase,
            roles: ['chat'],
            contextLength: this.getDefaultContextLength(provider.name, modelName),
            capabilities: {
              imageInput: this.supportsImages(provider.name),
              toolCalling: this.supportsTools(provider.name),
              streaming: true,
            },
          });

          this.logger.debug(`Registered model: ${modelId}`);
        }
      }

      this.logger.info(`Loaded ${this.models.size} models from unified config`);
    } catch (e) {
      this.logger.error('Failed to load configurations:', e);
    }
  }

  /**
   * Setup file and configuration watchers
   */
  private setupWatchers(): void {
    const config = vscode.workspace.getConfiguration('openLLM');
    if (!config.get<boolean>('autoReload', true)) {
      return;
    }

    // Watch VS Code settings changes
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('openLLM')) {
          this.reload();
        }
      })
    );

    // Watch .env files in workspace
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspacePath) {
      const envPattern = new vscode.RelativePattern(workspacePath, '**/.env');
      const envWatcher = vscode.workspace.createFileSystemWatcher(envPattern);
      envWatcher.onDidChange(() => this.reload());
      envWatcher.onDidCreate(() => this.reload());
      this.disposables.push(envWatcher);
      
      // Also watch native YAML config files
      const yamlPattern = new vscode.RelativePattern(workspacePath, '.config/openllm/config.yaml');
      const yamlWatcher = vscode.workspace.createFileSystemWatcher(yamlPattern);
      yamlWatcher.onDidChange(() => this.reload());
      yamlWatcher.onDidCreate(() => this.reload());
      this.disposables.push(yamlWatcher);
    }
  }

  /**
   * Reload all configurations
   */
  async reload(): Promise<void> {
    this.logger.info('Reloading configuration...');
    
    // Reload configs from unified resolver
    await this.loadConfigurations();

    // Notify listeners
    this.onDidChangeEmitter.fire();

    this.logger.info(`Configuration reloaded with ${this.models.size} models`);
  }

  // ========== Secret Operations (delegated to openllm-core) ==========

  /**
   * Get an API key for a provider (async)
   */
  async getApiKey(providerId: string): Promise<string | undefined> {
    if (!this.secretResolver) {
      this.logger.info(`[getApiKey] No secretResolver for ${providerId}`);
      return undefined;
    }
    
    this.logger.info(`[getApiKey] Calling resolve for ${providerId}, secretsStore=${this.secretResolver.getSecretsStore()}`);
    
    try {
      const result = await this.secretResolver.resolve(providerId);
      this.logger.info(`[getApiKey] resolve() returned: ${JSON.stringify(result)}`);
      if (result) {
        this.logger.info(`[getApiKey] Found key for ${providerId} from source=${result.source}`);
      } else {
        this.logger.info(`[getApiKey] No key found for ${providerId}`);
      }
      return result?.value;
    } catch (e) {
      this.logger.warn(`Failed to resolve API key for ${providerId}:`, e);
      return undefined;
    }
  }

  /**
   * Get source information for an API key
   */
  getApiKeySource(providerId: string): { name: string; available: boolean; detail: string } | null {
    if (!this.secretResolver) {
      return null;
    }
    
    try {
      return this.secretResolver.getSourceInfo(providerId);
    } catch (e) {
      return null;
    }
  }

  /**
   * Store an API key
   */
  async storeApiKey(providerId: string, apiKey: string, destination: string = 'vscode'): Promise<void> {
    if (!this.secretResolver) {
      throw new Error('Secret resolver not available');
    }
    
    this.secretResolver.store(providerId, apiKey, destination);
    this.logger.info(`Stored API key for ${providerId} to ${destination}`);
  }

  /**
   * Delete an API key
   */
  async deleteApiKey(providerId: string, destination: string = 'vscode'): Promise<void> {
    if (!this.secretResolver) {
      throw new Error('Secret resolver not available');
    }
    
    this.secretResolver.delete(providerId, destination);
    this.logger.info(`Deleted API key for ${providerId} from ${destination}`);
  }

  /**
   * Check if an API key is available
   */
  async hasApiKey(providerId: string): Promise<boolean> {
    const key = await this.getApiKey(providerId);
    return !!key;
  }

  /**
   * List all secret sources
   */
  listSecretSources(): Array<{ name: string; available: boolean; detail: string }> {
    if (!this.secretResolver) {
      return [];
    }
    
    try {
      return this.secretResolver.listSources();
    } catch (e) {
      return [];
    }
  }

  // ========== Config Operations (delegated to openllm-core) ==========

  /**
   * Get all configured providers (async)
   */
  async getProviders(): Promise<Array<{
    name: string;
    enabled: boolean;
    apiBase?: string;
    models: string[];
    source: string;
    sourceDetail: string;
  }>> {
    if (!this.configResolver) {
      return [];
    }
    
    try {
      return await this.configResolver.getAllProviders();
    } catch (e) {
      this.logger.warn('Failed to get providers:', e);
      return [];
    }
  }

  /**
   * Get a specific provider
   */
  getProvider(name: string): {
    name: string;
    enabled: boolean;
    apiBase?: string;
    models: string[];
    source: string;
    sourceDetail: string;
  } | null {
    if (!this.configResolver) {
      return null;
    }
    
    try {
      return this.configResolver.getProvider(name) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * List all config sources
   */
  listConfigSources(): Array<{ name: string; available: boolean; detail: string }> {
    if (!this.configResolver) {
      return [];
    }
    
    try {
      return this.configResolver.listSources();
    } catch (e) {
      return [];
    }
  }

  // ========== Model Access ==========

  /**
   * Get all configured models
   */
  getModels(): ModelConfig[] {
    return Array.from(this.models.values());
  }

  /**
   * Get a specific model by ID
   */
  getModel(id: string): ModelConfig | undefined {
    return this.models.get(id);
  }

  /**
   * Get models filtered by provider
   */
  getModelsByProvider(provider: string): ModelConfig[] {
    return this.getModels().filter(m => 
      m.provider.toLowerCase() === provider.toLowerCase()
    );
  }

  /**
   * Check if there are any valid configurations
   */
  hasValidConfiguration(): boolean {
    return this.models.size > 0;
  }

  /**
   * Get the number of configured models
   */
  getModelCount(): number {
    return this.models.size;
  }

  /**
   * Get the number of unique providers with models
   */
  getProviderCount(): number {
    const providers = new Set<string>();
    for (const model of this.models.values()) {
      providers.add(model.provider.toLowerCase());
    }
    return providers.size;
  }

  /**
   * Get list of configured provider names
   */
  getConfiguredProviders(): string[] {
    const providers = new Set<string>();
    for (const model of this.models.values()) {
      providers.add(model.provider);
    }
    return Array.from(providers);
  }

  // ========== Utility Methods ==========

  /**
   * Get default context length for a model
   */
  private getDefaultContextLength(provider: string, model: string): number {
    const contextLengths: Record<string, number> = {
      'gpt-4': 128000,
      'gpt-4o': 128000,
      'gpt-4o-mini': 128000,
      'gpt-4-turbo': 128000,
      'gpt-3.5-turbo': 16385,
      'claude-3-5-sonnet': 200000,
      'claude-3-5-haiku': 200000,
      'claude-3-opus': 200000,
      'claude-3-sonnet': 200000,
      'claude-3-haiku': 200000,
      'gemini-2.0-flash': 1000000,
      'gemini-1.5-pro': 2000000,
      'gemini-1.5-flash': 1000000,
    };

    for (const [pattern, length] of Object.entries(contextLengths)) {
      if (model.toLowerCase().includes(pattern.toLowerCase())) {
        return length;
      }
    }

    return 8192;
  }

  /**
   * Check if provider supports image input
   */
  private supportsImages(provider: string): boolean {
    return ['openai', 'anthropic', 'google', 'gemini', 'openrouter'].includes(provider.toLowerCase());
  }

  /**
   * Check if provider supports tool calling
   */
  private supportsTools(provider: string): boolean {
    return ['openai', 'anthropic', 'google', 'gemini', 'openrouter', 'mistral'].includes(provider.toLowerCase());
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.onDidChangeEmitter.dispose();
  }
}
