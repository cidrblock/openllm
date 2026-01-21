import * as vscode from 'vscode';
import { SecretResolver } from './SecretResolver';
import { ContinueConfigReader } from './ContinueConfigReader';
import { ModelConfig, ProviderConfig } from '../types';
import { getLogger } from '../utils/logger';

/**
 * Manages configuration from multiple sources
 */
export class ConfigManager {
  private context: vscode.ExtensionContext;
  private secretResolver: SecretResolver;
  private continueReader: ContinueConfigReader;
  private models: Map<string, ModelConfig> = new Map();
  private disposables: vscode.Disposable[] = [];
  private logger = getLogger();
  private onDidChangeEmitter = new vscode.EventEmitter<void>();

  /** Event fired when configuration changes */
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.secretResolver = new SecretResolver();
    this.continueReader = new ContinueConfigReader(this.secretResolver);
  }

  /**
   * Initialize the configuration manager
   */
  async initialize(): Promise<void> {
    // Load secrets from standard locations
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.secretResolver.loadStandardEnvFiles(workspacePath);

    // Load configurations
    await this.loadConfigurations();

    // Setup watchers
    this.setupWatchers();

    this.logger.info(`ConfigManager initialized with ${this.models.size} models`);
  }

  /**
   * Load configurations from all sources
   */
  private async loadConfigurations(): Promise<void> {
    this.models.clear();

    // Load from VS Code settings
    await this.loadFromVSCodeSettings();

    // Load from Continue config if enabled
    const config = vscode.workspace.getConfiguration('openLLM');
    if (config.get<boolean>('importContinueConfig', true)) {
      await this.loadFromContinueConfig();
    }
  }

  /**
   * Load models from VS Code settings
   */
  private async loadFromVSCodeSettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration('openLLM');
    const providers = config.get<ProviderConfig[]>('providers', []);

    for (const provider of providers) {
      const resolvedApiKey = this.secretResolver.resolve(provider.apiKey);
      const resolvedApiBase = provider.apiBase 
        ? this.secretResolver.resolve(provider.apiBase) 
        : undefined;

      for (const modelName of provider.models) {
        const modelId = `settings-${provider.name}-${modelName.replace(/[^a-zA-Z0-9-]/g, '-')}`;
        
        // Skip if no API key (except Ollama)
        if (!resolvedApiKey && provider.name.toLowerCase() !== 'ollama') {
          this.logger.warn(`Skipping ${provider.name}/${modelName} - no API key`);
          continue;
        }

        this.models.set(modelId, {
          id: modelId,
          name: `${provider.name}/${modelName}`,
          provider: provider.name,
          model: modelName,
          apiKey: resolvedApiKey,
          apiBase: resolvedApiBase,
          roles: ['chat'],
          contextLength: this.getDefaultContextLength(provider.name, modelName),
          capabilities: {
            imageInput: this.supportsImages(provider.name),
            toolCalling: this.supportsTools(provider.name),
            streaming: true,
          },
        });
      }
    }

    this.logger.debug(`Loaded ${providers.length} providers from VS Code settings`);
  }

  /**
   * Load models from Continue configuration
   */
  private async loadFromContinueConfig(): Promise<void> {
    if (!this.continueReader.exists()) {
      this.logger.debug('No Continue config found');
      return;
    }

    const continueModels = await this.continueReader.getModels();

    for (const model of continueModels) {
      // Only add if not already present (settings take precedence)
      if (!this.models.has(model.id)) {
        this.models.set(model.id, model);
      }
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

    // Watch VS Code settings
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('openLLM')) {
          this.reload();
        }
      })
    );

    // Watch Continue config file
    const continueConfigPath = this.continueReader.getConfigPath();
    if (continueConfigPath) {
      const watcher = vscode.workspace.createFileSystemWatcher(continueConfigPath);
      watcher.onDidChange(() => this.reload());
      watcher.onDidCreate(() => this.reload());
      watcher.onDidDelete(() => this.reload());
      this.disposables.push(watcher);
    }

    // Watch .env files in workspace
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspacePath) {
      const envPattern = new vscode.RelativePattern(workspacePath, '**/.env');
      const envWatcher = vscode.workspace.createFileSystemWatcher(envPattern);
      envWatcher.onDidChange(() => this.reload());
      envWatcher.onDidCreate(() => this.reload());
      this.disposables.push(envWatcher);
    }
  }

  /**
   * Reload all configurations
   */
  async reload(): Promise<void> {
    this.logger.info('Reloading configuration...');
    
    // Reload secrets
    this.secretResolver.clear();
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this.secretResolver.loadStandardEnvFiles(workspacePath);

    // Reload configs
    await this.loadConfigurations();

    // Notify listeners
    this.onDidChangeEmitter.fire();

    this.logger.info(`Configuration reloaded with ${this.models.size} models`);
  }

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
   * Store an API key securely
   */
  async storeApiKey(provider: string, apiKey: string): Promise<void> {
    const key = `openllm-${provider}-apikey`;
    await this.context.secrets.store(key, apiKey);
    this.secretResolver.set(`${provider.toUpperCase()}_API_KEY`, apiKey);
    this.logger.info(`Stored API key for ${provider}`);
  }

  /**
   * Get a stored API key
   */
  async getStoredApiKey(provider: string): Promise<string | undefined> {
    const key = `openllm-${provider}-apikey`;
    return await this.context.secrets.get(key);
  }

  /**
   * Delete a stored API key
   */
  async deleteApiKey(provider: string): Promise<void> {
    const key = `openllm-${provider}-apikey`;
    await this.context.secrets.delete(key);
    this.logger.info(`Deleted API key for ${provider}`);
  }

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

    // Check for partial matches
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
    return ['openai', 'anthropic', 'google', 'gemini'].includes(provider.toLowerCase());
  }

  /**
   * Check if provider supports tool calling
   */
  private supportsTools(provider: string): boolean {
    return ['openai', 'anthropic', 'google', 'gemini'].includes(provider.toLowerCase());
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.disposables.forEach(d => d.dispose());
    this.onDidChangeEmitter.dispose();
  }
}
