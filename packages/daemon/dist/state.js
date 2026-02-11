/**
 * Central daemon state
 */
import { v4 as uuidv4 } from 'uuid';
import { KeychainSecretStore } from './secrets/keychain.js';
import { loadConfig, loadWorkspaceConfig, mergeConfigs, } from './config/loader.js';
import { getSupportedProviders, getProviderDisplayName, providerRequiresKey, fetchModels, streamChat, } from './providers/adapter.js';
/**
 * Client type enum (matches proto)
 */
export var ClientType;
(function (ClientType) {
    ClientType["UNSPECIFIED"] = "UNSPECIFIED";
    ClientType["VSCODE"] = "VSCODE";
    ClientType["CLI"] = "CLI";
    ClientType["PYTHON"] = "PYTHON";
    ClientType["NODEJS"] = "NODEJS";
    ClientType["MCP"] = "MCP";
})(ClientType || (ClientType = {}));
/**
 * Central daemon state
 */
export class DaemonState {
    version = '0.1.0';
    startedAt = new Date();
    // Connected clients
    clients = new Map();
    // VS Code connections for backchannel
    vscodeConnections = new Map();
    // Secret store
    secretStore;
    constructor() {
        this.secretStore = new KeychainSecretStore();
    }
    // ─── Config ──────────────────────────────────────────────────────────
    /**
     * Load provider config from YAML, optionally merged with workspace config
     */
    loadProviderConfig(workspacePath) {
        const userConfig = loadConfig();
        const wsConfig = workspacePath ? loadWorkspaceConfig(workspacePath) : null;
        const merged = mergeConfigs(userConfig, wsConfig);
        return merged.providers || {};
    }
    /**
     * Resolve the API key for a provider from config (keychain or env var)
     */
    async resolveApiKey(providerId, providerCfg) {
        if (!providerCfg) {
            const config = this.loadProviderConfig();
            providerCfg = config[providerId];
        }
        if (!providerCfg)
            return null;
        // Check keychain
        if (providerCfg.api_key_keychain_name) {
            const value = await this.secretStore.get(providerCfg.api_key_keychain_name);
            if (value)
                return value;
        }
        // Check env var
        if (providerCfg.api_key_env_var_name) {
            const value = process.env[providerCfg.api_key_env_var_name];
            if (value && value.length > 0)
                return value;
        }
        return null;
    }
    // ─── Providers ───────────────────────────────────────────────────────
    /**
     * List all providers with configuration status
     */
    async listProviders() {
        const config = this.loadProviderConfig();
        const providers = [];
        for (const providerId of getSupportedProviders()) {
            const providerCfg = config[providerId];
            let configured = false;
            if (!providerRequiresKey(providerId)) {
                configured = true;
            }
            else if (providerCfg) {
                const key = await this.resolveApiKey(providerId, providerCfg);
                configured = key !== null;
            }
            providers.push({
                id: providerId,
                displayName: getProviderDisplayName(providerId),
                configured,
                healthy: true,
            });
        }
        return providers;
    }
    /**
     * List models dynamically from provider APIs
     */
    async listModels() {
        const config = this.loadProviderConfig();
        const allModels = [];
        for (const providerId of getSupportedProviders()) {
            const providerCfg = config[providerId];
            // Skip unconfigured providers that require keys
            if (providerRequiresKey(providerId) && !providerCfg) {
                continue;
            }
            const apiKey = await this.resolveApiKey(providerId, providerCfg);
            if (providerRequiresKey(providerId) && !apiKey) {
                continue;
            }
            try {
                const models = await fetchModels(providerId, apiKey || undefined, providerCfg?.api_base);
                allModels.push(...models);
            }
            catch (error) {
                console.error(`[State] Failed to list models for ${providerId}:`, error);
            }
        }
        return allModels;
    }
    /**
     * Stream a chat response
     */
    async *chat(model, messages) {
        // Parse provider/model
        const slashIdx = model.indexOf('/');
        if (slashIdx === -1) {
            yield { type: 'done', finishReason: 'error' };
            return;
        }
        const providerId = model.substring(0, slashIdx);
        const modelId = model.substring(slashIdx + 1);
        // Resolve API key
        const config = this.loadProviderConfig();
        const providerCfg = config[providerId];
        const apiKey = await this.resolveApiKey(providerId, providerCfg);
        if (providerRequiresKey(providerId) && !apiKey) {
            console.error(`[State] No API key for provider ${providerId}`);
            yield { type: 'done', finishReason: 'error' };
            return;
        }
        yield* streamChat(providerId, modelId, messages, apiKey || undefined, providerCfg?.api_base);
    }
    // ─── Clients ─────────────────────────────────────────────────────────
    /**
     * Register a new client
     */
    registerClient(clientType, isSpawner = false, workspacePath) {
        const clientId = uuidv4();
        this.clients.set(clientId, {
            clientId,
            clientType,
            connectedAt: new Date(),
            isSpawner,
            workspacePath,
        });
        console.log(`[State] Client registered: ${clientId} (${clientType})`);
        return clientId;
    }
    /**
     * Unregister a client
     */
    unregisterClient(clientId) {
        const removed = this.clients.delete(clientId);
        if (removed) {
            console.log(`[State] Client unregistered: ${clientId}`);
        }
        return removed;
    }
    /**
     * Get client count
     */
    get clientCount() {
        return this.clients.size;
    }
    /**
     * Get all connected clients
     */
    getClients() {
        return Array.from(this.clients.values());
    }
    // ─── VS Code Backchannel ─────────────────────────────────────────────
    /**
     * Register a VS Code connection with its stream
     */
    registerVSCodeConnection(stream) {
        const id = uuidv4();
        this.vscodeConnections.set(id, {
            id,
            workspaceFolders: [],
            stream,
            pendingRequests: new Map(),
        });
        console.log(`[State] VS Code connection registered: ${id}`);
        return id;
    }
    /**
     * Unregister a VS Code connection
     */
    unregisterVSCodeConnection(id) {
        const conn = this.vscodeConnections.get(id);
        if (conn) {
            // Reject all pending requests
            for (const [reqId, pending] of conn.pendingRequests) {
                clearTimeout(pending.timer);
                pending.reject(new Error('VS Code connection closed'));
            }
            conn.pendingRequests.clear();
        }
        const removed = this.vscodeConnections.delete(id);
        if (removed) {
            console.log(`[State] VS Code connection unregistered: ${id}`);
        }
        return removed;
    }
    /**
     * Update VS Code workspace info
     */
    updateVSCodeWorkspace(id, workspacePath, workspaceFolders) {
        const conn = this.vscodeConnections.get(id);
        if (conn) {
            conn.workspacePath = workspacePath;
            conn.workspaceFolders = workspaceFolders;
            console.log(`[State] VS Code workspace updated for ${id}: ${workspacePath} (${workspaceFolders.length} folders)`);
        }
    }
    /**
     * Handle a response from VS Code (resolve pending request)
     */
    handleVSCodeResponse(connId, response) {
        const conn = this.vscodeConnections.get(connId);
        if (!conn)
            return;
        const requestId = response.request_id || response.requestId;
        if (!requestId)
            return;
        const pending = conn.pendingRequests.get(requestId);
        if (pending) {
            clearTimeout(pending.timer);
            conn.pendingRequests.delete(requestId);
            pending.resolve(response);
        }
    }
    /**
     * Send a request to VS Code via the backchannel stream and wait for response
     */
    async sendVSCodeRequest(connId, request, timeoutMs = 10000) {
        const conn = this.vscodeConnections.get(connId);
        if (!conn || !conn.stream) {
            throw new Error('VS Code connection not available');
        }
        const requestId = uuidv4();
        const fullRequest = { request_id: requestId, ...request };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                conn.pendingRequests.delete(requestId);
                reject(new Error(`VS Code request timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            conn.pendingRequests.set(requestId, { resolve, reject, timer });
            try {
                conn.stream.write(fullRequest);
            }
            catch (err) {
                conn.pendingRequests.delete(requestId);
                clearTimeout(timer);
                reject(err);
            }
        });
    }
    /**
     * Send GetWorkspace request to a VS Code connection
     */
    async requestWorkspace(connId) {
        const response = await this.sendVSCodeRequest(connId, {
            get_workspace: {},
        });
        const ws = response.get_workspace || response.getWorkspace || {};
        const workspacePath = ws.workspace_path || ws.workspacePath || '';
        const workspaceFolders = ws.workspace_folders || ws.workspaceFolders || [];
        // Update local state
        if (workspacePath || workspaceFolders.length > 0) {
            this.updateVSCodeWorkspace(connId, workspacePath, workspaceFolders);
        }
        return { workspacePath, workspaceFolders };
    }
    /**
     * Send InvokeTool request to VS Code
     */
    async invokeVSCodeTool(toolName, args) {
        const connId = this.getFirstVSCodeConnection();
        if (!connId)
            throw new Error('No VS Code connection available');
        const response = await this.sendVSCodeRequest(connId, {
            invoke_tool: {
                tool_name: toolName,
                arguments_json: JSON.stringify(args),
            },
        });
        const result = response.invoke_tool || response.invokeTool || {};
        return {
            resultJson: result.result_json || result.resultJson || '{}',
            isError: result.is_error || result.isError || false,
        };
    }
    /**
     * Send ListVSCodeModels request
     */
    async listVSCodeModels(familyFilter) {
        const connId = this.getFirstVSCodeConnection();
        if (!connId)
            return [];
        const response = await this.sendVSCodeRequest(connId, {
            list_models: {
                family_filter: familyFilter || '',
            },
        });
        const result = response.list_models || response.listModels || {};
        return result.models || [];
    }
    /**
     * Get the first available VS Code connection ID
     */
    getFirstVSCodeConnection() {
        for (const [id, conn] of this.vscodeConnections) {
            if (conn.stream)
                return id;
        }
        return null;
    }
    /**
     * Get all VS Code workspaces
     */
    getVSCodeWorkspaces() {
        const workspaces = [];
        for (const conn of this.vscodeConnections.values()) {
            if (conn.workspacePath) {
                workspaces.push(conn.workspacePath);
            }
            for (const folder of conn.workspaceFolders) {
                if (!workspaces.includes(folder)) {
                    workspaces.push(folder);
                }
            }
        }
        return workspaces.sort();
    }
    /**
     * Get all VS Code connection IDs
     */
    getVSCodeConnectionIds() {
        return Array.from(this.vscodeConnections.keys());
    }
    /**
     * Check if any VS Code is connected
     */
    hasVSCodeConnection() {
        return this.vscodeConnections.size > 0;
    }
}
//# sourceMappingURL=state.js.map