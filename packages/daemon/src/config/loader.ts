/**
 * Configuration loader
 * 
 * Loads and saves YAML configuration from:
 * - User level:      <configDir>/config.yaml   (platform-aware via paths.ts)
 * - Workspace level:  <workspace>/.config/openllm/config.yaml
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import {
  getUserConfigPath as _getUserConfigPath,
  getWorkspaceConfigPath as _getWorkspaceConfigPath,
} from '../paths.js';

/**
 * Provider configuration
 */
export interface ProviderConfig {
  /** Keychain key name (mutually exclusive with api_key_env_var_name) */
  api_key_keychain_name?: string;
  /** Environment variable name (mutually exclusive with api_key_keychain_name) */
  api_key_env_var_name?: string;
  /** Custom API base URL */
  api_base?: string;
  /** Enabled model IDs */
  enabled_models?: string[];
}

/**
 * Full configuration file structure
 */
export interface ConfigFile {
  providers?: Record<string, ProviderConfig>;
}

/**
 * Get user config path (platform-aware via paths.ts)
 */
export function getUserConfigPath(): string {
  return _getUserConfigPath();
}

/**
 * Get workspace config path: <workspace>/.config/openllm/config.yaml
 */
export function getWorkspaceConfigPath(workspacePath: string): string {
  return _getWorkspaceConfigPath(workspacePath);
}

/**
 * Load configuration from a file
 */
export function loadConfigFromPath(configPath: string): ConfigFile | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const raw = yaml.load(content) as any;
    if (!raw) return { providers: {} };
    
    // Reject old Rust-era array format — user must delete and reconfigure
    if (Array.isArray(raw.providers)) {
      console.warn(`[Config] Ignoring old array-based config at ${configPath}. Delete it and reconfigure.`);
      return { providers: {} };
    }
    
    const config = raw as ConfigFile;
    return config || { providers: {} };
  } catch (error) {
    console.error(`Failed to load config from ${configPath}:`, error);
    return null;
  }
}

/**
 * Save configuration to a file
 */
export function saveConfigToPath(configPath: string, config: ConfigFile): void {
  // Ensure directory exists
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
  
  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });
  
  fs.writeFileSync(configPath, content, { mode: 0o600 });
}

/**
 * Load user-level configuration
 */
export function loadConfig(): ConfigFile {
  const userConfig = loadConfigFromPath(getUserConfigPath());
  return userConfig || { providers: {} };
}

/**
 * Save user-level configuration
 */
export function saveConfig(config: ConfigFile): void {
  saveConfigToPath(getUserConfigPath(), config);
}

/**
 * Load workspace-level configuration
 */
export function loadWorkspaceConfig(workspacePath: string): ConfigFile | null {
  return loadConfigFromPath(getWorkspaceConfigPath(workspacePath));
}

/**
 * Save workspace-level configuration
 */
export function saveWorkspaceConfig(workspacePath: string, config: ConfigFile): void {
  saveConfigToPath(getWorkspaceConfigPath(workspacePath), config);
}

/**
 * Merge configurations (workspace overrides user)
 */
export function mergeConfigs(userConfig: ConfigFile, workspaceConfig: ConfigFile | null): ConfigFile {
  if (!workspaceConfig) {
    return userConfig;
  }
  
  const merged: ConfigFile = {
    providers: { ...userConfig.providers },
  };
  
  // Workspace providers override user providers
  if (workspaceConfig.providers) {
    for (const [providerId, providerConfig] of Object.entries(workspaceConfig.providers)) {
      merged.providers![providerId] = {
        ...merged.providers![providerId],
        ...providerConfig,
      };
    }
  }
  
  return merged;
}

/**
 * Merge user config with multiple workspace configs.
 * 
 * Provider-level replacement: if ANY workspace defines a provider, that
 * provider's config completely replaces the user-level config for it.
 * For multi-root workspaces (multiple workspace paths), `enabled_models`
 * are unioned across workspaces — but the user config's models for that
 * provider are NOT included.
 * 
 * Providers not mentioned by any workspace are kept from the user config.
 * If workspacePaths is empty, returns the user config as-is.
 */
export function mergeMultipleWorkspaceConfigs(workspacePaths: string[]): ConfigFile {
  const userConfig = loadConfig();
  
  if (workspacePaths.length === 0) {
    return userConfig;
  }
  
  const merged: ConfigFile = {
    providers: { ...userConfig.providers },
  };
  
  // Track which providers are defined by workspaces, and their enabled_models
  // (unioned across workspaces, but NOT seeded from user config)
  const wsProviderModels: Record<string, Set<string>> = {};
  
  // Overlay each workspace config — provider-level replacement
  for (const wsPath of workspacePaths) {
    const wsConfig = loadWorkspaceConfig(wsPath);
    if (!wsConfig?.providers) continue;
    
    for (const [providerId, wsCfg] of Object.entries(wsConfig.providers)) {
      if (!(providerId in wsProviderModels)) {
        // First workspace to define this provider replaces the user config entirely
        merged.providers![providerId] = { ...wsCfg };
        wsProviderModels[providerId] = new Set(wsCfg.enabled_models || []);
      } else {
        // Subsequent workspaces: overlay fields and union enabled_models
        const { enabled_models: wsModels, ...wsRest } = wsCfg;
        merged.providers![providerId] = {
          ...merged.providers![providerId],
          ...wsRest,
        };
        if (wsModels) {
          for (const m of wsModels) {
            wsProviderModels[providerId].add(m);
          }
        }
      }
    }
  }
  
  // Write final enabled_models back for workspace-defined providers
  for (const [providerId, models] of Object.entries(wsProviderModels)) {
    if (merged.providers![providerId]) {
      merged.providers![providerId].enabled_models =
        models.size > 0 ? Array.from(models) : undefined;
    }
  }
  
  return merged;
}

/**
 * Get provider configuration
 */
export function getProviderConfig(providerId: string, workspacePath?: string): ProviderConfig | null {
  const userConfig = loadConfig();
  const workspaceConfig = workspacePath ? loadWorkspaceConfig(workspacePath) : null;
  const merged = mergeConfigs(userConfig, workspaceConfig);
  
  return merged.providers?.[providerId] || null;
}

/**
 * Get all configured providers
 */
export function getConfiguredProviders(workspacePath?: string): string[] {
  const userConfig = loadConfig();
  const workspaceConfig = workspacePath ? loadWorkspaceConfig(workspacePath) : null;
  const merged = mergeConfigs(userConfig, workspaceConfig);
  
  return Object.keys(merged.providers || {});
}
