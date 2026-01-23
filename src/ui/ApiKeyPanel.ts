import * as vscode from 'vscode';
import { getLogger } from '../utils/logger';
import { SecretResolver, ApiKeySource } from '../config/SecretResolver';

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
 */
export class ApiKeyPanel {
  public static currentPanel: ApiKeyPanel | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _context: vscode.ExtensionContext;
  private readonly _secretResolver: SecretResolver;
  private _disposables: vscode.Disposable[] = [];
  private readonly _logger = getLogger();

  public static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (ApiKeyPanel.currentPanel) {
      ApiKeyPanel.currentPanel._panel.reveal(column);
      ApiKeyPanel.currentPanel._update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'openLLMApiKeys',
      'Open LLM: Providers and Models',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
        ]
      }
    );

    ApiKeyPanel.currentPanel = new ApiKeyPanel(panel, context);
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._extensionUri = context.extensionUri;
    this._context = context;
    
    // Create SecretResolver with SecretStorage configured
    this._secretResolver = new SecretResolver();
    this._secretResolver.setSecretStorage(context.secrets);
    // Load env files
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this._secretResolver.loadStandardEnvFiles(workspacePath);

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

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
        }
      },
      null,
      this._disposables
    );
  }

  private async _saveApiKey(providerId: string, apiKey: string, target: 'user' | 'workspace' = 'user'): Promise<void> {
    const secretKey = `openllm.${providerId}.apiKey`;
    try {
      await this._context.secrets.store(secretKey, apiKey);
      this._logger.info(`Saved API key for ${providerId}`);
      
      // Also register the provider with its default models in VS Code settings
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
   * Register a provider and its models in VS Code settings
   * 
   * Note: API keys are NOT stored in settings - they go in SecretStorage only.
   * Settings only contain: provider name, optional base URL, and model list.
   * 
   * Models are sourced from:
   * 1. Fetched from provider API (if test was run)
   * 2. Default models from PROVIDERS config
   */
  private async _registerProviderModels(providerId: string, target: 'user' | 'workspace' = 'user'): Promise<void> {
    const providerDef = PROVIDERS.find(p => p.id === providerId);
    const modelsToRegister = this._getProviderModels(providerId);
    
    if (modelsToRegister.length === 0) {
      this._logger.debug(`No models to register for provider ${providerId}`);
      return;
    }

    const configTarget = target === 'workspace' 
      ? vscode.ConfigurationTarget.Workspace 
      : vscode.ConfigurationTarget.Global;

    const config = vscode.workspace.getConfiguration('openLLM');
    const providers = config.get<Array<{ 
      name: string; 
      apiBase?: string; 
      models: string[] 
    }>>('providers', []);

    const existingIndex = providers.findIndex(p => p.name.toLowerCase() === providerId.toLowerCase());

    if (existingIndex >= 0) {
      // Update existing - merge models, preserve base URL if already set
      const existing = providers[existingIndex];
      const existingModels = new Set(existing.models || []);
      for (const model of modelsToRegister) {
        existingModels.add(model);
      }
      providers[existingIndex] = {
        name: providerId,
        apiBase: existing.apiBase || providerDef?.defaultBaseUrl,
        models: Array.from(existingModels)
      };
    } else {
      // New provider - include base URL
      providers.push({
        name: providerId,
        apiBase: providerDef?.defaultBaseUrl,
        models: modelsToRegister
      });
    }

    await config.update('providers', providers, configTarget);
    this._logger.info(`Registered ${modelsToRegister.length} models for ${providerId} (${target})`);
  }

  private async _saveBaseUrl(providerId: string, baseUrl: string, target: 'user' | 'workspace' = 'user'): Promise<void> {
    const configTarget = target === 'workspace' 
      ? vscode.ConfigurationTarget.Workspace 
      : vscode.ConfigurationTarget.Global;

    const config = vscode.workspace.getConfiguration('openLLM');
    const providers = config.get<Array<{ name: string; apiBase?: string; models?: string[] }>>('providers', []);
    
    const existingIndex = providers.findIndex(p => p.name.toLowerCase() === providerId);
    if (existingIndex >= 0) {
      providers[existingIndex].apiBase = baseUrl;
    } else {
      providers.push({ name: providerId, apiBase: baseUrl, models: [] });
    }
    
    await config.update('providers', providers, configTarget);
    this._logger.info(`Saved base URL for ${providerId}: ${baseUrl}`);
    await this._sendStatus();
  }

  private async _saveExtraField(providerId: string, fieldId: string, value: string): Promise<void> {
    const key = `openllm.${providerId}.${fieldId}`;
    await this._context.globalState.update(key, value);
    this._logger.info(`Saved ${fieldId} for ${providerId}`);
    await this._sendStatus();
  }

  private async _deleteApiKey(providerId: string): Promise<void> {
    const secretKey = `openllm.${providerId}.apiKey`;
    try {
      await this._context.secrets.delete(secretKey);
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
    // Reload env files in case they changed
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    this._secretResolver.clear();
    this._secretResolver.loadStandardEnvFiles(workspacePath);
    
    await this._sendStatus();
    await vscode.commands.executeCommand('openLLM.reloadConfig');
  }

  /**
   * Toggle enabled state for a provider
   */
  private async _toggleEnabled(providerId: string, enabled: boolean): Promise<void> {
    const config = vscode.workspace.getConfiguration('openLLM');
    const providers = config.get<Array<{ 
      name: string; 
      enabled?: boolean;
      apiBase?: string; 
      models: string[] 
    }>>('providers', []);

    const providerDef = PROVIDERS.find(p => p.id === providerId);
    const existingIndex = providers.findIndex(
      p => p.name.toLowerCase() === providerId.toLowerCase()
    );

    if (existingIndex >= 0) {
      // Update existing provider
      providers[existingIndex].enabled = enabled;
    } else if (enabled) {
      // Adding a new provider - enabled with default config
      providers.push({
        name: providerId,
        enabled: true,
        apiBase: providerDef?.defaultBaseUrl,
        models: providerDef?.models || []
      });
    }
    // If disabling and not in settings, nothing to do

    await config.update('providers', providers, vscode.ConfigurationTarget.Global);
    this._logger.info(`Provider ${providerId} ${enabled ? 'enabled' : 'disabled'}`);

    await this._sendStatus();
    await vscode.commands.executeCommand('openLLM.reloadConfig');
  }

  /**
   * Save user-selected models for a provider
   */
  private async _saveSelectedModels(
    providerId: string, 
    models: string[], 
    target: 'user' | 'workspace' = 'user'
  ): Promise<void> {
    // Allow empty models array - user may want to remove all models
    const modelList = models || [];

    const providerDef = PROVIDERS.find(p => p.id === providerId);
    const configTarget = target === 'workspace' 
      ? vscode.ConfigurationTarget.Workspace 
      : vscode.ConfigurationTarget.Global;

    const config = vscode.workspace.getConfiguration('openLLM');
    const providers = config.get<Array<{ 
      name: string; 
      apiBase?: string; 
      models: string[] 
    }>>('providers', []);

    const existingIndex = providers.findIndex(p => p.name.toLowerCase() === providerId.toLowerCase());

    if (existingIndex >= 0) {
      // Update existing - replace models entirely with selection
      providers[existingIndex].models = modelList;
    } else if (modelList.length > 0) {
      // New provider - only add if there are models
      providers.push({
        name: providerId,
        apiBase: providerDef?.defaultBaseUrl,
        models: modelList
      });
    }

    await config.update('providers', providers, configTarget);
    this._logger.info(`Saved ${modelList.length} selected models for ${providerId} (${target})`);
    
    vscode.window.showInformationMessage(`Saved ${modelList.length} models for ${providerId}`);
    await vscode.commands.executeCommand('openLLM.reloadConfig');
    
    // Refresh the test result for this provider so cached data is updated
    await this._testConnection(providerId);
  }

  private async _testConnection(providerId: string): Promise<void> {
    const provider = PROVIDERS.find(p => p.id === providerId);
    if (!provider) return;

    this._panel.webview.postMessage({ 
      command: 'testResult', 
      providerId, 
      status: 'testing' 
    });

    try {
      const apiKey = await this._context.secrets.get(`openllm.${providerId}.apiKey`);
      const baseUrl = await this._getBaseUrl(providerId, provider.defaultBaseUrl);

      let success = false;
      let message = '';

      switch (providerId) {
        case 'openai':
        case 'openrouter':
          ({ success, message } = await this._testOpenAICompatible(baseUrl!, apiKey!, providerId));
          break;
        case 'anthropic':
          ({ success, message } = await this._testAnthropic(baseUrl!, apiKey!));
          break;
        case 'gemini':
          ({ success, message } = await this._testGemini(apiKey!));
          break;
        case 'ollama':
          ({ success, message } = await this._testOllama(baseUrl!));
          break;
        case 'mistral':
          ({ success, message } = await this._testMistral(baseUrl!, apiKey!));
          break;
        case 'azure':
          ({ success, message } = await this._testAzure(providerId, apiKey!));
          break;
        case 'rhoai':
          ({ success, message } = await this._testOpenAICompatible(baseUrl!, apiKey!, providerId));
          break;
        default:
          message = 'Test not implemented for this provider';
      }

      // Get fetched models to send to UI for picker
      const fetchedModels = success 
        ? this._context.globalState.get<Array<{id: string; name?: string; vision?: boolean; tools?: boolean}>>(`openllm.${providerId}.fetchedModels`) || []
        : [];

      // Get models from user and workspace settings separately
      const config = vscode.workspace.getConfiguration('openLLM');
      const inspection = config.inspect<Array<{ name: string; models?: string[] }>>('providers');
      
      const userProviders = inspection?.globalValue || [];
      const workspaceProviders = inspection?.workspaceValue || [];
      
      const userProviderConfig = userProviders.find(p => p.name.toLowerCase() === providerId.toLowerCase());
      const workspaceProviderConfig = workspaceProviders.find(p => p.name.toLowerCase() === providerId.toLowerCase());
      
      const userModels = userProviderConfig?.models || [];
      const workspaceModels = workspaceProviderConfig?.models || [];

      this._panel.webview.postMessage({ 
        command: 'testResult', 
        providerId, 
        status: success ? 'success' : 'error',
        message,
        models: fetchedModels,
        userModels,
        workspaceModels
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

  private async _getBaseUrl(providerId: string, defaultUrl?: string): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('openLLM');
    const providers = config.get<Array<{ name: string; apiBase?: string }>>('providers', []);
    const providerConfig = providers.find(p => p.name.toLowerCase() === providerId);
    return providerConfig?.apiBase || defaultUrl;
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
    const fetchedModels = this._context.globalState.get<string[]>(`openllm.${providerId}.fetchedModels`);
    if (fetchedModels && fetchedModels.length > 0) {
      // For providers with many models (OpenRouter, OpenAI), limit to top picks
      // OpenRouter returns hundreds, we'll take top 10
      const limit = providerId === 'openrouter' ? 10 : 20;
      return fetchedModels.slice(0, limit);
    }
    
    // Fall back to defaults
    const providerDef = PROVIDERS.find(p => p.id === providerId);
    return providerDef?.models || [];
  }

  /**
   * Get total fetched models count for a provider
   */
  private _getFetchedModelCount(providerId: string): number {
    const fetchedModels = this._context.globalState.get<string[]>(`openllm.${providerId}.fetchedModels`);
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

  private async _sendStatus(): Promise<void> {
    const status: Record<string, { 
      hasApiKey: boolean; 
      keySource: 'secretStorage' | 'environment' | 'none';
      envVarName?: string;
      baseUrl?: string; 
      extraFields?: Record<string, string>;
      enabled: boolean;
      hasModels: boolean;
    }> = {};

    // Get provider enabled states from settings
    const config = vscode.workspace.getConfiguration('openLLM');
    const configuredProviders = config.get<Array<{ name: string; enabled?: boolean; models?: string[] }>>('providers', []);

    for (const provider of PROVIDERS) {
      // Use SecretResolver to check all sources
      const keySource: ApiKeySource = await this._secretResolver.getApiKeySource(provider.id);
      const baseUrl = await this._getBaseUrl(provider.id, provider.defaultBaseUrl);
      
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
      const enabled = isInSettings && configuredProvider?.enabled !== false;
      const hasModels = (configuredProvider?.models?.length || 0) > 0;

      status[provider.id] = {
        hasApiKey: keySource.available || !provider.requiresApiKey,
        keySource: keySource.source,
        envVarName: keySource.envVarName,
        baseUrl,
        extraFields,
        enabled,
        hasModels
      };
    }

    this._panel.webview.postMessage({ command: 'status', status });
  }

  private _update(): void {
    this._panel.webview.html = this._getWebviewContent();
    this._sendStatus();
  }

  private _getWebviewContent(): string {
    const codiconsUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
    );

    const providersJson = JSON.stringify(PROVIDERS);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${codiconsUri}" rel="stylesheet" />
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
      gap: 10px;
    }
    
    .provider-name {
      font-weight: 600;
      font-size: 1.1em;
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
      padding: 4px;
      cursor: pointer;
      color: var(--vscode-foreground);
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
  </style>
</head>
<body>
  <div class="header-row">
    <h1><i class="codicon codicon-server-process"></i> Providers and Models</h1>
    <button class="refresh-all-btn" onclick="refreshAll()" title="Reload all providers">
      <i class="codicon codicon-refresh"></i> Refresh All
    </button>
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
          <span class="save-target-label">Save to:</span>
          <label class="save-target-option">
            <input type="radio" name="save-target" id="save-to-user" value="user" checked> 
            <span>User Settings</span>
          </label>
          <label class="save-target-option">
            <input type="radio" name="save-target" id="save-to-workspace" value="workspace"> 
            <span>Workspace Settings</span>
          </label>
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
    const providerStatus = {};
    
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
        } else if (status.keySource === 'secretStorage') {
          statusText = '✓ Enabled';
          sourceHint = 'Stored securely in VS Code';
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
                value="\${status.keySource === 'secretStorage' ? '••••••••••••••••' : ''}"
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
      
      return \`
        <div class="provider-card \${disabledClass}" id="card-\${provider.id}">
          <div class="provider-header">
            <div class="provider-name-row">
              <label class="enabled-checkbox" title="\${isEnabled ? 'Uncheck to disable' : 'Check to enable'}">
                <input type="checkbox" \${isEnabled ? 'checked' : ''} onchange="toggleEnabled('\${provider.id}', this.checked)" />
                <span class="provider-name">\${provider.name}</span>
              </label>
            </div>
            <span class="status-badge \${statusClass}">\${statusText}</span>
          </div>
          <div class="provider-body \${isEnabled ? '' : 'body-disabled'}">
            \${fieldsHtml}
            <div class="button-group">
              <button onclick="saveProvider('\${provider.id}', 'user')" title="Save to User settings" \${disabledAttr}>
                <i class="codicon codicon-save"></i> Save (User)
              </button>
              <button onclick="saveProvider('\${provider.id}', 'workspace')" title="Save to Workspace settings" \${disabledAttr}>
                <i class="codicon codicon-save"></i> Save (Workspace)
              </button>
              <button onclick="testConnection('\${provider.id}')" title="Test connection and fetch available models" \${disabledAttr}>
                <i class="codicon codicon-list-selection"></i> Models...
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
    let userModelsSet = new Set();
    let workspaceModelsSet = new Set();
    
    function openModelPicker(providerId, models, userModels, workspaceModels) {
      currentPickerProvider = providerId;
      
      // Handle both old format (string[]) and new format ({id, name, vision, tools}[])
      allModels = (models || []).map(m => typeof m === 'string' ? { id: m } : m);
      
      // Track which models are in user vs workspace settings
      userModelsSet = new Set(userModels || []);
      workspaceModelsSet = new Set(workspaceModels || []);
      
      const provider = providers.find(p => p.id === providerId);
      document.getElementById('model-picker-title').textContent = 
        \`Select Models - \${provider?.name || providerId}\`;
      
      // Set radio button - default to User, unless only Workspace has models
      const editingWorkspace = workspaceModelsSet.size > 0 && userModelsSet.size === 0;
      if (editingWorkspace) {
        document.getElementById('save-to-workspace').checked = true;
        selectedModels = new Set(workspaceModelsSet);
      } else {
        document.getElementById('save-to-user').checked = true;
        selectedModels = new Set(userModelsSet);
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
        
        // Determine if this model's checkbox should be disabled
        // (it's from the "other" scope that we're not editing)
        const isOtherScope = (editingUser && inWorkspace && !inUser) || 
                             (editingWorkspace && inUser && !inWorkspace);
        const isConfigured = inUser || inWorkspace;
        
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
                   \${isOtherScope ? 'disabled' : ''}
                   onchange="toggleModel('\${modelId}', this.checked)">
            <label for="model-\${safeId}" class="\${isOtherScope ? 'disabled-label' : ''}">\${modelId}</label>
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
      
      // Enable save button if there's any change from original state
      const originalSet = editingUser ? userModelsSet : workspaceModelsSet;
      const hasChanges = !setsEqual(selectedModels, originalSet);
      document.getElementById('save-models-btn').disabled = !hasChanges;
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
      
      vscode.postMessage({ 
        command: 'saveSelectedModels', 
        providerId: currentPickerProvider,
        models: Array.from(selectedModels),
        target: target
      });
      
      closeModelPicker();
    }
    
    function openModelPickerFromData(providerId) {
      const data = window['_pickerData_' + providerId];
      if (data) {
        openModelPicker(providerId, data.models, data.userModels, data.workspaceModels);
      }
    }
    
    window.addEventListener('message', event => {
      const message = event.data;
      
      if (message.command === 'status') {
        Object.assign(providerStatus, message.status);
        renderProviders();
      } else if (message.command === 'testResult') {
        const resultEl = document.getElementById('test-result-' + message.providerId);
        if (message.status === 'success') {
          const models = message.models || [];
          const userModels = message.userModels || [];
          const workspaceModels = message.workspaceModels || [];
          
          let html = \`<div class="test-result test-success"><i class="codicon codicon-check"></i> \${message.message}</div>\`;
          
          // Show model picker button if models were fetched
          if (models.length > 0) {
            // Store data for the picker
            window['_pickerData_' + message.providerId] = { models, userModels, workspaceModels };
            
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
    
    // Initial render
    renderProviders();
    vscode.postMessage({ command: 'getStatus' });
    
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
