import * as vscode from 'vscode';
import { getLogger } from '../utils/logger';
import { getNative } from '../utils/nativeLoader';

/**
 * Provider configuration definition
 */
interface ProviderDef {
  id: string;
  name: string;
  description: string;
  requiresApiKey: boolean;
  hasBaseUrl: boolean;
  defaultBaseUrl?: string;
  extraFields?: Array<{
    id: string;
    label: string;
    placeholder?: string;
    type?: 'text' | 'password';
  }>;
  testEndpoint?: string;
  models?: string[];
}

/**
 * Supported providers configuration (alphabetically sorted)
 * 
 * Note: Models are fetched dynamically from provider APIs when testing connection.
 * The 'models' array here is used as a fallback if the API doesn't return any.
 */
const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    description: '',
    requiresApiKey: true,
    hasBaseUrl: true,
    defaultBaseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022'] // Anthropic has no /models endpoint
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    description: '',
    requiresApiKey: true,
    hasBaseUrl: true,
    extraFields: [
      { id: 'deployment', label: 'Deployment Name', placeholder: 'e.g. my-gpt4-deployment' },
      { id: 'apiVersion', label: 'API Version', placeholder: 'e.g. 2024-02-15-preview' }
    ],
    models: [] // User must configure deployment
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: '',
    requiresApiKey: true,
    hasBaseUrl: false,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: [] // Fetched from API
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    description: '',
    requiresApiKey: true,
    hasBaseUrl: true,
    defaultBaseUrl: 'https://api.mistral.ai/v1',
    models: [] // Fetched from API
  },
  {
    id: 'ollama',
    name: 'Ollama',
    description: '',
    requiresApiKey: false,
    hasBaseUrl: true,
    defaultBaseUrl: 'http://localhost:11434',
    models: [] // Fetched from API
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: '',
    requiresApiKey: true,
    hasBaseUrl: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    models: [] // Fetched from API
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: '',
    requiresApiKey: true,
    hasBaseUrl: false,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    models: [] // Fetched from API
  },
  {
    id: 'rhoai',
    name: 'Red Hat OpenShift AI',
    description: '',
    requiresApiKey: true,
    hasBaseUrl: true,
    extraFields: [
      { id: 'model', label: 'Model Name', placeholder: 'e.g. granite-7b-instruct' }
    ],
    models: [] // User must configure model
  }
];

/**
 * Webview panel for managing API keys
 * 
 * Uses openllm-core's unified resolvers via NAPI for all secret and config operations.
 */
