/**
 * Central daemon state
 */

import { v4 as uuidv4 } from 'uuid';
import type { SecretStore } from './secrets/types.js';
import { KeychainSecretStore } from './secrets/keychain.js';
import {
  loadConfig,
  loadWorkspaceConfig,
  mergeConfigs,
  mergeMultipleWorkspaceConfigs,
  type ConfigFile,
  type ProviderConfig,
} from './config/loader.js';
import {
  getSupportedProviders,
  getProviderDisplayName,
  providerRequiresKey,
  getDefaultEnvVar,
  fetchModels,
  streamChat,
} from './providers/adapter.js';

/**
 * Client type enum (matches proto)
 */
export enum ClientType {
  UNSPECIFIED = 'UNSPECIFIED',
  VSCODE = 'VSCODE',
  CLI = 'CLI',
  PYTHON = 'PYTHON',
  NODEJS = 'NODEJS',
  MCP = 'MCP',
}

/**
 * Connected client information
 */
export interface ConnectedClient {
  clientId: string;
  clientType: ClientType;
  connectedAt: Date;
  isSpawner: boolean;
  workspacePath?: string;
  workspacePaths: string[];
}

/**
 * Provider information
 */
export interface ProviderInfo {
  id: string;
  displayName: string;
  configured: boolean;
  healthy: boolean;
  requiresKey: boolean;
}

/**
 * Model information
 */
export interface ModelInfo {
  id: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  capabilities?: {
    supportsTools?: boolean;
    supportsVision?: boolean;
  };
}

/**
 * VS Code connection for backchannel
 */
