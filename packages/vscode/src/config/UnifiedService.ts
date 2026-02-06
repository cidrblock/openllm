/**
 * Unified Service - Single entry point for all config and secret operations
 * 
 * This service uses openllm-core's unified resolvers via NAPI, which in turn
 * call back to the VS Code RPC server when VS Code data is needed.
 * 
 * Architecture:
 *   Extension → UnifiedService → NAPI (openllm-core) → RPC → VS Code APIs
 * 
 * Benefits:
 * - Single source of truth (openllm-core)
 * - Consistent resolution across all environments (VS Code, CLI, Python)
 * - Proper source tracking
 */

import * as vscode from 'vscode';
import { getLogger } from '../utils/logger';
import { getNative } from '../utils/nativeLoader';

const logger = getLogger();

/**
 * Result of resolving a secret
 */
export interface ResolvedSecret {
  value: string;
  source: string;
  sourceDetail: string;
}

/**
 * Result of resolving a provider config
 */
export interface ResolvedProvider {
  name: string;
  enabled: boolean;
  apiBase?: string;
  models: string[];
  source: string;
  sourceDetail: string;
}

/**
 * Source information
 */
export interface SourceInfo {
  name: string;
  available: boolean;
  detail: string;
}

// Cached NAPI classes
let UnifiedSecretResolver: any = null;
let UnifiedConfigResolver: any = null;
let resolveSecretFn: any = null;
let resolveAllProvidersFn: any = null;
let resolveProviderFn: any = null;

/**
 * Initialize NAPI bindings
 */
function initNative(): boolean {
  if (UnifiedSecretResolver !== null) {
    return true;
  }
  
  try {
    const native = getNative();
    UnifiedSecretResolver = native.UnifiedSecretResolver;
    UnifiedConfigResolver = native.UnifiedConfigResolver;
    resolveSecretFn = native.resolveSecret;
    resolveAllProvidersFn = native.resolveAllProviders;
    resolveProviderFn = native.resolveProvider;
    return true;
  } catch (e) {
    logger.error('Failed to initialize unified service NAPI bindings:', e);
    return false;
  }
}

/**
 * Unified Secret Service
 * 
 * Resolves secrets from multiple sources in priority order:
 * 1. Environment variables
 * 2. VS Code SecretStorage (via RPC)
 * 3. System Keychain
 * 4. .env files
 */
export class UnifiedSecretService {
  private resolver: any = null;
  
  constructor() {
    if (initNative() && UnifiedSecretResolver) {
      this.resolver = new UnifiedSecretResolver();
    }
  }
  
  /**
   * Get an API key for a provider
   */
  async getApiKey(providerId: string): Promise<string | undefined> {
    const result = await this.resolve(providerId);
    return result?.value;
  }
  
  /**
   * Resolve a secret with full source information
   */
  async resolve(key: string): Promise<ResolvedSecret | null> {
    // Try native resolver first
    if (this.resolver) {
      try {
        const result = this.resolver.resolve(key);
        if (result) {
          return {
            value: result.value,
            source: result.source,
            sourceDetail: result.sourceDetail,
          };
        }
      } catch (e) {
        logger.warn(`Failed to resolve secret via NAPI:`, e);
      }
    }
    
    // Fallback: use convenience function
    if (resolveSecretFn) {
      try {
        const result = resolveSecretFn(key);
        if (result) {
          return {
            value: result.value,
            source: result.source,
            sourceDetail: result.sourceDetail,
          };
        }
      } catch (e) {
        logger.warn(`Failed to resolve secret via convenience function:`, e);
      }
    }
    
    return null;
  }
  
  /**
   * Store a secret to the specified destination
   */
  async store(key: string, value: string, destination: string): Promise<void> {
    if (!this.resolver) {
      throw new Error('UnifiedSecretResolver not available');
    }
    
    this.resolver.store(key, value, destination);
  }
  
  /**
   * Delete a secret from the specified destination
   */
  async delete(key: string, destination: string): Promise<void> {
    if (!this.resolver) {
      throw new Error('UnifiedSecretResolver not available');
    }
    
    this.resolver.delete(key, destination);
  }
  
  /**
   * Get information about where a secret is stored
   */
  getSourceInfo(key: string): SourceInfo | null {
    if (!this.resolver) {
      return null;
    }
    
    try {
      return this.resolver.getSourceInfo(key);
    } catch (e) {
      return null;
    }
  }
  