export class ApiKeyPanel {
  public static currentPanel: ApiKeyPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];
  private readonly _logger = getLogger();
  
  // NAPI unified resolvers
  private _native: any = null;
  private _secretResolver: any = null;
  private _configResolver: any = null;
  private _initPromise: Promise<void> = Promise.resolve();
  
  // Pending credentials - not yet persisted, waiting for user to save
  // These are stored temporarily between Configure (test) and Save (persist)
  private _pendingCredentials: Map<string, { apiKey?: string; baseUrl?: string }> = new Map();

  public static createOrShow(context: vscode.ExtensionContext): void {
    const logger = getLogger();
    logger.info('[ApiKeyPanel] createOrShow called');
    
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ApiKeyPanel.currentPanel) {
      logger.info('[ApiKeyPanel] Revealing existing panel');
      ApiKeyPanel.currentPanel._panel.reveal(column);
      // Refresh status for existing panel (async, fire-and-forget)
      ApiKeyPanel.currentPanel._sendStatus();
      return;
    }

    logger.info('[ApiKeyPanel] Creating new panel');
    const panel = vscode.window.createWebviewPanel(
      'openLLMApiKeys',
      'Open LLM: Providers and Models',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'out')
        ]
      }
    );

    ApiKeyPanel.currentPanel = new ApiKeyPanel(panel, context);
    logger.info('[ApiKeyPanel] Panel created');
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._logger.info('[ApiKeyPanel] Constructor started');
    this._panel = panel;
    this._extensionUri = context.extensionUri;
    this._context = context;
    
    // Note: _initResolvers is async but constructor can't await
    // We kick off initialization and let it complete asynchronously
    // The HTML initialization will await it properly
    this._initPromise = this._initResolvers();
    this._initPromise.then(() => {
      this._logger.info('[ApiKeyPanel] Resolvers initialized');
    });

    // Set up dispose handler
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Set up message handler for webview communication
    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'saveApiKey':
            await this._saveApiKey(message.providerId, message.apiKey, message.target);
            break;
          case 'saveBaseUrl':
            await this._saveBaseUrl(message.providerId, message.baseUrl, message.target);
            break;
          case 'saveExtraField':
            await this._saveExtraField(message.providerId, message.fieldId, message.value);
            break;
          case 'deleteApiKey':
            await this._deleteApiKey(message.providerId);
            break;
          case 'refreshProvider':
            await this._refreshProvider(message.providerId);
            break;
          case 'refreshAll':
            await this._refreshAll();
            break;
          case 'testConnection':
            await this._testConnection(message.providerId);
            break;
          case 'saveSelectedModels':
            await this._saveSelectedModels(message.providerId, message.models, message.target);
            break;
          case 'toggleEnabled':
            await this._toggleEnabled(message.providerId, message.enabled);
            break;
          case 'getStatus':
            await this._sendStatus();
            break;
          case 'runVSCodeCommand':
            if (message.arg !== undefined) {
              await vscode.commands.executeCommand(message.vsCodeCommand, message.arg);
            } else {
              await vscode.commands.executeCommand(message.vsCodeCommand);
            }
            break;
          case 'updateSetting':
            await this._updateSetting(message.key, message.value);
            break;
          case 'updateSettingScoped':
            await this._updateSettingScoped(message.key, message.scope, message.value);
            break;
          case 'importConfig':
            await this._importConfig(message.scope);
            break;
          case 'importSecrets':
            await this._importSecrets(message.scope);
            break;
          case 'showSavePicker':
            await this._showSavePicker(
              message.providerId, 
              message.apiKey, 
              message.baseUrl, 
              message.extraFields
            );
            break;
          case 'configureProvider':
            await this._configureProvider(
              message.providerId,
              message.apiKey,
              message.baseUrl,
              message.extraFields
            );
            break;
        }
      },
      null,
      this._disposables
    );

    // Listen for configuration changes to update resolver preferences
    vscode.workspace.onDidChangeConfiguration(
      async (e) => {
        if (e.affectsConfiguration('openLLM.config.source') ||
            e.affectsConfiguration('openLLM.secrets.primaryStore') ||
            e.affectsConfiguration('openLLM.secrets.checkEnvironment') ||
            e.affectsConfiguration('openLLM.secrets.checkDotEnv')) {
          const config = vscode.workspace.getConfiguration('openLLM');
          this._logger.info(`[onDidChangeConfiguration] Settings changed. config.source=${config.get('config.source')}, secrets.primaryStore=${config.get('secrets.primaryStore')}`);
          await this._updateResolverPreferences();
          this._sendStatus();
        }
      },
      null,
      this._disposables
    );

    // Initialize HTML asynchronously (includes embedded status data)
    this._initializeHtml();
    this._logger.info('[ApiKeyPanel] Constructor complete');
  }

  /**
   * Initialize the webview HTML with embedded status data.
   * Called once when panel is created.
   */
  private async _initializeHtml(): Promise<void> {
    try {
      // Wait for resolvers to be initialized (async from constructor)
      await this._initPromise;
      this._panel.webview.html = await this._getWebviewContentAsync();
      this._logger.info('[ApiKeyPanel] HTML initialized with embedded status');
    } catch (e) {
      this._logger.error('[ApiKeyPanel] Failed to initialize HTML:', e);
    }
  }
  
  /**
   * Initialize NAPI unified resolvers and inform them of user preferences
   */
  private async _initResolvers(): Promise<void> {
    try {
      this._native = getNative();
      
      // Read user preferences from VS Code settings
      const config = vscode.workspace.getConfiguration('openLLM');
      const configSource = config.get<string>('config.source', 'vscode');
      const secretsStore = config.get<string>('secrets.primaryStore', 'vscode');
      const checkEnvironment = config.get<boolean>('secrets.checkEnvironment', true);
      const checkDotEnv = config.get<boolean>('secrets.checkDotEnv', false);
      
      if (this._native.UnifiedSecretResolver) {
        this._secretResolver = new this._native.UnifiedSecretResolver();
        // Inform Rust of user preferences
        this._secretResolver.setSecretsStore(secretsStore);
        this._secretResolver.setCheckEnvironment(checkEnvironment);
        this._secretResolver.setCheckDotenv(checkDotEnv);
        this._logger.info(`[_initResolvers] SecretResolver created with store=${secretsStore}, env=${checkEnvironment}, dotenv=${checkDotEnv}`);
      }
      
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (this._native.UnifiedConfigResolver) {
        this._configResolver = workspacePath
          ? this._native.UnifiedConfigResolver.withWorkspace(workspacePath)
          : new this._native.UnifiedConfigResolver();
        // Inform Rust of user preference for config source (async to prevent event loop deadlock)
        await this._configResolver.setConfigSource(configSource);
        this._logger.info(`[_initResolvers] ConfigResolver created with source=${configSource}, workspace: ${workspacePath || 'none'}`);
      }
      
      this._logger.info('NAPI unified resolvers initialized with user preferences');
    } catch (e) {
      this._logger.error('Failed to initialize NAPI resolvers:', e);
    }
  }

  /**
   * Update resolver preferences when settings change
   */
  private async _updateResolverPreferences(): Promise<void> {
    const config = vscode.workspace.getConfiguration('openLLM');
    
    if (this._configResolver) {
      const configSource = config.get<string>('config.source', 'vscode');
      await this._configResolver.setConfigSource(configSource);
      this._logger.info(`[_updateResolverPreferences] Config source set to: ${configSource}`);
    }
    
    if (this._secretResolver) {
      const secretsStore = config.get<string>('secrets.primaryStore', 'vscode');
      const checkEnvironment = config.get<boolean>('secrets.checkEnvironment', true);
      const checkDotEnv = config.get<boolean>('secrets.checkDotEnv', false);
      this._secretResolver.setSecretsStore(secretsStore);
      this._secretResolver.setCheckEnvironment(checkEnvironment);
      this._secretResolver.setCheckDotenv(checkDotEnv);
      this._logger.info(`[_updateResolverPreferences] Secrets store=${secretsStore}, env=${checkEnvironment}, dotenv=${checkDotEnv}`);
    }
  }
  
  /**
   * Get API key for a provider using unified resolver (async)
   */
  private async _getApiKey(providerId: string): Promise<string | undefined> {
    if (!this._secretResolver) {
      return undefined;
    }
    
    try {
      const result = await this._secretResolver.resolve(providerId);
      return result?.value;
    } catch (e) {
      this._logger.warn(`Failed to resolve API key for ${providerId}:`, e);
      return undefined;
    }
  }
  
  /**
   * Get API key source info using unified resolver
   */
  private _getApiKeySource(providerId: string): { source: string; available: boolean; sourceDetail: string; envVarName?: string } {
    if (!this._secretResolver) {
      return { source: 'none', available: false, sourceDetail: 'Resolver not available' };
    }
    
    try {
      const info = this._secretResolver.getSourceInfo(providerId);
      if (info && info.available) {
        // Map source names to expected format
        let source = 'none';
        if (info.name.includes('environment') || info.name.includes('env')) {
          source = 'environment';
        } else if (info.name.includes('vscode') || info.name.includes('rpc')) {
          source = 'secretStorage';
        } else if (info.name.includes('keychain')) {
          source = 'keychain';
        } else if (info.name.includes('dotenv') || info.name.includes('.env')) {
          source = 'dotenv';
        }
        
        return {
          source,
          available: true,
          sourceDetail: info.detail,
          envVarName: info.detail.includes('=') ? info.detail.split('=')[0] : undefined
        };
      }
      return { source: 'none', available: false, sourceDetail: 'Not configured' };
    } catch (e) {
      return { source: 'none', available: false, sourceDetail: 'Error checking' };
    }
  }

  /**
   * Get API key sources for all providers in a single batch call.
   * Much more efficient than calling _getApiKeySource for each provider.
   */
  private _getAllApiKeySources(providerIds: string[]): Map<string, { source: string; available: boolean; sourceDetail: string; envVarName?: string }> {
    const result = new Map<string, { source: string; available: boolean; sourceDetail: string; envVarName?: string }>();
    const defaultValue = { source: 'none', available: false, sourceDetail: 'Not configured' };
    
    if (!this._secretResolver) {
      for (const id of providerIds) {
        result.set(id, { source: 'none', available: false, sourceDetail: 'Resolver not available' });
      }
      return result;
    }
    
    try {
      // Use batch NAPI call - returns HashMap<String, Option<SecretSourceInfo>>
      const allSources = this._secretResolver.getAllSourceInfo(providerIds);
      
      for (const id of providerIds) {
        const info = allSources[id];
        if (info && info.available) {
          result.set(id, {
            source: info.source,
            available: true,
            sourceDetail: info.sourceDetail,
            envVarName: info.envVarName || undefined
          });
        } else {
          result.set(id, defaultValue);
        }
      }
    } catch (e) {
      this._logger.warn('Failed to get batch source info:', e);
      for (const id of providerIds) {
        result.set(id, { source: 'none', available: false, sourceDetail: 'Error checking' });
      }
    }
    
    return result;
  }
  
  /**
   * Store API key using unified resolver with auto-routing.
   * openllm-core decides the best destination (VS Code RPC, system keychain, etc.)
   */
  private async _storeApiKey(providerId: string, apiKey: string): Promise<string> {
    this._logger.info(`[_storeApiKey] Called for ${providerId}, resolver exists: ${!!this._secretResolver}`);
    if (!this._secretResolver) {
      throw new Error('Secret resolver not available');
    }
    
    // Use auto-routing - openllm-core decides destination based on user preferences
    const destination = this._secretResolver.storeAuto 
      ? this._secretResolver.storeAuto(providerId, apiKey)
      : this._secretResolver.store(providerId, apiKey, 'auto');  // fallback for older bindings
    this._logger.info(`[_storeApiKey] Stored to: ${destination}`);
    return destination;
  }
  
  /**
   * Delete API key using unified resolver with auto-routing.
   * openllm-core decides which stores to delete from.
   */
  private async _deleteApiKeyFromResolver(providerId: string): Promise<string> {
    if (!this._secretResolver) {
      throw new Error('Secret resolver not available');
    }
    
    // Use "auto" routing - openllm-core will decide which store to delete from
    const destination = this._secretResolver.delete(providerId, 'auto');
    this._logger.debug(`API key for ${providerId} deleted from: ${destination}`);
    return destination;
  }
  
  /**
   * Get all providers using unified config resolver (async)
   */
  private async _getProviders(): Promise<Array<{
    name: string;
    enabled: boolean;
    apiBase?: string;
    models: string[];
    source: string;
    sourceDetail: string;
  }>> {
    if (!this._configResolver) {
      return [];
    }
    
    try {
      return await this._configResolver.getAllProviders();
    } catch (e) {
      this._logger.warn('Failed to get providers:', e);
      return [];
    }
  }

  private async _saveApiKey(providerId: string, apiKey: string, target: 'user' | 'workspace' = 'user'): Promise<void> {
    try {
      // Store using unified resolver (via RPC to VS Code)
      await this._storeApiKey(providerId, apiKey);
      this._logger.info(`Saved API key for ${providerId}`);
      
      // Also register the provider with its default models
      await this._registerProviderModels(providerId, target);
      
      await this._sendStatus();
      
      // Trigger configuration reload - this will show the model count
      await vscode.commands.executeCommand('openLLM.reloadConfig');
    } catch (error) {
      this._logger.error(`Failed to save API key for ${providerId}:`, error);
      vscode.window.showErrorMessage(`Failed to save API key: ${error}`);
    }
  }

  /**
   * Show QuickPick to let user choose where to save config and API key
   */
  private async _showSavePicker(
    providerId: string, 
    apiKey: string | null, 
    baseUrl: string | null, 
    extraFields: Record<string, string>
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('openLLM');
    const configSource = config.get<string>('config.source', 'vscode');
    const secretsStore = config.get<string>('secrets.primaryStore', 'vscode');
    
    // Build QuickPick items based on current settings
    interface SaveOption extends vscode.QuickPickItem {
      target: 'user' | 'workspace';
    }
    
    const items: SaveOption[] = [];
    
    // Determine config destination labels
    const userConfigLabel = configSource === 'native' 
      ? '~/.config/openllm/config.yaml' 
      : 'VS Code User Settings';
    const workspaceConfigLabel = configSource === 'native' 
      ? '.config/openllm/config.yaml' 
      : 'VS Code Workspace Settings';
    
    // Determine key destination label
    const keyStoreLabel = secretsStore === 'keychain' 
      ? 'System Keychain' 
      : 'VS Code SecretStorage';
    
    // User-level option
    items.push({
      label: '$(home) Save to User',
      description: `Config → ${userConfigLabel}`,
      detail: apiKey ? `API key → ${keyStoreLabel}` : 'No API key to save',
      target: 'user'
    });
    
    // Workspace-level option
    if (vscode.workspace.workspaceFolders) {
      items.push({
        label: '$(folder) Save to Workspace',
        description: `Config → ${workspaceConfigLabel}`,
        detail: apiKey ? `API key → ${keyStoreLabel}` : 'No API key to save',
        target: 'workspace'
      });
    }
    
    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: `Where should ${providerId} configuration be saved?`,
      title: `Save ${providerId} Configuration`
    });
    
    if (!selected) {
      return; // User cancelled
    }
    
    try {
      // Save API key if provided (via unified resolver)
      if (apiKey) {
        await this._storeApiKey(providerId, apiKey);
        this._logger.info(`Saved API key for ${providerId} to ${keyStoreLabel}`);
      }
      
      // Save base URL if provided
      if (baseUrl) {
        await this._saveBaseUrl(providerId, baseUrl, selected.target);
      }
      
      // Save extra fields
      for (const [fieldId, value] of Object.entries(extraFields)) {
        await this._saveExtraField(providerId, fieldId, value);
      }
      
      // Register provider with models
      await this._registerProviderModels(providerId, selected.target);
      
      await this._sendStatus();
      await vscode.commands.executeCommand('openLLM.reloadConfig');
      
      vscode.window.showInformationMessage(
        `Saved ${providerId} config to ${selected.target === 'user' ? userConfigLabel : workspaceConfigLabel}` +
        (apiKey ? ` and API key to ${keyStoreLabel}` : '')
      );
    } catch (error) {
      this._logger.error(`Failed to save ${providerId}:`, error);
      vscode.window.showErrorMessage(`Failed to save: ${error}`);
    }
  }

  /**
   * Configure provider: test connection with provided credentials, show model picker
   * 
   * Note: This does NOT persist the API key yet. The key and config are passed directly
   * to the test methods. Persistence only happens when the user explicitly saves
   * after selecting models.
   */
  private async _configureProvider(
    providerId: string,
    apiKey: string | null,
    baseUrl: string | null,
    extraFields: Record<string, string>
  ): Promise<void> {
    const provider = PROVIDERS.find(p => p.id === providerId);
    if (!provider) return;

    try {
      // Track if API key was provided (so Save button enables even without model changes)
      const apiKeyWasAdded = !!apiKey;
      
      // Store credentials as pending - they'll be persisted when user clicks Save
      if (apiKey || baseUrl) {
        this._pendingCredentials.set(providerId, {
          apiKey: apiKey || undefined,
          baseUrl: baseUrl || undefined
        });
        this._logger.debug(`Stored pending credentials for ${providerId}`);
      }
      
      // Store extra fields temporarily (these are less sensitive)
      for (const [fieldId, value] of Object.entries(extraFields)) {
        await this._saveExtraField(providerId, fieldId, value);
      }

      // Test connection with the provided key/baseUrl directly - DON'T persist yet
      // User hasn't asked to save, they just want to see available models
      await this._testConnectionWithCredentials(providerId, apiKey, baseUrl, apiKeyWasAdded);
    } catch (error) {
      this._logger.error(`Failed to configure ${providerId}:`, error);
      this._panel.webview.postMessage({
        command: 'testResult',
        providerId,
        status: 'error',
        message: `Configuration failed: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }

  /**
   * Register a provider and its models in VS Code settings
   * 
   * Note: API keys are NOT stored in settings - they go in SecretStorage only.
   * Settings only contain: provider name, optional base URL, and model list.
   * 
   * Models are sourced from:
   * 1. Fetched from provider API (if test was run)
   * 2. Default models from PROVIDERS config
   * 
   * Uses openllm-core's unified config resolver to route writes to the 
   * appropriate destination (VS Code settings via RPC or native YAML files).
   */
  private async _registerProviderModels(providerId: string, target: 'user' | 'workspace' = 'user'): Promise<void> {
    if (!this._configResolver) {
      this._logger.warn('Config resolver not available, cannot register models');
      return;
    }

    const providerDef = PROVIDERS.find(p => p.id === providerId);
    const modelsToRegister = this._getProviderModels(providerId);
    
    if (modelsToRegister.length === 0) {
      this._logger.debug(`No models to register for provider ${providerId}`);
      return;
    }

    // Get existing providers to merge models
    const existingProviders = await this._getProviders();
    const existing = existingProviders.find(p => p.name.toLowerCase() === providerId.toLowerCase());
    
    // Merge with existing models
    let finalModels = modelsToRegister;
    if (existing && existing.models.length > 0) {
      const mergedModels = new Set([...existing.models, ...modelsToRegister]);
      finalModels = Array.from(mergedModels);
    }
    
    try {
      // Use unified config resolver's save_provider method
      // openllm-core routes the write to the appropriate destination
      const destination = this._configResolver.saveProvider({
        name: providerId,
        enabled: true,
        apiBase: existing?.apiBase || providerDef?.defaultBaseUrl || '',
        models: finalModels,
        source: '', // Not needed for writes
        sourceDetail: '' // Not needed for writes
      }, target);
      
      this._logger.info(`Registered ${finalModels.length} models for ${providerId} -> ${destination}`);
    } catch (error) {
      this._logger.error(`Failed to register models for ${providerId}:`, error);
      throw error;
    }
  }

  private async _saveBaseUrl(providerId: string, baseUrl: string, target: 'user' | 'workspace' = 'user'): Promise<void> {
    if (!this._configResolver) {
      this._logger.warn('Config resolver not available, cannot save base URL');
      return;
    }

    // Get existing provider config to preserve other fields
    const existingProviders = await this._getProviders();
    const existing = existingProviders.find(p => p.name.toLowerCase() === providerId.toLowerCase());
    
    try {
      // Use unified config resolver's save_provider method
      // openllm-core routes the write to the appropriate destination
      const destination = this._configResolver.saveProvider({
        name: providerId,
        enabled: existing?.enabled ?? true,
        apiBase: baseUrl,
        models: existing?.models || [],
        source: '', // Not needed for writes
        sourceDetail: '' // Not needed for writes
      }, target);
      
      this._logger.info(`Saved base URL for ${providerId}: ${baseUrl} -> ${destination}`);
      await this._sendStatus();
    } catch (error) {
      this._logger.error(`Failed to save base URL for ${providerId}:`, error);
      throw error;
    }
  }

  private async _saveExtraField(providerId: string, fieldId: string, value: string): Promise<void> {
    const key = `openllm.${providerId}.${fieldId}`;
    await this._context.globalState.update(key, value);
    this._logger.info(`Saved ${fieldId} for ${providerId}`);
    await this._sendStatus();
  }

  private async _deleteApiKey(providerId: string): Promise<void> {
    try {
      // Delete using unified resolver (via RPC to VS Code)
      await this._deleteApiKeyFromResolver(providerId);
      this._logger.info(`Deleted API key for ${providerId}`);
      vscode.window.showInformationMessage(`API key deleted for ${providerId}`);
      await this._sendStatus();
    } catch (error) {
      this._logger.error(`Failed to delete API key for ${providerId}:`, error);
    }
  }

  private async _refreshProvider(providerId: string): Promise<void> {
    this._logger.info(`Refreshing provider: ${providerId}`);
    await this._sendStatus();
    await vscode.commands.executeCommand('openLLM.reloadConfig');
  }

  private async _refreshAll(): Promise<void> {
    this._logger.info('Refreshing all providers');
    
    // Unified resolvers are stateless - they query fresh on each call
    // Just trigger a reload to re-query all sources
    await this._sendStatus();
    await vscode.commands.executeCommand('openLLM.reloadConfig');
  }

  /**
   * Update a VS Code setting from the webview
   */
  private async _updateSetting(key: string, value: any): Promise<void> {
    this._logger.info(`[_updateSetting] Updating openLLM.${key} to ${value}`);
    const config = vscode.workspace.getConfiguration('openLLM');
    
    // Check if there's a workspace-level override
    const inspection = config.inspect(key);
    const hasWorkspaceValue = inspection?.workspaceValue !== undefined;
    const hasUserValue = inspection?.globalValue !== undefined;
    
    this._logger.info(`[_updateSetting] Inspection: user=${inspection?.globalValue}, workspace=${inspection?.workspaceValue}, effective=${config.get(key)}`);
    
    try {
      // If workspace has an override, update at workspace level
      // Otherwise, update at user level
      const target = hasWorkspaceValue 
        ? vscode.ConfigurationTarget.Workspace 
        : vscode.ConfigurationTarget.Global;
      
      this._logger.info(`[_updateSetting] Updating at ${hasWorkspaceValue ? 'Workspace' : 'User'} level`);
      await config.update(key, value, target);
      
      // Verify the update
      const newValue = config.get(key);
      this._logger.info(`[_updateSetting] Verified new value of openLLM.${key}: ${newValue}`);
    } catch (e) {
      this._logger.error(`[_updateSetting] Failed to update openLLM.${key}:`, e);
      throw e;
    }
    
    // Reload config for settings that affect provider/key resolution
    const reloadTriggers = [
      'config.source',
      'config.nativeLevel', 
      'secrets.primaryStore',
      'secrets.checkEnvironment',
      'secrets.checkDotEnv'
    ];
    
    if (reloadTriggers.includes(key)) {
      // Reload config manager (affects which providers/keys are loaded)
      // Unified resolvers are stateless - they query fresh on each call
      await vscode.commands.executeCommand('openLLM.reloadConfig');
    }
    
    // Refresh status to reflect the change (send updated data to webview)
    await this._sendStatus();
  }

  /**
   * Update a setting at a specific scope (user or workspace).
   * If value is null, removes the setting at that scope (inherits from parent).
   */
  private async _updateSettingScoped(key: string, scope: 'user' | 'workspace', value: any): Promise<void> {
    this._logger.info(`[_updateSettingScoped] Updating openLLM.${key} at ${scope} scope to ${value}`);
    const config = vscode.workspace.getConfiguration('openLLM');
    
    const target = scope === 'workspace' 
      ? vscode.ConfigurationTarget.Workspace 
      : vscode.ConfigurationTarget.Global;
    
    try {
      // If value is null or empty string, remove the setting at this scope
      if (value === null || value === '') {
        await config.update(key, undefined, target);
        this._logger.info(`[_updateSettingScoped] Removed openLLM.${key} at ${scope} scope`);
      } else {
        await config.update(key, value, target);
        this._logger.info(`[_updateSettingScoped] Set openLLM.${key} to ${value} at ${scope} scope`);
      }
    } catch (e) {
      this._logger.error(`[_updateSettingScoped] Failed to update openLLM.${key}:`, e);
      throw e;
    }
    
    // Reload config for settings that affect provider/key resolution
    const reloadTriggers = [
      'config.source',
      'config.nativeLevel', 
      'secrets.primaryStore',
      'secrets.checkEnvironment',
      'secrets.checkDotEnv'
    ];
    
    if (reloadTriggers.includes(key)) {
      await vscode.commands.executeCommand('openLLM.reloadConfig');
    }
    
    await this._sendStatus();
  }

  /**
   * Import config from one source to another based on current setting and scope.
   * If config source is 'native', imports FROM VS Code to OpenLLM (using exportConfigTo).
   * If config source is 'vscode', imports FROM OpenLLM to VS Code (using importConfigFrom).
   */
  private async _importConfig(scope: 'user' | 'workspace'): Promise<void> {
    this._logger.info(`[_importConfig] Importing config for ${scope} scope`);
    const config = vscode.workspace.getConfiguration('openLLM');
    const inspection = config.inspect<string>('config.source');
    
    // Determine the effective config source for this scope
    let effectiveSource: string;
    if (scope === 'workspace') {
      effectiveSource = inspection?.workspaceValue ?? inspection?.globalValue ?? 'vscode';
    } else {
      effectiveSource = inspection?.globalValue ?? 'vscode';
    }
    
    try {
      if (effectiveSource === 'native') {
        // Using OpenLLM config - import FROM VS Code TO OpenLLM
        // This uses exportConfigTo which copies VS Code providers to native YAML
        await vscode.commands.executeCommand('openLLM.exportConfigTo', scope);
      } else {
        // Using VS Code - import FROM OpenLLM TO VS Code
        // This uses importConfigFrom which copies native YAML providers to VS Code
        await vscode.commands.executeCommand('openLLM.importConfigFrom', scope);
      }
    } catch (e) {
      this._logger.error(`[_importConfig] Failed:`, e);
      vscode.window.showErrorMessage(`Failed to import config: ${e}`);
    }
    
    await this._sendStatus();
  }

  /**
   * Import secrets from one store to another based on current setting and scope.
   * If secrets store is 'keychain', imports FROM VS Code to Keychain.
   * If secrets store is 'vscode', imports FROM Keychain to VS Code.
   */
  private async _importSecrets(scope: 'user' | 'workspace'): Promise<void> {
    this._logger.info(`[_importSecrets] Importing secrets for ${scope} scope`);
    const config = vscode.workspace.getConfiguration('openLLM');
    const inspection = config.inspect<string>('secrets.primaryStore');
    
    // Determine the effective secrets store for this scope
    let effectiveStore: string;
    if (scope === 'workspace') {
      effectiveStore = inspection?.workspaceValue ?? inspection?.globalValue ?? 'keychain';
    } else {
      effectiveStore = inspection?.globalValue ?? 'keychain';
    }
    
    try {
      if (effectiveStore === 'keychain') {
        // Using Keychain - import FROM VS Code TO Keychain
        await vscode.commands.executeCommand('openLLM.exportKeysToKeychain');
        vscode.window.showInformationMessage('Copied API keys from VS Code SecretStorage to System Keychain.');
      } else {
        // Using VS Code - import FROM Keychain TO VS Code
        await vscode.commands.executeCommand('openLLM.exportKeysToVSCode');
        vscode.window.showInformationMessage('Copied API keys from System Keychain to VS Code SecretStorage.');
      }
    } catch (e) {
      this._logger.error(`[_importSecrets] Failed:`, e);
      vscode.window.showErrorMessage(`Failed to import secrets: ${e}`);
    }
    
    await this._sendStatus();
  }

  /**
   * Toggle enabled state for a provider
   */
  private async _toggleEnabled(providerId: string, enabled: boolean): Promise<void> {
    if (!this._configResolver) {
      this._logger.warn('Config resolver not available, cannot toggle provider');
      return;
    }

    const providerDef = PROVIDERS.find(p => p.id === providerId);
    
    try {
      // DEBUG: Log state before toggle
      const beforeProviders = await this._getProviders();
      this._logger.info(`[DEBUG] Before toggle: all providers = ${JSON.stringify(beforeProviders.map(p => ({ n: p.name, e: p.enabled })))}`);
      const beforeState = beforeProviders.find(p => p.name.toLowerCase() === providerId.toLowerCase());
      this._logger.info(`[DEBUG] Before toggle: ${providerId}.enabled = ${beforeState?.enabled}`);
      
      // Use unified config resolver to toggle provider
      this._logger.info(`[DEBUG] Calling toggleProvider(${providerId}, ${enabled}, 'user')...`);
      const destination = this._configResolver.toggleProvider(providerId, enabled, 'user');
      this._logger.info(`[DEBUG] toggleProvider returned: ${destination}`);
      
      // DEBUG: Log state immediately after toggle (NO delay, direct call)
      this._logger.info(`[DEBUG] Calling getAllProviders immediately after toggle...`);
      const afterProviders = await this._getProviders();
      this._logger.info(`[DEBUG] After toggle: all providers = ${JSON.stringify(afterProviders.map(p => ({ n: p.name, e: p.enabled })))}`);
      const afterState = afterProviders.find(p => p.name.toLowerCase() === providerId.toLowerCase());
      this._logger.info(`[DEBUG] After toggle: ${providerId}.enabled = ${afterState?.enabled}`);
      
      // If enabling a new provider that doesn't exist, create it with defaults
      if (enabled) {
        // Small delay to let VS Code settings sync after the toggle write
        await new Promise(resolve => setTimeout(resolve, 100));
        const providers = await this._getProviders();
        const existing = providers.find(p => p.name.toLowerCase() === providerId.toLowerCase());
        if (!existing) {
          this._configResolver.saveProvider({
            name: providerId,
            enabled: true,
            apiBase: providerDef?.defaultBaseUrl || '',
            models: providerDef?.models || [],
            source: '',
            sourceDetail: ''
          }, 'user');
        }
      }
      
      this._logger.info(`Provider ${providerId} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      this._logger.error(`Failed to toggle provider ${providerId}:`, error);
    }

    // In-memory state is updated immediately by the Rust core, so just refresh status
    await this._sendStatus();
    
    // Notify ConfigManager to reload (for model registration)
    await vscode.commands.executeCommand('openLLM.reloadConfig');
  }

  /**
   * Save user-selected models for a provider.
   * 
   * This is called when the user clicks Save in the model picker.
   * It persists:
   * 1. Any pending API key (entered during Configure but not yet saved)
   * 2. Any pending base URL
   * 3. The selected models
   */
  private async _saveSelectedModels(
    providerId: string, 
    models: string[], 
    target: 'user' | 'workspace' = 'user'
  ): Promise<void> {
    if (!this._configResolver) {
      this._logger.warn('Config resolver not available, cannot save models');
      return;
    }

    // Allow empty models array - user may want to remove all models
    const modelList = models || [];

    try {
      // First, persist any pending credentials (API key, base URL)
      const pending = this._pendingCredentials.get(providerId);
      if (pending) {
        if (pending.apiKey) {
          const keyDest = await this._storeApiKey(providerId, pending.apiKey);
          this._logger.info(`Persisted API key for ${providerId} -> ${keyDest}`);
        }
        if (pending.baseUrl) {
          // Save base URL via config resolver
          await this._saveBaseUrl(providerId, pending.baseUrl, target);
        }
        // Clear pending credentials after saving
        this._pendingCredentials.delete(providerId);
      }
      
      // Use unified config resolver to save models to appropriate destination
      const destination = this._configResolver.updateProviderModels(providerId, modelList, target);
      
      this._logger.info(`Saved ${modelList.length} selected models for ${providerId} -> ${destination}`);
      vscode.window.showInformationMessage(`Saved ${modelList.length} models for ${providerId}`);
      
      await vscode.commands.executeCommand('openLLM.reloadConfig');
      
      // Refresh the test result for this provider so cached data is updated
      await this._testConnection(providerId);
    } catch (error) {
      this._logger.error(`Failed to save models for ${providerId}:`, error);
      vscode.window.showErrorMessage(`Failed to save models: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Test connection with credentials from resolver (for re-testing saved providers)
   */
  private async _testConnection(providerId: string, apiKeyWasAdded: boolean = false): Promise<void> {
    // Get credentials from resolver (for already-saved providers)
    const apiKey = await this._getApiKey(providerId);
    const provider = PROVIDERS.find(p => p.id === providerId);
    const baseUrl = await this._getBaseUrl(providerId, provider?.defaultBaseUrl);
    
    await this._testConnectionWithCredentials(providerId, apiKey || null, baseUrl || null, apiKeyWasAdded);
  }

  /**
   * Test connection with directly provided credentials (no persistence)
   * 
   * This allows testing a connection before the user decides to save.
   * The apiKey and baseUrl are passed directly to provider test methods.
   */
  private async _testConnectionWithCredentials(
    providerId: string, 
    apiKey: string | null, 
    baseUrl: string | null,
    apiKeyWasAdded: boolean = false
  ): Promise<void> {
    const provider = PROVIDERS.find(p => p.id === providerId);
    if (!provider) return;

    this._panel.webview.postMessage({ 
      command: 'testResult', 
      providerId, 
      status: 'testing' 
    });

    try {
      // Use provided credentials directly - no resolver lookup needed
      // Fall back to resolver only if credentials not provided
      const effectiveApiKey = apiKey || await this._getApiKey(providerId);
      const effectiveBaseUrl = baseUrl || await this._getBaseUrl(providerId, provider.defaultBaseUrl);

      let success = false;
      let message = '';

      switch (providerId) {
        case 'openai':
        case 'openrouter':
          ({ success, message } = await this._testOpenAICompatible(effectiveBaseUrl!, effectiveApiKey!, providerId));
          break;
        case 'anthropic':
          ({ success, message } = await this._testAnthropic(effectiveBaseUrl!, effectiveApiKey!));
          break;
        case 'gemini':
          ({ success, message } = await this._testGemini(effectiveApiKey!));
          break;
        case 'ollama':
          ({ success, message } = await this._testOllama(effectiveBaseUrl!));
          break;
        case 'mistral':
          ({ success, message } = await this._testMistral(effectiveBaseUrl!, effectiveApiKey!));
          break;
        case 'azure':
          ({ success, message } = await this._testAzure(providerId, effectiveApiKey!));
          break;
        case 'rhoai':
          ({ success, message } = await this._testOpenAICompatible(effectiveBaseUrl!, effectiveApiKey!, providerId));
          break;
        default:
          message = 'Test not implemented for this provider';
      }

      // Get fetched models to send to UI for picker
      const fetchedModels = success 
        ? this._context.globalState.get<Array<{id: string; name?: string; vision?: boolean; tools?: boolean}>>(`openllm.${providerId}.fetchedModels`) || []
        : [];

      // Get models from user and workspace configs separately - source-aware
      const configSettings = vscode.workspace.getConfiguration('openLLM');
      const configSource = configSettings.get<string>('config.source', 'vscode');
      let userModels: string[] = [];
      let workspaceModels: string[] = [];

      if (configSource === 'native') {
        // Get from native YAML files
        try {
          const native = getNative();
          const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          
          const userConfig = native.FileConfigProvider.user();
          if (userConfig.exists()) {
            const providers = await userConfig.getProviders();
            const provider = providers.find((p: any) => p.name.toLowerCase() === providerId.toLowerCase());
            userModels = provider?.models || [];
          }
          
          if (workspacePath) {
            const wsConfig = native.FileConfigProvider.workspace(workspacePath);
            if (wsConfig.exists()) {
              const providers = await wsConfig.getProviders();
              const provider = providers.find((p: any) => p.name.toLowerCase() === providerId.toLowerCase());
              workspaceModels = provider?.models || [];
            }
          }
        } catch (e) {
          this._logger.error('Failed to get native models:', e);
        }
      } else {
        // Get from VS Code settings
        const config = vscode.workspace.getConfiguration('openLLM');
        const inspection = config.inspect<Array<{ name: string; models?: string[] }>>('providers');
        
        const userProviders = inspection?.globalValue || [];
        const workspaceProviders = inspection?.workspaceValue || [];
        
        const userProviderConfig = userProviders.find(p => p.name.toLowerCase() === providerId.toLowerCase());
        const workspaceProviderConfig = workspaceProviders.find(p => p.name.toLowerCase() === providerId.toLowerCase());
        
        userModels = userProviderConfig?.models || [];
        workspaceModels = workspaceProviderConfig?.models || [];
      }

      // Get secrets store info for UI
      const config = vscode.workspace.getConfiguration('openLLM');
      const secretsStore = config.get<string>('secrets.primaryStore', 'vscode');
      
      this._panel.webview.postMessage({ 
        command: 'testResult', 
        providerId, 
        status: success ? 'success' : 'error',
        message,
        models: fetchedModels,
        userModels,
        workspaceModels,
        configSource, // Send so UI knows what user/workspace means
        secretsStore, // Send so UI can show where keys are saved
        apiKeyWasAdded, // Tell UI if API key was just added
        // Destination labels for the model picker
        saveDestinations: {
          userConfig: configSource === 'native' ? '~/.config/openllm/config.yaml' : 'VS Code User Settings',
          workspaceConfig: configSource === 'native' ? '.config/openllm/config.yaml' : 'VS Code Workspace Settings',
          keyStore: secretsStore === 'keychain' ? 'System Keychain' : 'VS Code SecretStorage'
        }
      });
    } catch (error) {
      this._panel.webview.postMessage({ 
        command: 'testResult', 
        providerId, 
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        models: []
      });
    }
  }

  private _getBaseUrlFromCached(
    providerId: string, 
    cachedProviders: Array<{ name: string; apiBase?: string }>,
    defaultUrl?: string
  ): string | undefined {
    const providerConfig = cachedProviders.find(p => p.name.toLowerCase() === providerId.toLowerCase());
    return providerConfig?.apiBase || defaultUrl;
  }

  private async _getBaseUrl(providerId: string, defaultUrl?: string): Promise<string | undefined> {
    // Use unified config resolver to get from appropriate source
    const providers = await this._getProviders();
    return this._getBaseUrlFromCached(providerId, providers, defaultUrl);
  }

  private async _testOpenAICompatible(baseUrl: string, apiKey: string, providerId: string): Promise<{ success: boolean; message: string }> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    // OpenRouter recommends these headers
    if (providerId === 'openrouter') {
      headers['HTTP-Referer'] = 'https://github.com/open-llm-provider';
      headers['X-Title'] = 'Open LLM Provider';
    }

    const response = await fetch(`${baseUrl}/models`, { headers });
    
    if (response.ok) {
      const data = await response.json() as { 
        data?: Array<{ 
          id: string;
          name?: string;
          context_length?: number;
          pricing?: { prompt?: string; completion?: string };
          architecture?: { modality?: string; tokenizer?: string };
        }> 
      };
      const models = data.data || [];
      const modelCount = models.length;
      
      // Store fetched models with capabilities for this provider
      if (modelCount > 0) {
        const modelData = models.map(m => ({
          id: m.id,
          name: m.name || m.id,
          contextLength: m.context_length,
          vision: m.architecture?.modality?.includes('image') || m.id.includes('vision'),
          tools: m.id.includes('gpt-4') || m.id.includes('claude') || m.id.includes('gemini')
        }));
        // Sort alphabetically
        modelData.sort((a, b) => a.id.localeCompare(b.id));
        await this._context.globalState.update(`openllm.${providerId}.fetchedModels`, modelData);
        this._logger.info(`Fetched ${modelCount} models for ${providerId}`);
      }
      
      return { success: true, message: `Connected! ${modelCount} models available.` };
    } else {
      const error = await response.text();
      return { success: false, message: `Error ${response.status}: ${error.substring(0, 100)}` };
    }
  }

  /**
   * Get models for a provider - either from API cache or defaults
   */
  private _getProviderModels(providerId: string): string[] {
    // First check for fetched models from API
    // Note: fetchedModels can be either string[] or {id: string, ...}[] depending on provider
    const fetchedModels = this._context.globalState.get<Array<string | {id: string}>>(`openllm.${providerId}.fetchedModels`);
    if (fetchedModels && fetchedModels.length > 0) {
      // For providers with many models (OpenRouter, OpenAI), limit to top picks
      // OpenRouter returns hundreds, we'll take top 10
      const limit = providerId === 'openrouter' ? 10 : 20;
      // Extract string IDs - handle both string[] and object[] formats
      const modelIds = fetchedModels.slice(0, limit).map(m => 
        typeof m === 'string' ? m : m.id
      );
      return modelIds;
    }
    
    // Fall back to defaults
    const providerDef = PROVIDERS.find(p => p.id === providerId);
    return providerDef?.models || [];
  }

  /**
   * Get total fetched models count for a provider
   */
  private _getFetchedModelCount(providerId: string): number {
    const fetchedModels = this._context.globalState.get<Array<string | {id: string}>>(`openllm.${providerId}.fetchedModels`);
    return fetchedModels?.length || 0;
  }

  private async _testAnthropic(baseUrl: string, apiKey: string): Promise<{ success: boolean; message: string }> {
    // Anthropic doesn't have a /models endpoint, so we do a minimal completion request
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'Hi' }]
      })
    });

    if (response.ok || response.status === 400) {
      // 400 might mean invalid request but valid auth
      return { success: true, message: 'Connected to Anthropic API!' };
    } else if (response.status === 401) {
      return { success: false, message: 'Invalid API key' };
    } else {
      return { success: false, message: `Error ${response.status}` };
    }
  }

  private async _testGemini(apiKey: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );

    if (response.ok) {
      const data = await response.json() as { models?: Array<{ name: string }> };
      const models = data.models || [];
      const modelCount = models.length;
      
      // Store fetched models - filter to generative models only
      if (modelCount > 0) {
        const modelIds = models
          .map(m => m.name.replace('models/', ''))
          .filter(id => id.startsWith('gemini'));
        await this._context.globalState.update('openllm.gemini.fetchedModels', modelIds);
        this._logger.info(`Fetched ${modelIds.length} Gemini models`);
      }
      
      return { success: true, message: `Connected! ${modelCount} models available.` };
    } else {
      return { success: false, message: `Error ${response.status}` };
    }
  }

  private async _testOllama(baseUrl: string): Promise<{ success: boolean; message: string }> {
    try {
      const response = await fetch(`${baseUrl}/api/tags`);
      if (response.ok) {
        const data = await response.json() as { models?: Array<{ name: string }> };
        const models = data.models || [];
        const modelCount = models.length;
        
        // Store fetched models
        if (modelCount > 0) {
          const modelIds = models.map(m => m.name);
          await this._context.globalState.update('openllm.ollama.fetchedModels', modelIds);
          this._logger.info(`Fetched ${modelCount} models for ollama`);
        }
        
        return { success: true, message: `Connected! ${modelCount} local models found.` };
      } else {
        return { success: false, message: `Error ${response.status}` };
      }
    } catch {
      return { success: false, message: 'Cannot connect to Ollama. Is it running?' };
    }
  }

  private async _testMistral(baseUrl: string, apiKey: string): Promise<{ success: boolean; message: string }> {
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (response.ok) {
      const data = await response.json() as { data?: Array<{ id: string }> };
      const models = data.data || [];
      const modelCount = models.length;
      
      // Store fetched models
      if (modelCount > 0) {
        const modelIds = models.map(m => m.id);
        await this._context.globalState.update('openllm.mistral.fetchedModels', modelIds);
        this._logger.info(`Fetched ${modelCount} models for mistral`);
      }
      
      return { success: true, message: `Connected! ${modelCount} models available.` };
    } else {
      return { success: false, message: `Error ${response.status}` };
    }
  }

  private async _testAzure(providerId: string, apiKey: string): Promise<{ success: boolean; message: string }> {
    const baseUrl = await this._getBaseUrl(providerId);
    if (!baseUrl) {
      return { success: false, message: 'Please configure the Azure endpoint URL' };
    }

    const response = await fetch(`${baseUrl}/openai/models?api-version=2024-02-15-preview`, {
      headers: {
        'api-key': apiKey
      }
    });

    if (response.ok) {
      return { success: true, message: 'Connected to Azure OpenAI!' };
    } else {
      return { success: false, message: `Error ${response.status}` };
    }
  }

  /**
   * Send status with an override for a specific provider's enabled state.
   * Used for optimistic updates after toggle to avoid VS Code config caching issues.
   */
  private async _sendStatusWithOverride(overrideProviderId: string, overrideEnabled: boolean): Promise<void> {
    return this._sendStatusInternal({ providerId: overrideProviderId, enabled: overrideEnabled });
  }

  private async _sendStatus(): Promise<void> {
    return this._sendStatusInternal();
  }

  private async _sendStatusInternal(override?: { providerId: string; enabled: boolean }): Promise<void> {
    const { status, settings } = await this._buildStatusData(override);
    
    // Log a summary of enabled/disabled providers
    const enabledCount = Object.values(status).filter(s => s.enabled).length;
    const disabledCount = Object.values(status).filter(s => !s.enabled).length;
    this._logger.info(`[_sendStatus] Posting status: ${enabledCount} enabled, ${disabledCount} disabled, settings=${JSON.stringify(settings)}`);
    
    this._panel.webview.postMessage({ command: 'status', status, settings });
  }

  /**
   * Build status data for all providers without posting.
   * Used both for sending status messages and for embedding initial state in HTML.
   */
  private async _buildStatusData(override?: { providerId: string; enabled: boolean }): Promise<{
    status: Record<string, {
      hasApiKey: boolean;
      keySource: 'secretStorage' | 'keychain' | 'environment' | 'dotenv' | 'none';
      keySourceDetail: string;
      configSource: string;
      configSourceDetail: string;
      envVarName?: string;
      baseUrl?: string;
      extraFields?: Record<string, string>;
      enabled: boolean;
      hasModels: boolean;
    }>;
    settings: {
      configSourceUser: string | null;
      configSourceWorkspace: string | null;
      secretsStoreUser: string | null;
      secretsStoreWorkspace: string | null;
      checkEnvUser: boolean;
      checkEnvWorkspace: boolean | null;
      checkDotEnvUser: boolean;
      checkDotEnvWorkspace: boolean | null;
    };
  }> {
    const status: Record<string, { 
      hasApiKey: boolean; 
      keySource: 'secretStorage' | 'keychain' | 'environment' | 'dotenv' | 'none';
      keySourceDetail: string;
      configSource: string;
      configSourceDetail: string;
      envVarName?: string;
      baseUrl?: string; 
      extraFields?: Record<string, string>;
      enabled: boolean;
      hasModels: boolean;
    }> = {};

    // Get config source setting
    const config = vscode.workspace.getConfiguration('openLLM');
    const configSourceSetting = config.get<string>('config.source', 'vscode');
    const nativeLevel = config.get<string>('config.nativeLevel', 'user');
    const secretsPrimaryStore = config.get<string>('secrets.primaryStore', 'vscode');
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    
    // Get configured providers from the unified config resolver
    // (combines VS Code RPC and native sources, returns source info per provider)
    const configuredProviders = await this._getProviders();
    this._logger.info(`[_sendStatus] configuredProviders count: ${configuredProviders.length}`);
    if (configuredProviders.length > 0) {
      this._logger.info(`[_sendStatus] configuredProviders: ${JSON.stringify(configuredProviders.map(p => ({ name: p.name, enabled: p.enabled })))}`);
    }
    
    // Track per-provider config sources
    let providerConfigSources: Map<string, string> = new Map();
    let defaultConfigSourceDetail = 'VS Code User Settings';
    
    if (configSourceSetting === 'vscode') {
      // Check if providers come from user or workspace settings
      const inspection = config.inspect<Array<{ name: string }>>('providers');
      const userProviders = inspection?.globalValue || [];
      const workspaceProviders = inspection?.workspaceValue || [];
      
      // Mark each provider with its source
      for (const p of userProviders) {
        providerConfigSources.set(p.name.toLowerCase(), 'VS Code User Settings');
      }
      for (const p of workspaceProviders) {
        // Workspace overrides user
        providerConfigSources.set(p.name.toLowerCase(), 'VS Code Workspace Settings');
      }
      
      if (workspaceProviders.length > 0 && userProviders.length > 0) {
        defaultConfigSourceDetail = 'VS Code User + Workspace Settings';
      } else if (workspaceProviders.length > 0) {
        defaultConfigSourceDetail = 'VS Code Workspace Settings';
      }
    } else {
      // Native config mode - use source info from already-fetched configuredProviders
      // (configuredProviders already contains merged data from unified resolver)
      try {
        const native = getNative();
        const existingFiles: string[] = [];
        
        // Check which files exist (quick synchronous check, no extra RPC)
        if (nativeLevel === 'user' || nativeLevel === 'both') {
          const userConfig = native.FileConfigProvider.user();
          if (userConfig.exists()) {
            existingFiles.push('~/.config/openllm/config.yaml');
          }
        }
        
        if ((nativeLevel === 'workspace' || nativeLevel === 'both') && workspacePath) {
          const wsConfig = native.FileConfigProvider.workspace(workspacePath);
          if (wsConfig.exists()) {
            existingFiles.push('.config/openllm/config.yaml');
          }
        }
        
        // Use sourceDetail from configuredProviders (already fetched above)
        for (const p of configuredProviders) {
          if (p.sourceDetail) {
            providerConfigSources.set(p.name.toLowerCase(), p.sourceDetail);
          }
        }
        
        if (existingFiles.length > 0) {
          defaultConfigSourceDetail = existingFiles.join(' + ');
        } else {
          defaultConfigSourceDetail = 'No config files found (create with Export)';
        }
      } catch {
        defaultConfigSourceDetail = 'Native config (check failed)';
      }
    }

    // Batch fetch all API key sources in a single NAPI call (much faster than 8 individual calls)
    const allKeySources = this._getAllApiKeySources(PROVIDERS.map(p => p.id));

    for (const provider of PROVIDERS) {
      // Use cached key source from batch call
      const keySource = allKeySources.get(provider.id) || { source: 'none', available: false, sourceDetail: 'Not configured' };
      // Use cached providers instead of making another RPC call
      const baseUrl = this._getBaseUrlFromCached(provider.id, configuredProviders, provider.defaultBaseUrl);
      
      const extraFields: Record<string, string> = {};
      if (provider.extraFields) {
        for (const field of provider.extraFields) {
          const value = this._context.globalState.get<string>(`openllm.${provider.id}.${field.id}`);
          if (value) {
            extraFields[field.id] = value;
          }
        }
      }

      // Find this provider in the configured list
      const configuredProvider = configuredProviders.find(
        p => p.name.toLowerCase() === provider.id.toLowerCase()
      );
      // Provider is only enabled if it exists in settings AND enabled is not explicitly false
      // If not in settings at all, it's disabled by default
      const isInSettings = !!configuredProvider;
      // Apply override if this is the provider being toggled (optimistic update)
      let enabled: boolean;
      if (override && override.providerId.toLowerCase() === provider.id.toLowerCase()) {
        enabled = override.enabled;
        this._logger.info(`[_sendStatus] ${provider.id}: applying optimistic override enabled=${enabled}`);
      } else {
        enabled = isInSettings && configuredProvider?.enabled !== false;
      }
      const hasModels = (configuredProvider?.models?.length || 0) > 0;
      
      this._logger.info(`[_sendStatus] ${provider.id}: isInSettings=${isInSettings}, enabled=${enabled}, hasModels=${hasModels}`);

      // Build key source detail string
      let keySourceDetail = '';
      switch (keySource.source) {
        case 'secretStorage':
          keySourceDetail = 'VS Code SecretStorage';
          break;
        case 'keychain':
          keySourceDetail = 'System Keychain';
          break;
        case 'environment':
          keySourceDetail = `Environment variable: ${keySource.envVarName || 'unknown'}`;
          break;
        case 'dotenv':
          keySourceDetail = `.env file (${keySource.envVarName || 'unknown'})`;
          break;
        default:
          keySourceDetail = provider.requiresApiKey ? 'Not configured' : 'Not required';
      }

      // Use provider-specific config source if available, otherwise use default
      const providerConfigSource = providerConfigSources.get(provider.id.toLowerCase()) || defaultConfigSourceDetail;

      status[provider.id] = {
        hasApiKey: keySource.available || !provider.requiresApiKey,
        keySource: keySource.source as 'secretStorage' | 'keychain' | 'environment' | 'dotenv' | 'none',
        keySourceDetail,
        configSource: configSourceSetting,
        configSourceDetail: providerConfigSource,
        envVarName: keySource.envVarName,
        baseUrl,
        extraFields,
        enabled,
        hasModels
      };
    }

    // Also build current settings for the settings modal
    // We need to inspect each setting to get user vs workspace values separately
    const settingsConfig = vscode.workspace.getConfiguration('openLLM');
    
    const configSourceInspect = settingsConfig.inspect<string>('config.source');
    const secretsStoreInspect = settingsConfig.inspect<string>('secrets.primaryStore');
    const checkEnvInspect = settingsConfig.inspect<boolean>('secrets.checkEnvironment');
    const checkDotEnvInspect = settingsConfig.inspect<boolean>('secrets.checkDotEnv');
    
    const settings = {
      configSourceUser: configSourceInspect?.globalValue ?? 'vscode',
      configSourceWorkspace: configSourceInspect?.workspaceValue ?? null,
      secretsStoreUser: secretsStoreInspect?.globalValue ?? 'keychain',
      secretsStoreWorkspace: secretsStoreInspect?.workspaceValue ?? null,
      checkEnvUser: checkEnvInspect?.globalValue ?? true,
      checkEnvWorkspace: checkEnvInspect?.workspaceValue ?? null,
      checkDotEnvUser: checkDotEnvInspect?.globalValue ?? false,
      checkDotEnvWorkspace: checkDotEnvInspect?.workspaceValue ?? null
    };

    return { status, settings };
  }

  private async _update(): Promise<void> {
    this._panel.webview.html = await this._getWebviewContentAsync();
  }

  private async _getWebviewContentAsync(): Promise<string> {
    // Build initial status data to embed in HTML (eliminates round-trip)
    const { status: initialStatus, settings: initialSettings } = await this._buildStatusData();
    this._logger.info(`[_getWebviewContentAsync] Embedded initial status for ${Object.keys(initialStatus).length} providers`);
    
    // Get codicons CSS URI (the CSS references codicon.ttf with relative path ./codicon.ttf)
    const codiconsCssUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'out', 'codicons', 'codicon.css')
    );

    const providersJson = JSON.stringify(PROVIDERS);
    const initialStatusJson = JSON.stringify(initialStatus);
    const initialSettingsJson = JSON.stringify(initialSettings);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this._panel.webview.cspSource} 'unsafe-inline'; font-src ${this._panel.webview.cspSource}; script-src 'unsafe-inline';">
  <link href="${codiconsCssUri}" rel="stylesheet" />
  <title>API Key Configuration</title>
  <style>
    :root {
      --container-padding: 20px;
      --card-bg: var(--vscode-editor-background);
      --card-border: var(--vscode-widget-border);
      --success-color: #4caf50;
      --warning-color: #ff9800;
      --error-color: #f44336;
    }
    
    body {
      padding: var(--container-padding);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-editor-background);
    }
    
    .header-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }

    h1 {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 0;
      font-size: 1.5em;
      font-weight: 600;
    }
    
    .refresh-all-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    
    .refresh-all-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .subtitle {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 24px;
    }
    
    .provider-grid {
      display: flex;
      flex-direction: column;
    }
    
    .provider-card {
      padding: 20px 0;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    
    .provider-card:last-child {
      border-bottom: none;
    }
    
    .provider-card.provider-disabled {
      opacity: 0.7;
    }
    
    .provider-body.body-disabled {
      opacity: 0.5;
      pointer-events: none;
    }
    
    .provider-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }
    
    .provider-name-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    
    .provider-name {
      font-weight: 600;
      font-size: 1.1em;
    }
    
    .info-btn {
      background: transparent;
      border: none;
      padding: 2px 4px;
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
      opacity: 0.6;
    }
    
    .info-btn:hover {
      opacity: 1;
      color: var(--vscode-foreground);
    }
    
    .provider-info-panel {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      padding: 10px 12px;
      margin-bottom: 12px;
      font-size: 12px;
    }
    
    .info-row {
      display: flex;
      gap: 8px;
      margin-bottom: 4px;
    }
    
    .info-row:last-child {
      margin-bottom: 0;
    }
    
    .info-label {
      color: var(--vscode-descriptionForeground);
      min-width: 100px;
    }
    
    .info-value {
      color: var(--vscode-foreground);
      font-family: var(--vscode-editor-font-family);
    }
    
    /* Enabled Checkbox */
    .enabled-checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    
    .enabled-checkbox input[type="checkbox"] {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--vscode-button-background);
    }
    
    .provider-description {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      margin-bottom: 12px;
    }
    
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.8em;
      font-weight: 500;
    }
    
    .status-configured {
      background: rgba(76, 175, 80, 0.2);
      color: var(--success-color);
    }
    
    .status-missing {
      background: rgba(255, 152, 0, 0.2);
      color: var(--warning-color);
    }
    
    .status-disabled {
      background: rgba(128, 128, 128, 0.2);
      color: var(--vscode-descriptionForeground);
    }
    
    .key-source-badge {
      font-size: 0.75em;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 8px;
      font-weight: normal;
    }
    
    .env-badge {
      background: rgba(33, 150, 243, 0.2);
      color: #2196f3;
    }
    
    .storage-badge {
      background: rgba(76, 175, 80, 0.2);
      color: var(--success-color);
    }
    
    .field-hint {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      font-style: italic;
    }
    
    input:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    
    button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    
    .field-group {
      margin-bottom: 12px;
    }
    
    .field-label {
      display: block;
      margin-bottom: 4px;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
    }
    
    .field-row {
      display: flex;
      gap: 8px;
    }
    
    input[type="text"],
    input[type="password"] {
      flex: 1;
      padding: 6px 10px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    
    input:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    
    button {
      padding: 6px 12px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 1px solid transparent;
      border-radius: 4px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    
    button.secondary {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-button-secondaryBackground);
    }
    
    button.secondary:hover {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    
    button.danger {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--error-color);
    }
    
    button.danger:hover {
      background: var(--error-color);
    }
    
    button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .button-group {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      flex-wrap: wrap;
    }
    
    .test-result {
      margin-top: 8px;
      padding: 8px;
      border-radius: 4px;
      font-size: 0.9em;
    }
    
    .test-success {
      background: rgba(76, 175, 80, 0.1);
      border: 1px solid var(--success-color);
      color: var(--success-color);
    }
    
    .test-error {
      background: rgba(244, 67, 54, 0.1);
      border: 1px solid var(--error-color);
      color: var(--error-color);
    }
    
    .test-testing {
      background: rgba(33, 150, 243, 0.1);
      border: 1px solid var(--vscode-focusBorder);
      color: var(--vscode-foreground);
    }
    
    .models-hint {
      margin-top: 8px;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }
    
    .toggle-visibility {
      background: transparent;
      border: none;
      padding: 4px;
      cursor: pointer;
      color: var(--vscode-foreground);
    }
    
    .toggle-visibility:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    
    .spinning {
      animation: spin 1s linear infinite;
    }
    
    /* Modal Styles */
    .modal {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }
    
    .modal-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border);
      border-radius: 8px;
      width: 90%;
      max-width: 600px;
      max-height: 80vh;
      display: flex;
      flex-direction: column;
    }
    
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    
    .modal-header h2 {
      margin: 0;
      font-size: 1.2em;
    }
    
    .close-btn {
      background: transparent;
      border: none;
      padding: 4px 8px;
      cursor: pointer;
      color: var(--vscode-foreground);
      font-size: 18px;
      line-height: 1;
      opacity: 0.7;
    }
    
    .close-btn:hover {
      opacity: 1;
    }
    
    .modal-body {
      padding: 16px;
      overflow-y: auto;
      flex: 1;
    }
    
    .modal-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 16px;
      border-top: 1px solid var(--vscode-widget-border);
    }
    
    /* Model Picker Modal */
    .model-picker-modal .modal-content {
      max-width: 700px;
      max-height: 85vh;
    }
    
    .model-search {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 12px;
      margin-bottom: 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-size: 14px;
    }
    
    .model-list {
      max-height: 400px;
      overflow-y: auto;
      border: 1px solid var(--vscode-widget-border);
      border-radius: 4px;
    }
    
    .model-item {
      display: flex;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-widget-border);
      cursor: pointer;
    }
    
    .model-item:last-child {
      border-bottom: none;
    }
    
    .model-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    
    .model-item input[type="checkbox"] {
      margin-right: 10px;
      width: 16px;
      height: 16px;
      cursor: pointer;
    }
    
    .model-item label {
      flex: 1;
      cursor: pointer;
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 13px;
    }
    
    .model-count {
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
    }
    
    .filter-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      flex-wrap: wrap;
      gap: 8px;
    }
    
    .select-actions {
      display: flex;
      gap: 8px;
    }
    
    .select-actions button {
      padding: 4px 8px;
      font-size: 12px;
    }
    
    .capability-filters {
      display: flex;
      gap: 12px;
    }
    
    .capability-filter {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    
    .capability-filter input {
      width: 14px;
      height: 14px;
      cursor: pointer;
    }
    
    .capability-filter .model-badge {
      cursor: pointer;
    }
    
    .no-models {
      padding: 20px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    
    .model-picker-modal .modal-footer {
      flex-direction: column;
      gap: 12px;
    }
    
    .save-targets {
      display: flex;
      gap: 16px;
      align-items: center;
    }
    
    .save-target-label {
      font-size: 13px;
      color: var(--vscode-descriptionForeground);
    }
    
    .save-target-option {
      display: flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      font-size: 13px;
    }
    
    .save-target-option input {
      width: 16px;
      height: 16px;
      cursor: pointer;
    }
    
    .footer-buttons {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    
    .model-badges {
      display: flex;
      gap: 4px;
      margin-left: auto;
    }
    
    .model-badge {
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 500;
    }
    
    .badge-vision {
      background: rgba(156, 39, 176, 0.2);
      color: #ce93d8;
    }
    
    .badge-tools {
      background: rgba(33, 150, 243, 0.2);
      color: #64b5f6;
    }
    
    .badge-user {
      background: rgba(33, 150, 243, 0.2);
      color: #64b5f6;
    }
    
    .badge-workspace {
      background: rgba(76, 175, 80, 0.2);
      color: var(--success-color);
    }
    
    .badge-pending {
      background: rgba(255, 193, 7, 0.2);
      color: #ffc107;
    }
    
    .model-item.selected-item {
      background: rgba(33, 150, 243, 0.1);
    }
    
    .model-item.previously-selected:not(.selected-item) {
      background: rgba(76, 175, 80, 0.05);
    }
    
    .model-item.other-scope {
      opacity: 0.6;
    }
    
    .model-item.other-scope input:disabled {
      cursor: not-allowed;
    }
    
    .disabled-label {
      color: var(--vscode-disabledForeground);
    }
    
    /* Export/Import Dropdown */
    .header-actions {
      display: flex;
      gap: 8px;
      align-items: center;
    }
    
    .dropdown {
      position: relative;
      display: inline-block;
    }
    
    .dropdown-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    
    .dropdown-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .dropdown-content {
      display: none;
      position: absolute;
      right: 0;
      top: 100%;
      margin-top: 4px;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      min-width: 220px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      z-index: 100;
    }
    
    .dropdown.open .dropdown-content {
      display: block;
    }
    
    .dropdown-section {
      padding: 4px 0;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    
    .dropdown-section:last-child {
      border-bottom: none;
    }
    
    .dropdown-section-title {
      padding: 6px 12px 4px;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      font-weight: 600;
    }
    
    .dropdown-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      cursor: pointer;
      font-size: 13px;
      color: var(--vscode-dropdown-foreground);
    }
    
    .dropdown-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    
    .dropdown-item i {
      width: 16px;
      text-align: center;
    }
    
    /* Settings Modal */
    .settings-modal .modal-content {
      max-width: 700px;
    }
    
    .settings-section {
      margin-bottom: 24px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--vscode-widget-border);
    }
    
    .settings-section:last-child {
      margin-bottom: 0;
      padding-bottom: 0;
      border-bottom: none;
    }
    
    .settings-section-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 12px;
      color: var(--vscode-foreground);
    }
    
    .settings-subsection {
      margin-left: 16px;
      margin-bottom: 16px;
    }
    
    .settings-subsection-title {
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    
    .settings-table {
      display: table;
      width: 100%;
      border-collapse: collapse;
    }
    
    .settings-table-row {
      display: table-row;
    }
    
    .settings-table-row:hover {
      background: var(--vscode-list-hoverBackground);
    }
    
    .settings-table-cell {
      display: table-cell;
      padding: 8px 12px;
      vertical-align: middle;
      font-size: 13px;
    }
    
    .settings-table-cell.label {
      width: 140px;
      color: var(--vscode-foreground);
    }
    
    .settings-table-cell.radios {
      white-space: nowrap;
    }
    
    .settings-table-cell.action {
      text-align: right;
      width: 120px;
    }
    
    .radio-group {
      display: inline-flex;
      gap: 16px;
      align-items: center;
    }
    
    .radio-label {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      cursor: pointer;
    }
    
    .radio-label input[type="radio"] {
      width: 14px;
      height: 14px;
      accent-color: var(--vscode-button-background);
      cursor: pointer;
      margin: 0;
    }
    
    .action-btn {
      padding: 4px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      white-space: nowrap;
    }
    
    .action-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .action-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    
    .gear-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 6px 10px;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    
    .gear-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    
    .scope-note {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="header-row">
    <h1><i class="codicon codicon-server-process"></i> Providers and Models</h1>
    <div class="header-actions">
      <button class="gear-btn" onclick="openSettingsModal()" title="Settings & Export/Import">
        <span class="codicon codicon-gear"></span>
      </button>
      <button class="refresh-all-btn" onclick="refreshAll()" title="Reload all providers">
        <i class="codicon codicon-refresh"></i> Refresh All
      </button>
    </div>
  </div>
  
  <!-- Settings Modal -->
  <div id="settings-modal" class="modal settings-modal" style="display: none;">
    <div class="modal-content">
      <div class="modal-header">
        <h2>Settings</h2>
        <button class="close-btn" onclick="closeSettingsModal()" title="Close">×</button>
      </div>
      <div class="modal-body">
        <!-- Configuration Source -->
        <div class="settings-section">
          <div class="settings-section-title">Configuration Source</div>
          <div class="settings-table">
            <div class="settings-table-row">
              <div class="settings-table-cell label">User settings</div>
              <div class="settings-table-cell radios">
                <div class="radio-group">
                  <label class="radio-label">
                    <input type="radio" name="config-user" value="vscode" onchange="updateConfigSourceScoped('user', 'vscode')">
                    VS Code
                  </label>
                  <label class="radio-label">
                    <input type="radio" name="config-user" value="native" onchange="updateConfigSourceScoped('user', 'native')">
                    OpenLLM
                  </label>
                </div>
              </div>
              <div class="settings-table-cell action">
                <button class="action-btn" id="import-config-user-btn" onclick="importConfig('user')">Import</button>
              </div>
            </div>
            <div class="settings-table-row">
              <div class="settings-table-cell label">Workspace settings</div>
              <div class="settings-table-cell radios">
                <div class="radio-group">
                  <label class="radio-label">
                    <input type="radio" name="config-workspace" value="vscode" onchange="updateConfigSourceScoped('workspace', 'vscode')">
                    VS Code
                  </label>
                  <label class="radio-label">
                    <input type="radio" name="config-workspace" value="native" onchange="updateConfigSourceScoped('workspace', 'native')">
                    OpenLLM
                  </label>
                  <label class="radio-label">
                    <input type="radio" name="config-workspace" value="" onchange="updateConfigSourceScoped('workspace', null)">
                    (inherit)
                  </label>
                </div>
              </div>
              <div class="settings-table-cell action">
                <button class="action-btn" id="import-config-workspace-btn" onclick="importConfig('workspace')">Import</button>
              </div>
            </div>
          </div>
          <div class="scope-note">Effective: <span id="effective-config-source">VS Code</span></div>
        </div>
        
        <!-- API Key Storage -->
        <div class="settings-section">
          <div class="settings-section-title">API Key Storage</div>
          
          <!-- User scope -->
          <div class="settings-subsection">
            <div class="settings-subsection-title">User</div>
            <div class="settings-table">
              <div class="settings-table-row">
                <div class="settings-table-cell label">Primary store</div>
                <div class="settings-table-cell radios">
                  <div class="radio-group">
                    <label class="radio-label">
                      <input type="radio" name="secrets-user" value="vscode" onchange="updateSecretsStoreScoped('user', 'vscode')">
                      VS Code
                    </label>
                    <label class="radio-label">
                      <input type="radio" name="secrets-user" value="keychain" onchange="updateSecretsStoreScoped('user', 'keychain')">
                      Keychain
                    </label>
                  </div>
                </div>
                <div class="settings-table-cell action">
                  <button class="action-btn" id="import-secrets-user-btn" onclick="importSecrets('user')">Import</button>
                </div>
              </div>
              <div class="settings-table-row">
                <div class="settings-table-cell label">Environment vars</div>
                <div class="settings-table-cell radios">
                  <div class="radio-group">
                    <label class="radio-label">
                      <input type="radio" name="env-user" value="true" onchange="updateCheckEnvScoped('user', true)">
                      enable
                    </label>
                    <label class="radio-label">
                      <input type="radio" name="env-user" value="false" onchange="updateCheckEnvScoped('user', false)">
                      disable
                    </label>
                  </div>
                </div>
                <div class="settings-table-cell action"></div>
              </div>
              <div class="settings-table-row">
                <div class="settings-table-cell label">.env files</div>
                <div class="settings-table-cell radios">
                  <div class="radio-group">
                    <label class="radio-label">
                      <input type="radio" name="dotenv-user" value="true" onchange="updateCheckDotEnvScoped('user', true)">
                      enable
                    </label>
                    <label class="radio-label">
                      <input type="radio" name="dotenv-user" value="false" onchange="updateCheckDotEnvScoped('user', false)">
                      disable
                    </label>
                  </div>
                </div>
                <div class="settings-table-cell action"></div>
              </div>
            </div>
          </div>
          
          <!-- Workspace scope -->
          <div class="settings-subsection">
            <div class="settings-subsection-title">Workspace</div>
            <div class="settings-table">
              <div class="settings-table-row">
                <div class="settings-table-cell label">Primary store</div>
                <div class="settings-table-cell radios">
                  <div class="radio-group">
                    <label class="radio-label">
                      <input type="radio" name="secrets-workspace" value="vscode" onchange="updateSecretsStoreScoped('workspace', 'vscode')">
                      VS Code
                    </label>
                    <label class="radio-label">
                      <input type="radio" name="secrets-workspace" value="keychain" onchange="updateSecretsStoreScoped('workspace', 'keychain')">
                      Keychain
                    </label>
                    <label class="radio-label">
                      <input type="radio" name="secrets-workspace" value="" onchange="updateSecretsStoreScoped('workspace', null)">
                      (inherit)
                    </label>
                  </div>
                </div>
                <div class="settings-table-cell action">
                  <button class="action-btn" id="import-secrets-workspace-btn" onclick="importSecrets('workspace')">Import</button>
                </div>
              </div>
              <div class="settings-table-row">
                <div class="settings-table-cell label">Environment vars</div>
                <div class="settings-table-cell radios">
                  <div class="radio-group">
                    <label class="radio-label">
                      <input type="radio" name="env-workspace" value="true" onchange="updateCheckEnvScoped('workspace', true)">
                      enable
                    </label>
                    <label class="radio-label">
                      <input type="radio" name="env-workspace" value="false" onchange="updateCheckEnvScoped('workspace', false)">
                      disable
                    </label>
                    <label class="radio-label">
                      <input type="radio" name="env-workspace" value="" onchange="updateCheckEnvScoped('workspace', null)">
                      (inherit)
                    </label>
                  </div>
                </div>
                <div class="settings-table-cell action"></div>
              </div>
              <div class="settings-table-row">
                <div class="settings-table-cell label">.env files</div>
                <div class="settings-table-cell radios">
                  <div class="radio-group">
                    <label class="radio-label">
                      <input type="radio" name="dotenv-workspace" value="true" onchange="updateCheckDotEnvScoped('workspace', true)">
                      enable
                    </label>
                    <label class="radio-label">
                      <input type="radio" name="dotenv-workspace" value="false" onchange="updateCheckDotEnvScoped('workspace', false)">
                      disable
                    </label>
                    <label class="radio-label">
                      <input type="radio" name="dotenv-workspace" value="" onchange="updateCheckDotEnvScoped('workspace', null)">
                      (inherit)
                    </label>
                  </div>
                </div>
                <div class="settings-table-cell action"></div>
              </div>
            </div>
          </div>
          <div class="scope-note">Effective: <span id="effective-secrets-store">Keychain</span></div>
        </div>
      </div>
    </div>
  </div>
  
  <!-- Model Picker Modal -->
  <div id="model-picker-modal" class="modal model-picker-modal" style="display: none;">
    <div class="modal-content">
      <div class="modal-header">
        <h2 id="model-picker-title">Select Models</h2>
        <button class="close-btn" onclick="closeModelPicker()">
          <i class="codicon codicon-close"></i>
        </button>
      </div>
      <div class="modal-body">
        <input type="text" class="model-search" id="model-search" placeholder="Filter models..." oninput="filterModels()">
        <div class="filter-row">
          <div class="select-actions">
            <button class="secondary" onclick="selectAllModels()">Select All</button>
            <button class="secondary" onclick="selectNoneModels()">Select None</button>
          </div>
          <div class="capability-filters">
            <label class="capability-filter">
              <input type="checkbox" id="filter-vision" onchange="filterModels()">
              <span class="model-badge badge-vision">Vision</span>
            </label>
            <label class="capability-filter">
              <input type="checkbox" id="filter-tools" onchange="filterModels()">
              <span class="model-badge badge-tools">Tools</span>
            </label>
          </div>
        </div>
        <div class="model-count" id="model-count">0 of 0 selected</div>
        <div class="model-list" id="model-list"></div>
      </div>
      <div class="modal-footer">
        <div class="save-targets">
          <span class="save-target-label">Save config to:</span>
          <label class="save-target-option">
            <input type="radio" name="save-target" id="save-to-user" value="user" checked onchange="onScopeChanged()"> 
            <span id="user-config-label">User</span>
          </label>
          <label class="save-target-option">
            <input type="radio" name="save-target" id="save-to-workspace" value="workspace" onchange="onScopeChanged()"> 
            <span id="workspace-config-label">Workspace</span>
          </label>
        </div>
        <div class="save-destination-info" id="save-destination-info" style="font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 4px;">
          <!-- Updated dynamically -->
        </div>
        <div class="footer-buttons">
          <button class="secondary" onclick="closeModelPicker()">Cancel</button>
          <button id="save-models-btn" onclick="saveSelectedModels()">
            <i class="codicon codicon-save"></i> Save
          </button>
        </div>
      </div>
    </div>
  </div>

  <div class="provider-grid" id="providers"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const providers = ${providersJson};
    
    // Initial status embedded at HTML generation time (eliminates round-trip)
    const providerStatus = ${initialStatusJson};
    
    // Settings state - initialized from embedded data
    let currentSettings = ${initialSettingsJson};
    
    // Settings Modal
    function openSettingsModal() {
      const modal = document.getElementById('settings-modal');
      modal.style.display = 'flex';
      updateSettingsModal();
    }
    
    function closeSettingsModal() {
      document.getElementById('settings-modal').style.display = 'none';
    }
    
    function updateSettingsModal() {
      // The currentSettings object now has scoped values:
      // configSourceUser, configSourceWorkspace, secretsStoreUser, secretsStoreWorkspace, etc.
      const s = currentSettings;
      
      // Configuration source radios
      setRadio('config-user', s.configSourceUser || 'vscode');
      setRadio('config-workspace', s.configSourceWorkspace || '');  // empty = inherit
      
      // Secrets store radios
      setRadio('secrets-user', s.secretsStoreUser || 'keychain');
      setRadio('secrets-workspace', s.secretsStoreWorkspace || '');
      
      // Environment vars radios
      setRadio('env-user', s.checkEnvUser === true ? 'true' : 'false');
      setRadio('env-workspace', s.checkEnvWorkspace === true ? 'true' : (s.checkEnvWorkspace === false ? 'false' : ''));
      
      // .env files radios
      setRadio('dotenv-user', s.checkDotEnvUser === true ? 'true' : 'false');
      setRadio('dotenv-workspace', s.checkDotEnvWorkspace === true ? 'true' : (s.checkDotEnvWorkspace === false ? 'false' : ''));
      
      // Update effective labels
      const effectiveConfig = s.configSourceWorkspace || s.configSourceUser || 'vscode';
      document.getElementById('effective-config-source').textContent = 
        effectiveConfig === 'native' ? 'OpenLLM config.yaml' : 'VS Code settings.json';
      
      const effectiveSecrets = s.secretsStoreWorkspace || s.secretsStoreUser || 'keychain';
      document.getElementById('effective-secrets-store').textContent = 
        effectiveSecrets === 'vscode' ? 'VS Code SecretStorage' : 'System Keychain';
      
      // Update import button labels based on current selection
      updateImportButtonLabel('import-config-user-btn', s.configSourceUser || 'vscode', 'config');
      updateImportButtonLabel('import-config-workspace-btn', s.configSourceWorkspace || s.configSourceUser || 'vscode', 'config');
      updateImportButtonLabel('import-secrets-user-btn', s.secretsStoreUser || 'keychain', 'secrets');
      updateImportButtonLabel('import-secrets-workspace-btn', s.secretsStoreWorkspace || s.secretsStoreUser || 'keychain', 'secrets');
    }
    
    function setRadio(name, value) {
      const radios = document.querySelectorAll('input[name="' + name + '"]');
      radios.forEach(r => { r.checked = r.value === value; });
    }
    
    function updateImportButtonLabel(btnId, currentSource, type) {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      
      if (type === 'config') {
        // If using vscode, offer to import FROM openllm; if using native, offer to import FROM vscode
        if (currentSource === 'native') {
          btn.textContent = 'Import from VS Code';
          btn.title = 'Copy providers from VS Code settings to OpenLLM YAML config';
        } else {
          btn.textContent = 'Import from OpenLLM';
          btn.title = 'Copy providers from OpenLLM YAML config to VS Code settings';
        }
      } else {
        // secrets
        if (currentSource === 'keychain') {
          btn.textContent = 'Import from VS Code';
          btn.title = 'Copy API keys from VS Code SecretStorage to System Keychain';
        } else {
          btn.textContent = 'Import from Keychain';
          btn.title = 'Copy API keys from System Keychain to VS Code SecretStorage';
        }
      }
    }
    
    // Scoped update functions
    function updateConfigSourceScoped(scope, value) {
      vscode.postMessage({ command: 'updateSettingScoped', key: 'config.source', scope: scope, value: value });
      if (scope === 'user') {
        currentSettings.configSourceUser = value;
      } else {
        currentSettings.configSourceWorkspace = value;
      }
      updateSettingsModal();
    }
    
    function updateSecretsStoreScoped(scope, value) {
      vscode.postMessage({ command: 'updateSettingScoped', key: 'secrets.primaryStore', scope: scope, value: value });
      if (scope === 'user') {
        currentSettings.secretsStoreUser = value;
      } else {
        currentSettings.secretsStoreWorkspace = value;
      }
      updateSettingsModal();
    }
    
    function updateCheckEnvScoped(scope, value) {
      vscode.postMessage({ command: 'updateSettingScoped', key: 'secrets.checkEnvironment', scope: scope, value: value });
      if (scope === 'user') {
        currentSettings.checkEnvUser = value;
      } else {
        currentSettings.checkEnvWorkspace = value;
      }
    }
    
    function updateCheckDotEnvScoped(scope, value) {
      vscode.postMessage({ command: 'updateSettingScoped', key: 'secrets.checkDotEnv', scope: scope, value: value });
      if (scope === 'user') {
        currentSettings.checkDotEnvUser = value;
      } else {
        currentSettings.checkDotEnvWorkspace = value;
      }
    }
    
    function importConfig(scope) {
      vscode.postMessage({ command: 'importConfig', scope: scope });
    }
    
    function importSecrets(scope) {
      vscode.postMessage({ command: 'importSecrets', scope: scope });
    }
    
    function runCommand(command) {
      vscode.postMessage({ command: 'runVSCodeCommand', vsCodeCommand: command });
    }
    
    function runCommandWithArg(command, arg) {
      vscode.postMessage({ command: 'runVSCodeCommand', vsCodeCommand: command, arg: arg });
    }
    
    // Close settings modal on click outside
    document.getElementById('settings-modal').addEventListener('click', function(e) {
      if (e.target === this) {
        closeSettingsModal();
      }
    });
    
    function renderProviders() {
      const container = document.getElementById('providers');
      container.innerHTML = providers.map(p => renderProvider(p)).join('');
    }
    
    function renderProvider(provider) {
      const status = providerStatus[provider.id] || { hasApiKey: false, keySource: 'none', enabled: true, hasModels: false };
      const isEnabled = status.enabled !== false;
      const isConfigured = status.hasApiKey && status.hasModels;
      
      // Determine status badge
      let statusClass = 'status-missing';
      let statusText = '⚠ Not configured';
      let sourceHint = '';
      
      if (!isEnabled) {
        statusClass = 'status-disabled';
        statusText = '○ Disabled';
      } else if (isConfigured) {
        statusClass = 'status-configured';
        if (status.keySource === 'environment') {
          statusText = '✓ Enabled (ENV)';
          sourceHint = \`Found in \${status.envVarName || 'environment variable'}\`;
        } else if (status.keySource === 'dotenv') {
          statusText = '✓ Enabled (.env)';
          sourceHint = \`Found in .env file (\${status.envVarName || 'variable'})\`;
        } else if (status.keySource === 'secretStorage') {
          statusText = '✓ Enabled';
          sourceHint = 'Stored in VS Code SecretStorage';
        } else if (status.keySource === 'keychain') {
          statusText = '✓ Enabled (Keychain)';
          sourceHint = 'Stored in system keychain';
        } else if (!provider.requiresApiKey) {
          statusText = '✓ Enabled';
        }
      } else if (status.hasApiKey && !status.hasModels) {
        statusClass = 'status-missing';
        statusText = '⚠ No models';
      } else if (!provider.requiresApiKey) {
        statusClass = status.hasModels ? 'status-configured' : 'status-missing';
        statusText = status.hasModels ? '✓ Enabled' : '⚠ No models';
      }
      
      let fieldsHtml = '';
      
      // API Key field
      if (provider.requiresApiKey) {
        const keySourceBadge = status.keySource === 'environment' 
          ? \`<span class="key-source-badge env-badge" title="\${sourceHint}">ENV: \${status.envVarName || '?'}</span>\`
          : (status.keySource === 'secretStorage' 
              ? '<span class="key-source-badge storage-badge" title="Stored securely">Saved</span>' 
              : '');
        
        fieldsHtml += \`
          <div class="field-group">
            <label class="field-label">API Key \${keySourceBadge}</label>
            <div class="field-row">
              <input type="password" id="apikey-\${provider.id}" 
                placeholder="\${status.keySource === 'environment' ? 'Using ' + (status.envVarName || 'env var') : 'Enter API key...'}" 
                value="\${status.hasApiKey && (status.keySource === 'secretStorage' || status.keySource === 'keychain') ? '••••••••••••••••' : ''}"
                \${status.keySource === 'environment' ? 'disabled' : ''} />
              <button class="toggle-visibility" onclick="toggleVisibility('\${provider.id}')" \${status.keySource === 'environment' ? 'disabled' : ''}>
                <i class="codicon codicon-eye"></i>
              </button>
            </div>
            \${status.keySource === 'environment' ? '<div class="field-hint">Key detected from environment variable. To override, set the variable to a new value or delete it.</div>' : ''}
          </div>
        \`;
      }
      
      // Base URL field
      if (provider.hasBaseUrl) {
        fieldsHtml += \`
          <div class="field-group">
            <label class="field-label">Base URL</label>
            <input type="text" id="baseurl-\${provider.id}" 
              placeholder="\${provider.defaultBaseUrl || 'https://...'}" 
              value="\${status.baseUrl || provider.defaultBaseUrl || ''}" />
          </div>
        \`;
      }
      
      // Extra fields (Azure deployment, etc.)
      if (provider.extraFields) {
        for (const field of provider.extraFields) {
          const value = status.extraFields?.[field.id] || '';
          fieldsHtml += \`
            <div class="field-group">
              <label class="field-label">\${field.label}</label>
              <input type="\${field.type || 'text'}" id="extra-\${provider.id}-\${field.id}" 
                placeholder="\${field.placeholder || ''}" 
                value="\${value}" />
            </div>
          \`;
        }
      }
      
      const disabledAttr = isEnabled ? '' : 'disabled';
      const disabledClass = isEnabled ? '' : 'provider-disabled';
      
      // Build info tooltip content
      const infoContent = \`Config: \${status.configSourceDetail || 'VS Code settings'}\\nAPI Key: \${status.keySourceDetail || 'Not configured'}\`;
      
      return \`
        <div class="provider-card \${disabledClass}" id="card-\${provider.id}">
          <div class="provider-header">
            <div class="provider-name-row">
              <label class="enabled-checkbox" title="\${isEnabled ? 'Uncheck to disable' : 'Check to enable'}">
                <input type="checkbox" \${isEnabled ? 'checked' : ''} onchange="toggleEnabled('\${provider.id}', this.checked)" />
                <span class="provider-name">\${provider.name}</span>
              </label>
              <button class="info-btn" onclick="showProviderInfo('\${provider.id}')" title="Show source info">
                <i class="codicon codicon-info"></i>
              </button>
            </div>
            <span class="status-badge \${statusClass}">\${statusText}</span>
          </div>
          <div class="provider-info-panel" id="info-panel-\${provider.id}" style="display: none;">
            <div class="info-row"><span class="info-label">Config source:</span> <span class="info-value">\${status.configSourceDetail || 'VS Code settings'}</span></div>
            <div class="info-row"><span class="info-label">API key source:</span> <span class="info-value">\${status.keySourceDetail || 'Not configured'}</span></div>
            \${status.baseUrl ? \`<div class="info-row"><span class="info-label">Base URL:</span> <span class="info-value">\${status.baseUrl}</span></div>\` : ''}
          </div>
          <div class="provider-body \${isEnabled ? '' : 'body-disabled'}">
            \${fieldsHtml}
            <div class="button-group">
              <button onclick="configureProvider('\${provider.id}')" title="Test connection, select models, and save" \${disabledAttr}>
                <i class="codicon codicon-settings-gear"></i> Configure...
              </button>
              <button onclick="refreshProvider('\${provider.id}')" title="Refresh">
                <i class="codicon codicon-refresh"></i>
              </button>
              \${provider.requiresApiKey ? \`
                <button class="danger" onclick="deleteApiKey('\${provider.id}')" title="Delete API key" \${disabledAttr}>
                  <i class="codicon codicon-trash"></i>
                </button>
              \` : ''}
            </div>
            <div id="test-result-\${provider.id}"></div>
          </div>
        </div>
      \`;
    }
    
    function toggleVisibility(providerId) {
      const input = document.getElementById('apikey-' + providerId);
      input.type = input.type === 'password' ? 'text' : 'password';
    }
    
    function showProviderInfo(providerId) {
      const panel = document.getElementById('info-panel-' + providerId);
      if (panel) {
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      }
    }
    
    function toggleEnabled(providerId, enabled) {
      vscode.postMessage({ command: 'toggleEnabled', providerId, enabled });
    }
    
    function saveProvider(providerId, target) {
      const provider = providers.find(p => p.id === providerId);
      
      if (provider.requiresApiKey) {
        const apiKeyInput = document.getElementById('apikey-' + providerId);
        const apiKey = apiKeyInput.value;
        if (apiKey && !apiKey.startsWith('••')) {
          vscode.postMessage({ command: 'saveApiKey', providerId, apiKey, target });
        }
      }
      
      if (provider.hasBaseUrl) {
        const baseUrlInput = document.getElementById('baseurl-' + providerId);
        if (baseUrlInput.value) {
          vscode.postMessage({ command: 'saveBaseUrl', providerId, baseUrl: baseUrlInput.value, target });
        }
      }
      
      if (provider.extraFields) {
        for (const field of provider.extraFields) {
          const input = document.getElementById('extra-' + providerId + '-' + field.id);
          if (input.value) {
            vscode.postMessage({ command: 'saveExtraField', providerId, fieldId: field.id, value: input.value });
          }
        }
      }
    }
    
    function saveProviderWithPicker(providerId) {
      const provider = providers.find(p => p.id === providerId);
      
      // Gather current values from form
      let apiKey = null;
      let baseUrl = null;
      const extraFields = {};
      
      if (provider.requiresApiKey) {
        const apiKeyInput = document.getElementById('apikey-' + providerId);
        const val = apiKeyInput.value;
        if (val && !val.startsWith('••')) {
          apiKey = val;
        }
      }
      
      if (provider.hasBaseUrl) {
        const baseUrlInput = document.getElementById('baseurl-' + providerId);
        if (baseUrlInput.value) {
          baseUrl = baseUrlInput.value;
        }
      }
      
      if (provider.extraFields) {
        for (const field of provider.extraFields) {
          const input = document.getElementById('extra-' + providerId + '-' + field.id);
          if (input.value) {
            extraFields[field.id] = input.value;
          }
        }
      }
      
      // Ask extension to show QuickPick with save options
      vscode.postMessage({ 
        command: 'showSavePicker', 
        providerId, 
        apiKey, 
        baseUrl, 
        extraFields 
      });
    }
    
    function configureProvider(providerId) {
      const provider = providers.find(p => p.id === providerId);
      
      // Gather current values from form
      let apiKey = null;
      let baseUrl = null;
      const extraFields = {};
      
      if (provider.requiresApiKey) {
        const apiKeyInput = document.getElementById('apikey-' + providerId);
        const val = apiKeyInput.value;
        if (val && !val.startsWith('••')) {
          apiKey = val;
        }
      }
      
      if (provider.hasBaseUrl) {
        const baseUrlInput = document.getElementById('baseurl-' + providerId);
        if (baseUrlInput.value) {
          baseUrl = baseUrlInput.value;
        }
      }
      
      if (provider.extraFields) {
        for (const field of provider.extraFields) {
          const input = document.getElementById('extra-' + providerId + '-' + field.id);
          if (input && input.value) {
            extraFields[field.id] = input.value;
          }
        }
      }
      
      // Show testing indicator
      const resultEl = document.getElementById('test-result-' + providerId);
      resultEl.innerHTML = '<div class="test-result test-testing"><i class="codicon codicon-sync spinning"></i> Connecting and fetching models...</div>';
      
      // Ask extension to configure (test + show models + save)
      vscode.postMessage({ 
        command: 'configureProvider', 
        providerId, 
        apiKey, 
        baseUrl, 
        extraFields 
      });
    }
    
    function testConnection(providerId) {
      const resultEl = document.getElementById('test-result-' + providerId);
      resultEl.innerHTML = '<div class="test-result test-testing"><i class="codicon codicon-sync spinning"></i> Fetching models...</div>';
      vscode.postMessage({ command: 'testConnection', providerId });
    }
    
    function deleteApiKey(providerId) {
      vscode.postMessage({ command: 'deleteApiKey', providerId });
    }
    
    function refreshProvider(providerId) {
      vscode.postMessage({ command: 'refreshProvider', providerId });
    }
    
    function refreshAll() {
      vscode.postMessage({ command: 'refreshAll' });
    }
    
    // Model Picker State
    let currentPickerProvider = null;
    let allModels = []; // Array of {id, name?, vision?, tools?}
    let selectedModels = new Set();
    let previouslySelectedModels = new Set(); // Track original state for change detection
    let userModelsSet = new Set();
    let workspaceModelsSet = new Set();
    let apiKeyWasAdded = false; // Track if API key was just added
    let currentSaveDestinations = {
      userConfig: 'User Settings',
      workspaceConfig: 'Workspace Settings',
      keyStore: 'VS Code SecretStorage'
    };
    
    function openModelPicker(providerId, models, userModels, workspaceModels, saveDestinations, keyWasAdded) {
      currentPickerProvider = providerId;
      apiKeyWasAdded = !!keyWasAdded;
      
      // Handle both old format (string[]) and new format ({id, name, vision, tools}[])
      allModels = (models || []).map(m => typeof m === 'string' ? { id: m } : m);
      
      // Store save destinations
      if (saveDestinations) {
        currentSaveDestinations = saveDestinations;
      }
      
      // Update labels with actual destinations
      document.getElementById('user-config-label').textContent = currentSaveDestinations.userConfig;
      document.getElementById('workspace-config-label').textContent = currentSaveDestinations.workspaceConfig;
      updateSaveDestinationDisplay();
      
      // Track which models are in user vs workspace settings
      // Normalize to string IDs (handle possible object/string mix from corrupted configs)
      const normalizeModelId = m => typeof m === 'string' ? m : (m && m.id ? m.id : String(m));
      userModelsSet = new Set((userModels || []).map(normalizeModelId));
      workspaceModelsSet = new Set((workspaceModels || []).map(normalizeModelId));
      
      const provider = providers.find(p => p.id === providerId);
      document.getElementById('model-picker-title').textContent = 
        \`Select Models - \${provider?.name || providerId}\`;
      
      // Set radio button - default to User, unless only Workspace has models
      const editingWorkspace = workspaceModelsSet.size > 0 && userModelsSet.size === 0;
      if (editingWorkspace) {
        document.getElementById('save-to-workspace').checked = true;
        selectedModels = new Set(workspaceModelsSet);
        previouslySelectedModels = new Set(workspaceModelsSet);
      } else {
        document.getElementById('save-to-user').checked = true;
        selectedModels = new Set(userModelsSet);
        previouslySelectedModels = new Set(userModelsSet);
      }
      
      document.getElementById('model-search').value = '';
      sortAndRenderModels();
      updateModelCount();
      
      document.getElementById('model-picker-modal').style.display = 'flex';
    }
    
    function sortAndRenderModels() {
      const showUser = document.getElementById('save-to-user').checked;
      const showWorkspace = document.getElementById('save-to-workspace').checked;
      
      // Sort models: configured models first (based on checked filters), then alphabetically
      const sorted = [...allModels].sort((a, b) => {
        const aInUser = userModelsSet.has(a.id);
        const bInUser = userModelsSet.has(b.id);
        const aInWorkspace = workspaceModelsSet.has(a.id);
        const bInWorkspace = workspaceModelsSet.has(b.id);
        
        // Priority: models matching current filter first
        const aRelevant = (showUser && aInUser) || (showWorkspace && aInWorkspace);
        const bRelevant = (showUser && bInUser) || (showWorkspace && bInWorkspace);
        
        if (aRelevant && !bRelevant) return -1;
        if (!aRelevant && bRelevant) return 1;
        
        return a.id.localeCompare(b.id);
      });
      
      renderModelList(sorted);
    }
    
    function closeModelPicker() {
      document.getElementById('model-picker-modal').style.display = 'none';
      currentPickerProvider = null;
      allModels = [];
      selectedModels.clear();
      previouslySelectedModels.clear();
    }
    
    function updateSaveDestinationDisplay() {
      const isUser = document.getElementById('save-to-user').checked;
      const configDest = isUser ? currentSaveDestinations.userConfig : currentSaveDestinations.workspaceConfig;
      const keyDest = currentSaveDestinations.keyStore;
      
      const infoEl = document.getElementById('save-destination-info');
      infoEl.innerHTML = \`Config → <strong>\${configDest}</strong> · API key → <strong>\${keyDest}</strong>\`;
    }
    
    function onScopeChanged() {
      // When user switches between User/Workspace, reset selection to that scope's models
      const isUser = document.getElementById('save-to-user').checked;
      
      if (isUser) {
        selectedModels = new Set(userModelsSet);
        previouslySelectedModels = new Set(userModelsSet);
      } else {
        selectedModels = new Set(workspaceModelsSet);
        previouslySelectedModels = new Set(workspaceModelsSet);
      }
      
      // Re-render with new selection
      sortAndRenderModels();
      updateModelCount();
      updateSaveDestinationDisplay();
    }
    
    function renderModelList(models) {
      const container = document.getElementById('model-list');
      const editingUser = document.getElementById('save-to-user').checked;
      const editingWorkspace = document.getElementById('save-to-workspace').checked;
      
      if (models.length === 0) {
        container.innerHTML = '<div class="no-models">No models available</div>';
        return;
      }
      
      // Sort: selected models first, then configured, then alphabetically
      const sorted = [...models].sort((a, b) => {
        const aSelected = selectedModels.has(a.id);
        const bSelected = selectedModels.has(b.id);
        const aInUser = userModelsSet.has(a.id);
        const bInUser = userModelsSet.has(b.id);
        const aInWorkspace = workspaceModelsSet.has(a.id);
        const bInWorkspace = workspaceModelsSet.has(b.id);
        
        // Selected models first
        if (aSelected && !bSelected) return -1;
        if (!aSelected && bSelected) return 1;
        
        // Then configured models
        const aConfigured = aInUser || aInWorkspace;
        const bConfigured = bInUser || bInWorkspace;
        if (aConfigured && !bConfigured) return -1;
        if (!aConfigured && bConfigured) return 1;
        
        // Then alphabetically
        return a.id.localeCompare(b.id);
      });
      
      container.innerHTML = sorted.map(model => {
        const modelId = model.id;
        const safeId = modelId.replace(/[^a-zA-Z0-9]/g, '-');
        const isSelected = selectedModels.has(modelId);
        const inUser = userModelsSet.has(modelId);
        const inWorkspace = workspaceModelsSet.has(modelId);
        
        // Track if model is configured in either scope (for visual indication)
        const isConfigured = inUser || inWorkspace;
        
        // Track if model is in the "other" scope (for informational badge, not disabled)
        const isOtherScope = (editingUser && inWorkspace && !inUser) || 
                             (editingWorkspace && inUser && !inWorkspace);
        
        // Check if this is a newly selected model (pending - not yet saved to current scope)
        const isPending = isSelected && 
                          ((editingUser && !inUser) || (editingWorkspace && !inWorkspace));
        
        let badges = '';
        if (isPending) {
          badges += '<span class="model-badge badge-pending">Pending</span>';
        }
        if (inUser) {
          badges += '<span class="model-badge badge-user">User</span>';
        }
        if (inWorkspace) {
          badges += '<span class="model-badge badge-workspace">Workspace</span>';
        }
        if (model.vision) {
          badges += '<span class="model-badge badge-vision">Vision</span>';
        }
        if (model.tools) {
          badges += '<span class="model-badge badge-tools">Tools</span>';
        }
        
        return \`
          <div class="model-item \${isSelected ? 'selected-item' : ''} \${isConfigured ? 'previously-selected' : ''} \${isOtherScope ? 'other-scope' : ''}">
            <input type="checkbox" id="model-\${safeId}" 
                   value="\${modelId}" 
                   \${isSelected ? 'checked' : ''}
                   onchange="toggleModel('\${modelId}', this.checked)">
            <label for="model-\${safeId}">\${modelId}</label>
            <div class="model-badges">\${badges}</div>
          </div>
        \`;
      }).join('');
    }
    
    function toggleModel(modelId, checked) {
      if (checked) {
        selectedModels.add(modelId);
      } else {
        selectedModels.delete(modelId);
      }
      // Re-render to update sorting (selected items move to top)
      filterModels();
      updateModelCount();
    }
    
    function updateModelCount() {
      const editingUser = document.getElementById('save-to-user').checked;
      const target = editingUser ? 'User' : 'Workspace';
      document.getElementById('model-count').textContent = 
        \`\${selectedModels.size} of \${allModels.length} selected for \${target}\`;
      
      // Enable save button if:
      // 1. API key was just added, OR
      // 2. Models have changed from original state
      const originalSet = editingUser ? userModelsSet : workspaceModelsSet;
      const hasModelChanges = !setsEqual(selectedModels, originalSet);
      const canSave = apiKeyWasAdded || hasModelChanges;
      document.getElementById('save-models-btn').disabled = !canSave;
      
      // Update button text to reflect what will be saved
      const btn = document.getElementById('save-models-btn');
      if (apiKeyWasAdded && !hasModelChanges) {
        btn.innerHTML = '<i class="codicon codicon-save"></i> Save API Key';
      } else if (apiKeyWasAdded && hasModelChanges) {
        btn.innerHTML = '<i class="codicon codicon-save"></i> Save All';
      } else {
        btn.innerHTML = '<i class="codicon codicon-save"></i> Save Models';
      }
    }
    
    function setsEqual(a, b) {
      if (a.size !== b.size) return false;
      for (const item of a) {
        if (!b.has(item)) return false;
      }
      return true;
    }
    
    function filterModels() {
      const search = document.getElementById('model-search').value.toLowerCase();
      const showUser = document.getElementById('save-to-user').checked;
      const showWorkspace = document.getElementById('save-to-workspace').checked;
      const filterVision = document.getElementById('filter-vision').checked;
      const filterTools = document.getElementById('filter-tools').checked;
      
      let filtered = allModels.filter(m => {
        // Text search
        if (!m.id.toLowerCase().includes(search)) return false;
        
        // Capability filters (if checked, model must have that capability)
        if (filterVision && !m.vision) return false;
        if (filterTools && !m.tools) return false;
        
        return true;
      });
      
      // Sort: configured models first (matching current scope filter), then alphabetically
      filtered.sort((a, b) => {
        const aInUser = userModelsSet.has(a.id);
        const bInUser = userModelsSet.has(b.id);
        const aInWorkspace = workspaceModelsSet.has(a.id);
        const bInWorkspace = workspaceModelsSet.has(b.id);
        
        const aRelevant = (showUser && aInUser) || (showWorkspace && aInWorkspace);
        const bRelevant = (showUser && bInUser) || (showWorkspace && bInWorkspace);
        
        if (aRelevant && !bRelevant) return -1;
        if (!aRelevant && bRelevant) return 1;
        
        return a.id.localeCompare(b.id);
      });
      
      renderModelList(filtered);
      updateFilteredCount(filtered.length);
    }
    
    function updateFilteredCount(filteredCount) {
      const countEl = document.getElementById('model-count');
      if (filteredCount < allModels.length) {
        countEl.textContent = \`\${selectedModels.size} selected, showing \${filteredCount} of \${allModels.length}\`;
      } else {
        countEl.textContent = \`\${selectedModels.size} of \${allModels.length} selected\`;
      }
    }
    
    function onTargetCheckboxChange() {
      // When switching scope, update selection to match the new scope's current models
      const editingUser = document.getElementById('save-to-user').checked;
      
      // Reset selection to current scope's models
      selectedModels.clear();
      if (editingUser) {
        userModelsSet.forEach(id => selectedModels.add(id));
      } else {
        workspaceModelsSet.forEach(id => selectedModels.add(id));
      }
      
      filterModels();
      updateModelCount();
    }
    
    function getFilteredModels() {
      const search = document.getElementById('model-search').value.toLowerCase();
      const filterVision = document.getElementById('filter-vision').checked;
      const filterTools = document.getElementById('filter-tools').checked;
      
      return allModels.filter(m => {
        if (!m.id.toLowerCase().includes(search)) return false;
        if (filterVision && !m.vision) return false;
        if (filterTools && !m.tools) return false;
        return true;
      });
    }
    
    function selectAllModels() {
      const filtered = getFilteredModels();
      filtered.forEach(m => selectedModels.add(m.id));
      filterModels();
      updateModelCount();
    }
    
    function selectNoneModels() {
      selectedModels.clear();
      filterModels();
      updateModelCount();
    }
    
    function saveSelectedModels() {
      const target = document.getElementById('save-to-user').checked ? 'user' : 'workspace';
      
      // Ensure we only send string IDs, not full model objects
      // (handles case where userModels/workspaceModels might have been corrupted)
      const modelIds = Array.from(selectedModels).map(m => 
        typeof m === 'string' ? m : (m && m.id ? m.id : String(m))
      );
      
      vscode.postMessage({ 
        command: 'saveSelectedModels', 
        providerId: currentPickerProvider,
        models: modelIds,
        target: target
      });
      
      closeModelPicker();
    }
    
    function openModelPickerFromData(providerId) {
      const data = window['_pickerData_' + providerId];
      if (data) {
        openModelPicker(providerId, data.models, data.userModels, data.workspaceModels, data.saveDestinations, data.apiKeyWasAdded);
      }
    }
    
    window.addEventListener('message', event => {
      const message = event.data;
      
      if (message.command === 'status') {
        Object.assign(providerStatus, message.status);
        if (message.settings) {
          currentSettings = message.settings;
        }
        renderProviders();
        // Also update settings modal if it's open
        const settingsModal = document.getElementById('settings-modal');
        if (settingsModal && settingsModal.style.display !== 'none') {
          updateSettingsModal();
        }
      } else if (message.command === 'testResult') {
        const resultEl = document.getElementById('test-result-' + message.providerId);
        if (message.status === 'success') {
          const models = message.models || [];
          const userModels = message.userModels || [];
          const workspaceModels = message.workspaceModels || [];
          
          let html = \`<div class="test-result test-success"><i class="codicon codicon-check"></i> \${message.message}</div>\`;
          
          // Show model picker button if models were fetched
          if (models.length > 0) {
            // Store data for the picker (including save destinations and API key status)
            window['_pickerData_' + message.providerId] = { 
              models, 
              userModels, 
              workspaceModels, 
              saveDestinations: message.saveDestinations,
              apiKeyWasAdded: message.apiKeyWasAdded || false
            };
            
            html += \`
              <div class="model-actions" style="margin-top: 8px;">
                <button onclick="openModelPickerFromData('\${message.providerId}')">
                  <i class="codicon codicon-list-selection"></i> Select Models...
                </button>
              </div>
            \`;
          }
          resultEl.innerHTML = html;
        } else if (message.status === 'error') {
          resultEl.innerHTML = \`<div class="test-result test-error"><i class="codicon codicon-error"></i> \${message.message}</div>\`;
        } else if (message.status === 'testing') {
          resultEl.innerHTML = '<div class="test-result test-testing"><i class="codicon codicon-sync spinning"></i> Fetching models...</div>';
        }
      }
    });
    
    // Initial render - status is already embedded in HTML, no need to request
    renderProviders();
    
    // Listen for target checkbox changes - re-sort and update count
    document.getElementById('save-to-user').addEventListener('change', onTargetCheckboxChange);
    document.getElementById('save-to-workspace').addEventListener('change', onTargetCheckboxChange);
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    ApiKeyPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