export interface VSCodeConnection {
  id: string;
  workspacePath?: string;
  workspaceFolders: string[];
  stream?: any; // grpc.ServerDuplexStream
  pendingRequests: Map<string, {
    resolve: (response: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>;
}

/**
 * Central daemon state
 */
export class DaemonState {
  public readonly version = '0.1.0';
  public readonly startedAt = new Date();
  
  // Connected clients
  private clients = new Map<string, ConnectedClient>();
  
  // VS Code connections for backchannel
  private vscodeConnections = new Map<string, VSCodeConnection>();
  
  // Secret store
  public readonly secretStore: SecretStore;
  
  constructor() {
    this.secretStore = new KeychainSecretStore();
  }
  
  // ─── Config ──────────────────────────────────────────────────────────
  
  /**
   * Load provider config from YAML, optionally merged with workspace config
   */
  loadProviderConfig(workspacePath?: string): Record<string, ProviderConfig> {
    const userConfig = loadConfig();
    const wsConfig = workspacePath ? loadWorkspaceConfig(workspacePath) : null;
    const merged = mergeConfigs(userConfig, wsConfig);
    return merged.providers || {};
  }
  
  /**
   * Resolve the API key for a provider from config (keychain or env var)
   */
  async resolveApiKey(providerId: string, providerCfg?: ProviderConfig): Promise<string | null> {
    if (!providerCfg) {
      const config = this.loadProviderConfig();
      providerCfg = config[providerId];
    }
    
    if (!providerCfg) return null;
    
    // Check keychain
    if (providerCfg.api_key_keychain_name) {
      const value = await this.secretStore.get(providerCfg.api_key_keychain_name);
      if (value) return value;
    }
    
    // Check env var
    if (providerCfg.api_key_env_var_name) {
      const value = process.env[providerCfg.api_key_env_var_name];
      if (value && value.length > 0) return value;
    }
    
    return null;
  }
  
  // ─── Providers ───────────────────────────────────────────────────────
  
  /**
   * List all providers with configuration status
   */
  async listProviders(): Promise<ProviderInfo[]> {
    const config = this.loadProviderConfig();
    
    const providers: ProviderInfo[] = [];
    
    for (const providerId of getSupportedProviders()) {
      const providerCfg = config[providerId];
      
      let configured = false;
      if (!providerRequiresKey(providerId)) {
        configured = true;
      } else if (providerCfg) {
        const key = await this.resolveApiKey(providerId, providerCfg);
        configured = key !== null;
      }
      
      providers.push({
        id: providerId,
        displayName: getProviderDisplayName(providerId),
        configured,
        healthy: true,
        requiresKey: providerRequiresKey(providerId),
      });
    }
    
    return providers;
  }
  
  /**
   * List models dynamically from provider APIs.
   * 
   * When workspacePaths are provided, workspace config(s) are overlayed on top
   * of user config. Only configured/enabled models are returned.
   */
  async listModels(workspacePaths: string[] = []): Promise<ModelInfo[]> {
    // Overlay workspace config(s) on top of user config
    const config = workspacePaths.length > 0
      ? (mergeMultipleWorkspaceConfigs(workspacePaths).providers || {})
      : this.loadProviderConfig();
    const allModels: ModelInfo[] = [];
    
    for (const providerId of getSupportedProviders()) {
      const providerCfg = config[providerId];
      
      // Skip unconfigured providers (keyless or not — must be in config)
      if (!providerCfg) {
        continue;
      }
      
      const apiKey = await this.resolveApiKey(providerId, providerCfg);
      if (providerRequiresKey(providerId) && !apiKey) {
        continue;
      }
      
      try {
        let models = await fetchModels(providerId, apiKey || undefined, providerCfg?.api_base);
        
        // Filter by enabled_models if the list is set
        const enabledModels = providerCfg?.enabled_models;
        if (enabledModels && enabledModels.length > 0) {
          const enabledSet = new Set(enabledModels);
          models = models.filter(m => {
            const bareId = m.id.replace(`${providerId}/`, '');
            return enabledSet.has(m.id) || enabledSet.has(bareId);
          });
        }
        
        allModels.push(...models);
      } catch (error) {
        console.error(`[State] Failed to list models for ${providerId}:`, error);
      }
    }
    
    return allModels;
  }
  
  /**
   * Discover all models a provider offers, independent of config.
   * Used for browsing/selection UI — does NOT trigger notifications.
   * For keyless providers, works without any config entry.
   * For key-required providers, resolves key from config if available.
   */
  async discoverModels(providerId: string): Promise<ModelInfo[]> {
    const config = this.loadProviderConfig();
    const providerCfg = config[providerId];
    const apiKey = await this.resolveApiKey(providerId, providerCfg);
    
    if (providerRequiresKey(providerId) && !apiKey) {
      return []; // Can't discover without a key
    }
    
    try {
      return await fetchModels(providerId, apiKey || undefined, providerCfg?.api_base);
    } catch (error) {
      console.error(`[State] Failed to discover models for ${providerId}:`, error);
      return [];
    }
  }
  
  /**
   * Stream a chat response
   */
  async* chat(
    model: string,
    messages: Array<{ role: string; content: string }>,
  ): AsyncGenerator<{ type: string; text?: string; finishReason?: string }> {
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
  registerClient(
    clientType: ClientType,
    isSpawner: boolean = false,
    workspacePath?: string
  ): string {
    const clientId = uuidv4();
    
    this.clients.set(clientId, {
      clientId,
      clientType,
      connectedAt: new Date(),
      isSpawner,
      workspacePath,
      workspacePaths: workspacePath ? [workspacePath] : [],
    });
    
    console.log(`[State] Client registered: ${clientId} (${clientType})`);
    
    return clientId;
  }
  
  /**
   * Unregister a client
   */
  unregisterClient(clientId: string): boolean {
    const removed = this.clients.delete(clientId);
    if (removed) {
      console.log(`[State] Client unregistered: ${clientId}`);
    }
    return removed;
  }
  
  /**
   * Get client count
   */
  get clientCount(): number {
    return this.clients.size;
  }
  
  /**
   * Get all connected clients
   */
  getClients(): ConnectedClient[] {
    return Array.from(this.clients.values());
  }
  
  // ─── VS Code Backchannel ─────────────────────────────────────────────
  
  /**
   * Register a VS Code connection with its stream
   */
  registerVSCodeConnection(stream?: any): string {
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
  unregisterVSCodeConnection(id: string): boolean {
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
  updateVSCodeWorkspace(id: string, workspacePath: string, workspaceFolders: string[]): void {
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
  handleVSCodeResponse(connId: string, response: any): void {
    const conn = this.vscodeConnections.get(connId);
    if (!conn) return;
    
    const requestId = response.request_id || response.requestId;
    if (!requestId) return;
    
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
  async sendVSCodeRequest(connId: string, request: any, timeoutMs: number = 10000): Promise<any> {
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
      } catch (err) {
        conn.pendingRequests.delete(requestId);
        clearTimeout(timer);
        reject(err);
      }
    });
  }
  
  /**
   * Send GetWorkspace request to a VS Code connection
   */
  async requestWorkspace(connId: string): Promise<{ workspacePath: string; workspaceFolders: string[] }> {
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
  async invokeVSCodeTool(toolName: string, args: Record<string, unknown>): Promise<{ resultJson: string; isError: boolean }> {
    const connId = this.getFirstVSCodeConnection();
    if (!connId) throw new Error('No VS Code connection available');
    
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
  async listVSCodeModels(familyFilter?: string): Promise<any[]> {
    const connId = this.getFirstVSCodeConnection();
    if (!connId) return [];
    
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
  private getFirstVSCodeConnection(): string | null {
    for (const [id, conn] of this.vscodeConnections) {
      if (conn.stream) return id;
    }
    return null;
  }
  
  /**
   * Notify all connected VS Code instances that models have changed.
   * This triggers a model refresh on the VS Code side.
   */
  notifyModelsChanged(reason: string): void {
    for (const conn of this.vscodeConnections.values()) {
      if (conn.stream) {
        try {
          conn.stream.write({
            request_id: `notify-${Date.now()}`,
            models_changed: { reason },
          });
          console.log(`[State] Sent ModelsChanged notification to VS Code (reason: ${reason})`);
        } catch (err: any) {
          console.error(`[State] Failed to send ModelsChanged notification: ${err.message}`);
        }
      }
    }
  }
  
  /**
   * Get all VS Code workspaces.
   * Checks both backchannel connections and registered VS Code clients.
   */
  getVSCodeWorkspaces(): string[] {
    const workspaces: string[] = [];
    
    // From backchannel connections
    for (const conn of this.vscodeConnections.values()) {
      if (conn.workspacePath && !workspaces.includes(conn.workspacePath)) {
        workspaces.push(conn.workspacePath);
      }
      for (const folder of conn.workspaceFolders) {
        if (!workspaces.includes(folder)) {
          workspaces.push(folder);
        }
      }
    }
    
    // From registered VS Code clients (Register RPC includes workspacePath)
    for (const client of this.clients.values()) {
      if (client.clientType === ClientType.VSCODE && client.workspacePath) {
        if (!workspaces.includes(client.workspacePath)) {
          workspaces.push(client.workspacePath);
        }
      }
    }
    
    return workspaces.sort();
  }
  
  /**
   * Get all VS Code connection IDs
   */
  getVSCodeConnectionIds(): string[] {
    return Array.from(this.vscodeConnections.keys());
  }
  
  /**
   * Check if any VS Code is connected
   */
  hasVSCodeConnection(): boolean {
    return this.vscodeConnections.size > 0;
  }
}
