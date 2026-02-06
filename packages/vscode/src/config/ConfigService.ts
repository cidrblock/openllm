import * as vscode from 'vscode';
import { getNative } from '../utils/nativeLoader';
import { getLogger } from '../utils/logger';
import { ProviderConfig } from '../types';

/**
 * Unified configuration service that abstracts the underlying config source.
 * 
 * All config reads/writes should go through this service rather than
 * directly accessing vscode.workspace.getConfiguration or native bindings.
 */
export class ConfigService {
  private static instance: ConfigService | null = null;
  private context: vscode.ExtensionContext | null = null;
  private logger = getLogger();
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  
  readonly onDidChange = this.onDidChangeEmitter.event;

  private constructor() {}

  static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService();
    }
    return ConfigService.instance;
  }

  /**
   * Initialize with extension context
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  /**
   * Get the current config source setting
   */
  getConfigSource(): 'vscode' | 'native' {
    const config = vscode.workspace.getConfiguration('openLLM');
    return config.get<string>('config.source', 'vscode') as 'vscode' | 'native';
  }

  /**
   * Get the native config level setting
   */
  getNativeLevel(): 'user' | 'workspace' | 'both' {
    const config = vscode.workspace.getConfiguration('openLLM');
    return config.get<string>('config.nativeLevel', 'user') as 'user' | 'workspace' | 'both';
  }

  /**
   * Get all configured providers from the appropriate source
   */
  async getProviders(): Promise<ProviderConfig[]> {
    const source = this.getConfigSource();
    
    if (source === 'native') {
      return this.getProvidersFromNative();
    } else {
      return this.getProvidersFromVSCode();
    }
  }

  /**
   * Get providers from VS Code settings
   */
  private async getProvidersFromVSCode(): Promise<ProviderConfig[]> {
    const config = vscode.workspace.getConfiguration('openLLM');
    const providers = config.get<ProviderConfig[]>('providers', []);
    
    // Add source info
    const inspection = config.inspect<ProviderConfig[]>('providers');
    const userProviders = new Set((inspection?.globalValue || []).map(p => p.name.toLowerCase()));
    const workspaceProviders = new Set((inspection?.workspaceValue || []).map(p => p.name.toLowerCase()));
    
    return providers.map(p => ({
      ...p,
      // Track source for debugging
      _source: workspaceProviders.has(p.name.toLowerCase()) 
        ? 'VS Code Workspace Settings' 
        : userProviders.has(p.name.toLowerCase())
          ? 'VS Code User Settings'
          : 'VS Code Settings'
    }));
  }

  /**
   * Get providers from native config files
   */
  private async getProvidersFromNative(): Promise<ProviderConfig[]> {
    try {
      const native = getNative();
      const level = this.getNativeLevel();
      const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      
      const providerMap = new Map<string, ProviderConfig>();
      
      // Load user config
      if (level === 'user' || level === 'both') {
        const userConfig = native.FileConfigProvider.user();
        if (userConfig.exists()) {
          const providers = await userConfig.getProviders();
          for (const p of providers) {
            // NAPI-rs converts snake_case to camelCase in JS
            providerMap.set(p.name.toLowerCase(), {
              name: p.name,
              enabled: p.enabled,
              apiBase: p.apiBase || undefined,
              models: Array.isArray(p.models) ? p.models.filter((m: any) => typeof m === 'string') : [],
              _source: p.sourceDetail || '~/.config/openllm/config.yaml'
            });
          }
        }
      }
      
      // Load workspace config (overrides user)
      if ((level === 'workspace' || level === 'both') && workspacePath) {
        const wsConfig = native.FileConfigProvider.workspace(workspacePath);
        if (wsConfig.exists()) {
          const providers = await wsConfig.getProviders();
          for (const p of providers) {
            // NAPI-rs converts snake_case to camelCase in JS
            providerMap.set(p.name.toLowerCase(), {
              name: p.name,
              enabled: p.enabled,
              apiBase: p.apiBase || undefined,
              models: Array.isArray(p.models) ? p.models.filter((m: any) => typeof m === 'string') : [],
              _source: p.sourceDetail || '.config/openllm/config.yaml'
            });
          }
        }
      }
      
      return Array.from(providerMap.values());
    } catch (error) {
      this.logger.error('Failed to load native config:', error);
      return [];
    }
  }

  /**
   * Add or update a provider in the appropriate config source
   */
  async saveProvider(
    provider: ProviderConfig, 
    target: 'user' | 'workspace' = 'user'
  ): Promise<void> {
    const source = this.getConfigSource();
    
    if (source === 'native') {
      await this.saveProviderToNative(provider, target);
    } else {
      await this.saveProviderToVSCode(provider, target);
    }
    
    this.onDidChangeEmitter.fire();
  }

  /**
   * Save provider to VS Code settings
   */
  private async saveProviderToVSCode(
    provider: ProviderConfig, 
    target: 'user' | 'workspace'
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('openLLM');
    const configTarget = target === 'workspace' 
      ? vscode.ConfigurationTarget.Workspace 
      : vscode.ConfigurationTarget.Global;
    
    const providers = config.get<ProviderConfig[]>('providers', []);
    const existingIndex = providers.findIndex(
      p => p.name.toLowerCase() === provider.name.toLowerCase()
    );
    
    if (existingIndex >= 0) {
      providers[existingIndex] = provider;
    } else {
      providers.push(provider);
    }
    
    await config.update('providers', providers, configTarget);
  }

  /**
   * Save provider to native config
   */
  private async saveProviderToNative(
    provider: ProviderConfig, 
    target: 'user' | 'workspace'
  ): Promise<void> {
    const native = getNative();
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    
    if (target === 'workspace' && !workspacePath) {
      throw new Error('No workspace folder open');
    }
    
    const fileConfig = target === 'workspace' && workspacePath
      ? native.FileConfigProvider.workspace(workspacePath)
      : native.FileConfigProvider.user();
    
    // Get existing providers
    const existingProviders = fileConfig.exists() 
      ? await fileConfig.getProviders() 
      : [];
    
    const existingIndex = existingProviders.findIndex(
      (p: any) => p.name.toLowerCase() === provider.name.toLowerCase()
    );
    
    // Convert to NAPI format (NAPI-rs converts snake_case to camelCase in JS)
    const napiProvider = {
      name: provider.name,
      enabled: provider.enabled !== false, // Ensure boolean, not undefined
      apiBase: provider.apiBase || null,
      models: provider.models || [],
      source: 'Unknown',
      sourceDetail: target === 'workspace' ? '.config/openllm/config.yaml' : '~/.config/openllm/config.yaml'
    };
    
    if (existingIndex >= 0) {
      existingProviders[existingIndex] = napiProvider;
    } else {
      existingProviders.push(napiProvider);
    }
    
    fileConfig.importProviders(existingProviders);
  }

  /**
   * Remove a provider from the appropriate config source
   */
  async removeProvider(name: string, target: 'user' | 'workspace' = 'user'): Promise<void> {
    const source = this.getConfigSource();
    
    if (source === 'native') {
      await this.removeProviderFromNative(name, target);
    } else {
      await this.removeProviderFromVSCode(name, target);
    }
    
    this.onDidChangeEmitter.fire();
  }

  /**
   * Remove provider from VS Code settings
   */
  private async removeProviderFromVSCode(name: string, target: 'user' | 'workspace'): Promise<void> {
    const config = vscode.workspace.getConfiguration('openLLM');
    const configTarget = target === 'workspace' 
      ? vscode.ConfigurationTarget.Workspace 
      : vscode.ConfigurationTarget.Global;
    
    const providers = config.get<ProviderConfig[]>('providers', []);
    const filtered = providers.filter(
      p => p.name.toLowerCase() !== name.toLowerCase()
    );
    
    await config.update('providers', filtered, configTarget);
  }

  /**
   * Remove provider from native config
   */
  private async removeProviderFromNative(name: string, target: 'user' | 'workspace'): Promise<void> {
    const native = getNative();
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    
    if (target === 'workspace' && !workspacePath) {
      throw new Error('No workspace folder open');
    }
    
    const fileConfig = target === 'workspace' && workspacePath
      ? native.FileConfigProvider.workspace(workspacePath)
      : native.FileConfigProvider.user();
    
    if (!fileConfig.exists()) {
      return;
    }
    
    const providers = await fileConfig.getProviders();
    const filtered = providers.filter(
      (p: any) => p.name.toLowerCase() !== name.toLowerCase()
    );
    
    fileConfig.importProviders(filtered);
  }

  /**
   * Get models for a specific provider from the appropriate source
   */
  async getProviderModels(providerName: string): Promise<string[]> {
    const providers = await this.getProviders();
    const provider = providers.find(
      p => p.name.toLowerCase() === providerName.toLowerCase()
    );
    return provider?.models || [];
  }

  /**
   * Update models for a specific provider
   */
  async updateProviderModels(
    providerName: string, 
    models: string[], 
    target: 'user' | 'workspace' = 'user'
  ): Promise<void> {
    const providers = await this.getProviders();
    const provider = providers.find(
      p => p.name.toLowerCase() === providerName.toLowerCase()
    );
    
    if (provider) {
      provider.models = models;
      await this.saveProvider(provider, target);
    } else {
      // Create new provider with just models
      await this.saveProvider({
        name: providerName,
        enabled: true,
        models
      }, target);
    }
  }

  /**
   * Toggle provider enabled state
   */
  async toggleProvider(
    providerName: string, 
    enabled: boolean, 
    target: 'user' | 'workspace' = 'user'
  ): Promise<void> {
    const providers = await this.getProviders();
    const provider = providers.find(
      p => p.name.toLowerCase() === providerName.toLowerCase()
    );
    
    if (provider) {
      provider.enabled = enabled;
      await this.saveProvider(provider, target);
    }
  }

  /**
   * Notify listeners that config has changed
   */
  notifyChange(): void {
    this.onDidChangeEmitter.fire();
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

// Export singleton instance
export const configService = ConfigService.getInstance();