  /**
   * List all available secret sources
   */
  listSources(): SourceInfo[] {
    if (!this.resolver) {
      return [];
    }
    
    try {
      return this.resolver.listSources();
    } catch (e) {
      return [];
    }
  }
  
  /**
   * Check if an API key is available for a provider
   */
  async hasApiKey(providerId: string): Promise<boolean> {
    const result = await this.resolve(providerId);
    return result !== null;
  }
}

/**
 * Unified Config Service
 * 
 * Resolves provider configurations from multiple sources in priority order:
 * 1. Native YAML user config
 * 2. VS Code User Settings (via RPC)
 * 3. Native YAML workspace config
 * 4. VS Code Workspace Settings (via RPC)
 */
export class UnifiedConfigService {
  private resolver: any = null;
  private workspacePath: string | undefined;
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  
  readonly onDidChange = this.onDidChangeEmitter.event;
  
  constructor(workspacePath?: string) {
    this.workspacePath = workspacePath;
    
    if (initNative() && UnifiedConfigResolver) {
      if (workspacePath) {
        this.resolver = UnifiedConfigResolver.withWorkspace(workspacePath);
      } else {
        this.resolver = new UnifiedConfigResolver();
      }
    }
  }
  
  /**
   * Set the workspace path
   */
  setWorkspace(path: string | undefined): void {
    this.workspacePath = path;
    if (this.resolver) {
      this.resolver.setWorkspace(path || null);
    }
  }
  
  /**
   * Get all providers, merged from all sources
   */
  async getAllProviders(): Promise<ResolvedProvider[]> {
    // Try native resolver
    if (this.resolver) {
      try {
        return this.resolver.getAllProviders();
      } catch (e) {
        logger.warn('Failed to get providers via NAPI resolver:', e);
      }
    }
    
    // Fallback: use convenience function
    if (resolveAllProvidersFn) {
      try {
        return resolveAllProvidersFn(this.workspacePath || null);
      } catch (e) {
        logger.warn('Failed to get providers via convenience function:', e);
      }
    }
    
    return [];
  }
  
  /**
   * Get a specific provider
   */
  async getProvider(name: string): Promise<ResolvedProvider | null> {
    // Try native resolver
    if (this.resolver) {
      try {
        return this.resolver.getProvider(name) || null;
      } catch (e) {
        logger.warn(`Failed to get provider ${name} via NAPI:`, e);
      }
    }
    
    // Fallback: use convenience function
    if (resolveProviderFn) {
      try {
        return resolveProviderFn(name, this.workspacePath || null) || null;
      } catch (e) {
        logger.warn(`Failed to get provider ${name} via convenience function:`, e);
      }
    }
    
    return null;
  }
  
  /**
   * Get providers at a specific scope only
   */
  async getProvidersAtScope(scope: 'user' | 'workspace'): Promise<ResolvedProvider[]> {
    if (!this.resolver) {
      return [];
    }
    
    try {
      return this.resolver.getProvidersAtScope(scope);
    } catch (e) {
      logger.warn(`Failed to get providers at scope ${scope}:`, e);
      return [];
    }
  }
  
  /**
   * Get models for a specific provider
   */
  async getProviderModels(name: string): Promise<string[]> {
    const provider = await this.getProvider(name);
    return provider?.models || [];
  }
  
  /**
   * List all available config sources
   */
  listSources(): SourceInfo[] {
    if (!this.resolver) {
      return [];
    }
    
    try {
      return this.resolver.listSources();
    } catch (e) {
      return [];
    }
  }
  
  /**
   * Notify listeners of a config change
   */
  notifyChange(): void {
    this.onDidChangeEmitter.fire();
  }
  
  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }
}

// Singleton instances
let secretService: UnifiedSecretService | null = null;
let configService: UnifiedConfigService | null = null;

/**
 * Get the unified secret service singleton
 */
export function getSecretService(): UnifiedSecretService {
  if (!secretService) {
    secretService = new UnifiedSecretService();
  }
  return secretService;
}

/**
 * Get the unified config service singleton
 */
export function getConfigService(workspacePath?: string): UnifiedConfigService {
  if (!configService) {
    configService = new UnifiedConfigService(workspacePath);
  } else if (workspacePath && !configService['workspacePath']) {
    configService.setWorkspace(workspacePath);
  }
  return configService;
}

/**
 * Initialize both services with the current workspace
 */
export function initializeServices(workspacePath?: string): {
  secrets: UnifiedSecretService;
  config: UnifiedConfigService;
} {
  const ws = workspacePath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return {
    secrets: getSecretService(),
    config: getConfigService(ws),
  };
}
