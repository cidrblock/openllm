/**
 * Configuration loader
 * 
 * Loads and saves YAML configuration from:
 * - User level: ~/.config/openllm/config.yaml (XDG standard)
 * - Workspace level: <workspace>/.openllm/config.yaml
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'js-yaml';

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
 * Get user config path (XDG Base Directory: ~/.config/openllm/config.yaml)
 */
export function getUserConfigPath(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdgConfig, 'openllm', 'config.yaml');
}

/**
 * Get workspace config path
 */
export function getWorkspaceConfigPath(workspacePath: string): string {
  return path.join(workspacePath, '.openllm', 'config.yaml');
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
