/**
 * Configuration loader
 *
 * Loads and saves YAML configuration from:
 * - User level: ~/.openllm/config.yaml
 * - Workspace level: <workspace>/.openllm/config.yaml
 */
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
 * Get user config path
 */
export declare function getUserConfigPath(): string;
/**
 * Get workspace config path
 */
export declare function getWorkspaceConfigPath(workspacePath: string): string;
/**
 * Load configuration from a file
 */
export declare function loadConfigFromPath(configPath: string): ConfigFile | null;
/**
 * Save configuration to a file
 */
export declare function saveConfigToPath(configPath: string, config: ConfigFile): void;
/**
 * Load user-level configuration
 */
export declare function loadConfig(): ConfigFile;
/**
 * Save user-level configuration
 */
export declare function saveConfig(config: ConfigFile): void;
/**
 * Load workspace-level configuration
 */
export declare function loadWorkspaceConfig(workspacePath: string): ConfigFile | null;
/**
 * Save workspace-level configuration
 */
export declare function saveWorkspaceConfig(workspacePath: string, config: ConfigFile): void;
/**
 * Merge configurations (workspace overrides user)
 */
export declare function mergeConfigs(userConfig: ConfigFile, workspaceConfig: ConfigFile | null): ConfigFile;
/**
 * Get provider configuration
 */
export declare function getProviderConfig(providerId: string, workspacePath?: string): ProviderConfig | null;
/**
 * Get all configured providers
 */
export declare function getConfiguredProviders(workspacePath?: string): string[];
//# sourceMappingURL=loader.d.ts.map