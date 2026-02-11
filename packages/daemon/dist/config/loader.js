/**
 * Configuration loader
 *
 * Loads and saves YAML configuration from:
 * - User level: ~/.openllm/config.yaml
 * - Workspace level: <workspace>/.openllm/config.yaml
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'js-yaml';
/**
 * Get user config path
 */
export function getUserConfigPath() {
    return path.join(os.homedir(), '.openllm', 'config.yaml');
}
/**
 * Get workspace config path
 */
export function getWorkspaceConfigPath(workspacePath) {
    return path.join(workspacePath, '.openllm', 'config.yaml');
}
/**
 * Load configuration from a file
 */
export function loadConfigFromPath(configPath) {
    if (!fs.existsSync(configPath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(configPath, 'utf-8');
        const config = yaml.load(content);
        return config || { providers: {} };
    }
    catch (error) {
        console.error(`Failed to load config from ${configPath}:`, error);
        return null;
    }
}
/**
 * Save configuration to a file
 */
export function saveConfigToPath(configPath, config) {
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
export function loadConfig() {
    const userConfig = loadConfigFromPath(getUserConfigPath());
    return userConfig || { providers: {} };
}
/**
 * Save user-level configuration
 */
export function saveConfig(config) {
    saveConfigToPath(getUserConfigPath(), config);
}
/**
 * Load workspace-level configuration
 */
export function loadWorkspaceConfig(workspacePath) {
    return loadConfigFromPath(getWorkspaceConfigPath(workspacePath));
}
/**
 * Save workspace-level configuration
 */
export function saveWorkspaceConfig(workspacePath, config) {
    saveConfigToPath(getWorkspaceConfigPath(workspacePath), config);
}
/**
 * Merge configurations (workspace overrides user)
 */
export function mergeConfigs(userConfig, workspaceConfig) {
    if (!workspaceConfig) {
        return userConfig;
    }
    const merged = {
        providers: { ...userConfig.providers },
    };
    // Workspace providers override user providers
    if (workspaceConfig.providers) {
        for (const [providerId, providerConfig] of Object.entries(workspaceConfig.providers)) {
            merged.providers[providerId] = {
                ...merged.providers[providerId],
                ...providerConfig,
            };
        }
    }
    return merged;
}
/**
 * Get provider configuration
 */
export function getProviderConfig(providerId, workspacePath) {
    const userConfig = loadConfig();
    const workspaceConfig = workspacePath ? loadWorkspaceConfig(workspacePath) : null;
    const merged = mergeConfigs(userConfig, workspaceConfig);
    return merged.providers?.[providerId] || null;
}
/**
 * Get all configured providers
 */
export function getConfiguredProviders(workspacePath) {
    const userConfig = loadConfig();
    const workspaceConfig = workspacePath ? loadWorkspaceConfig(workspacePath) : null;
    const merged = mergeConfigs(userConfig, workspaceConfig);
    return Object.keys(merged.providers || {});
}
//# sourceMappingURL=loader.js.map