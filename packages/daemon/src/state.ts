/**
 * Central daemon state
 * 
 * The "virtual" layer: manages user-defined provider instances and model entries.
 * Resolves virtual → actual via config + engine metadata from adapter.ts.
 */

import { v4 as uuidv4 } from 'uuid';
import type { SecretStore } from './secrets/types.js';
import { KeychainSecretStore } from './secrets/keychain.js';
import {
  loadConfig,
  loadWorkspaceConfig,
  mergeConfigs,
  mergeMultipleWorkspaceConfigs,
  resolveEngineModelId,
  type ConfigFile,
  type ProviderConfig,
  type ModelConfig,
} from './config/loader.js';
import {
  getEngines,
  getEngine,
  fetchModels,
  streamChat,
  type EngineInfo,
  type ChatParams,
  type DiscoveredModel,
} from './providers/adapter.js';

// ── Client types ───────────────────────────────────────────────────────

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

// ── Virtual provider info (runtime, for API responses) ─────────────────

/**
 * Virtual provider — user-created instance pointing to an engine.
 * The unique ID is `id` (= the config YAML key = virtual provider name).
 */
export interface ProviderInfo {
  /** Virtual provider name = unique ID (e.g., "work-openrouter") */
  id: string;
  /** Actual engine type (e.g., "openrouter") */
  engine: string;
  /** Human-readable label (from config.display_name or engine default) */
  displayName: string;
  /** Whether this provider has been configured with required credentials */
  configured: boolean;
  /** Whether the provider is reachable (from health checks) */
  healthy: boolean;
  /** Whether the underlying engine requires an API key */
  requiresKey: boolean;
  /** Engine's default base URL */
  defaultBaseUrl?: string;
  /** Configured base URL override */
  baseUrl?: string;
}

// ── Virtual model info (runtime, for API responses) ────────────────────

/**
 * Virtual model — user's configured entry for an engine model.
 * The unique ID is `id` = "{provider-id}/{model-name}".
 */
export interface ModelInfo {
  /** Composite unique ID: "{provider-id}/{model-name}" */
  id: string;
  /** Virtual model name = unique ID within provider (the config key) */
  name: string;
  /** Actual engine model ID sent to the API (from model_id field or = name) */
  engineModelId: string;
  /** Virtual provider ID (back-reference) */
  provider: string;
  /** Actual engine type (convenience, from provider) */
  engine: string;
  /** Human-readable display name */
  displayName: string;
  /** Context window size */
  contextWindow: number;
  /** Model capabilities */
  capabilities?: {
    supportsTools?: boolean;
    supportsVision?: boolean;
  };
  /** Per-model parameter overrides from config */
  params?: ModelConfig;
}

// ── VS Code connection ─────────────────────────────────────────────────

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

// ── Central daemon state ───────────────────────────────────────────────

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
  
  // Health status per virtual provider (lazy, updated in background)
  private providerHealth = new Map<string, boolean>();
  
  // Secret store
  public readonly secretStore: SecretStore;
  
  constructor() {
    this.secretStore = new KeychainSecretStore();
  }
  
  // ─── Config ──────────────────────────────────────────────────────────
  
  /**
   * Load provider config from YAML, optionally merged with workspace config.
   * Returns a Record keyed by virtual provider ID (= provider name).
   */
  loadProviderConfig(workspacePath?: string): Record<string, ProviderConfig> {
    const userConfig = loadConfig();
    const wsConfig = workspacePath ? loadWorkspaceConfig(workspacePath) : null;
    const merged = mergeConfigs(userConfig, wsConfig);
    return merged.providers || {};
  }
  
  /**
   * Resolve the API key for a virtual provider from config (keychain or env var).
   * Falls back to the engine's default env var if no explicit config.
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
    
    // Check env var from config
    if (providerCfg.api_key_env_var_name) {
      const value = process.env[providerCfg.api_key_env_var_name];
      if (value && value.length > 0) return value;
    }
    
    // Fall back to engine's default env var
    const engineInfo = getEngine(providerCfg.engine);
    if (engineInfo?.defaultEnvVar) {
      const value = process.env[engineInfo.defaultEnvVar];
      if (value && value.length > 0) return value;
    }
    
    return null;
  }
  
  /**
   * Resolve API key and base URL for an existing provider from config.
   * Used by the edit wizard to discover models without re-entering credentials.
   */
  async resolveProviderCredentials(providerId: string): Promise<{ apiKey?: string; baseUrl?: string }> {
    const config = this.loadProviderConfig();
    const provCfg = config[providerId];
    if (!provCfg) return {};
    
    const apiKey = await this.resolveApiKey(providerId, provCfg);
    return {
      apiKey: apiKey || undefined,
      baseUrl: provCfg.base_url || undefined,
    };
  }
  
  // ─── Providers (virtual layer) ───────────────────────────────────────
  
  /**
   * List all virtual providers with configuration status.
   * Returns only providers that exist in the config (user-created instances).
   */
  async listProviders(workspacePaths: string[] = []): Promise<ProviderInfo[]> {
    const config = workspacePaths.length > 0
      ? (mergeMultipleWorkspaceConfigs(workspacePaths).providers || {})
      : this.loadProviderConfig();
    
    const providers: ProviderInfo[] = [];
    
    for (const [providerId, providerCfg] of Object.entries(config)) {
      const engineInfo = getEngine(providerCfg.engine);
      if (!engineInfo) {
        console.warn(`[State] Unknown engine "${providerCfg.engine}" for provider "${providerId}", skipping`);
        continue;
      }
      
      let configured = false;
      if (!engineInfo.requiresKey) {
        configured = true;
      } else {
        const key = await this.resolveApiKey(providerId, providerCfg);
        configured = key !== null;
      }
      
      providers.push({
        id: providerId,
        engine: providerCfg.engine,
        displayName: providerCfg.display_name || engineInfo.displayName,
        configured,
        healthy: this.providerHealth.get(providerId) ?? true,
        requiresKey: engineInfo.requiresKey,
        defaultBaseUrl: engineInfo.defaultBaseUrl,
        baseUrl: providerCfg.base_url,
      });
    }
    
    return providers;
  }
  
  /**
   * List engines available for the "Add Provider" wizard.
   * Returns the fixed set of engine types from adapter.ts.
   */
  listEngines(): EngineInfo[] {
    return getEngines();
  }
  
  // ─── Models (virtual layer) ──────────────────────────────────────────
  
  /**
   * List all virtual models across all configured providers.
   * 
   * For each virtual provider in config:
   * 1. Fetch models from the engine (discovery)
   * 2. Filter to only models enabled in config
   * 3. Build composite IDs: {provider-id}/{model-name}
   * 4. Attach per-model params from config
   */
  async listModels(workspacePaths: string[] = []): Promise<ModelInfo[]> {
    const config = workspacePaths.length > 0
      ? (mergeMultipleWorkspaceConfigs(workspacePaths).providers || {})
      : this.loadProviderConfig();
    
    const allModels: ModelInfo[] = [];
    
    for (const [providerId, providerCfg] of Object.entries(config)) {
      const engineInfo = getEngine(providerCfg.engine);
      if (!engineInfo) continue;
      
      // Must have models configured
      if (!providerCfg.models || Object.keys(providerCfg.models).length === 0) {
        continue;
      }
      
      // Resolve API key
      const apiKey = await this.resolveApiKey(providerId, providerCfg);
      if (engineInfo.requiresKey && !apiKey) {
        continue;
      }
      
      // Fetch all models from the engine for capability/contextWindow info
      let discoveredModels: DiscoveredModel[] = [];
      try {
        discoveredModels = await fetchModels(providerCfg.engine, apiKey || undefined, providerCfg.base_url);
      } catch (error) {
        console.error(`[State] Failed to fetch models for provider ${providerId}:`, error);
      }
      
      // Build a lookup from engine model ID to discovered model info
      const discoveryMap = new Map<string, DiscoveredModel>();
      for (const dm of discoveredModels) {
        discoveryMap.set(dm.id, dm);
      }
      
      // Create ModelInfo for each enabled model in config
      for (const [modelName, modelCfg] of Object.entries(providerCfg.models)) {
        const engineModelId = resolveEngineModelId(modelName, modelCfg);
        const compositeId = `${providerId}/${modelName}`;
        
        // Try to find discovery info for this model
        const discovered = discoveryMap.get(engineModelId);
        
        allModels.push({
          id: compositeId,
          name: modelName,
          engineModelId,
          provider: providerId,
          engine: providerCfg.engine,
          displayName: modelName,
          contextWindow: discovered?.contextWindow || 0,
          capabilities: discovered?.capabilities,
          params: Object.keys(modelCfg).length > 0 ? modelCfg : undefined,
        });
      }
    }
    
    return allModels;
  }
  
  /**
   * Discover all models an engine offers, independent of config.
   * Used for browsing/selection UI — does NOT trigger notifications.
   * Operates on the actual layer (engine ID, not virtual provider).
   */
  async discoverModels(engineId: string, apiKey?: string, baseUrl?: string): Promise<DiscoveredModel[]> {
    const engineInfo = getEngine(engineId);
    if (!engineInfo) return [];
    
    if (engineInfo.requiresKey && !apiKey) {
      return []; // Can't discover without a key
    }
    
    try {
      return await fetchModels(engineId, apiKey || undefined, baseUrl);
    } catch (error) {
      console.error(`[State] Failed to discover models for engine ${engineId}:`, error);
      return [];
    }
  }
  
  // ─── Chat (virtual → actual resolution) ──────────────────────────────
  
  /**
   * Stream a chat response for a virtual model.
   * 
   * Resolves the composite model ID to:
   * - Virtual provider → engine, API key, base URL
   * - Virtual model → engine model ID, config params
   * 
   * Applies system prompt and merges params (request > config > engine default).
   * 
   * @param compositeModelId - "{provider-id}/{model-name}"
   * @param messages - Chat messages
   * @param requestParams - Per-request parameter overrides (from caller)
   */
  async* chat(
    compositeModelId: string,
    messages: Array<{ role: string; content: string }>,
    requestParams?: ChatParams,
  ): AsyncGenerator<{ type: string; text?: string; finishReason?: string }> {
    console.log(`[State] Chat request: compositeModelId="${compositeModelId}", messages=${messages.length}`);
    
    // ── Split composite ID ──
    const slashIdx = compositeModelId.indexOf('/');
    if (slashIdx === -1) {
      console.error(`[State] Invalid composite model ID (no slash): ${compositeModelId}`);
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    
    const providerId = compositeModelId.substring(0, slashIdx);
    const modelName = compositeModelId.substring(slashIdx + 1);
    console.log(`[State] Chat: providerId="${providerId}", modelName="${modelName}"`);
    
    // ── Look up virtual provider ──
    const config = this.loadProviderConfig();
    const providerCfg = config[providerId];
    if (!providerCfg) {
      console.error(`[State] Provider not found: ${providerId}`);
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    
    const engineInfo = getEngine(providerCfg.engine);
    if (!engineInfo) {
      console.error(`[State] Unknown engine "${providerCfg.engine}" for provider "${providerId}"`);
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    
    // ── Resolve API key ──
    const apiKey = await this.resolveApiKey(providerId, providerCfg);
    if (engineInfo.requiresKey && !apiKey) {
      console.error(`[State] No API key for provider ${providerId}`);
      yield { type: 'done', finishReason: 'error' };
      return;
    }
    
    // ── Look up virtual model ──
    const modelCfg = providerCfg.models?.[modelName];
    const engineModelId = modelCfg
      ? resolveEngineModelId(modelName, modelCfg)
      : modelName; // If model not in config, use name as engine model ID
    
    // ── Apply system prompt ──
    let processedMessages = [...messages];
    if (modelCfg?.system_prompt) {
      const mode = modelCfg.system_prompt_mode || 'prepend';
      processedMessages = applySystemPrompt(processedMessages, modelCfg.system_prompt, mode);
    }
    
    // ── Merge params (3-tier: request > config > engine default) ──
    const mergedParams = mergeParams(modelCfg, requestParams);
    
    // ── Strip engine prefix from model ID for the actual API call ──
    // Engine model IDs are stored as "engineId/bareModelId" (e.g., "openrouter/anthropic/claude-3-haiku")
    // The engine expects just the bare part: "anthropic/claude-3-haiku"
    const bareModelId = stripEnginePrefix(engineModelId, providerCfg.engine);
    
    console.log(`[State] Chat: engine="${providerCfg.engine}", engineModelId="${engineModelId}", bareModelId="${bareModelId}", baseUrl="${providerCfg.base_url || '(none)'}"`);
    
    // ── Call the actual engine ──
    yield* streamChat(
      providerCfg.engine,
      bareModelId,
      processedMessages,
      apiKey || undefined,
      providerCfg.base_url,
      mergedParams,
    );
  }
  
  // ─── Health checks ───────────────────────────────────────────────────
  
  /**
   * Run background health checks for all configured providers.
   * Updates providerHealth map. Does not block.
   */
  async runHealthChecks(): Promise<void> {
    const config = this.loadProviderConfig();
    
    for (const [providerId, providerCfg] of Object.entries(config)) {
      const engineInfo = getEngine(providerCfg.engine);
      if (!engineInfo) {
        this.providerHealth.set(providerId, false);
        continue;
      }
      
      try {
        const apiKey = await this.resolveApiKey(providerId, providerCfg);
        if (engineInfo.requiresKey && !apiKey) {
          this.providerHealth.set(providerId, false);
          continue;
        }
        
        // Attempt model discovery as a health check
        const models = await fetchModels(providerCfg.engine, apiKey || undefined, providerCfg.base_url);
        this.providerHealth.set(providerId, models.length > 0);
      } catch {
        this.providerHealth.set(providerId, false);
      }
    }
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
      for (const [_reqId, pending] of conn.pendingRequests) {
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

// ── Helper functions (module-level) ────────────────────────────────────

/**
 * Apply system prompt to message thread.
 * Always produces exactly ONE system message (never multiple).
 * 
 * - "prepend": prefix config text to existing system message, or create one
 * - "replace": strip all system messages, insert config system_prompt at start
 */
function applySystemPrompt(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  mode: 'prepend' | 'replace',
): Array<{ role: string; content: string }> {
  if (mode === 'replace') {
    // Strip all existing system messages
    const filtered = messages.filter(m => m.role !== 'system');
    // Insert config system_prompt at start
    return [{ role: 'system', content: systemPrompt }, ...filtered];
  }
  
  // Mode: prepend
  const firstSystemIdx = messages.findIndex(m => m.role === 'system');
  if (firstSystemIdx >= 0) {
    // Prefix config text to existing system message content
    const result = [...messages];
    result[firstSystemIdx] = {
      ...result[firstSystemIdx],
      content: `${systemPrompt}\n\n${result[firstSystemIdx].content}`,
    };
    return result;
  }
  
  // No existing system message — create one at the start
  return [{ role: 'system', content: systemPrompt }, ...messages];
}

/**
 * Merge chat params: request overrides > config defaults.
 * Returns a ChatParams object for adapter.streamChat().
 */
function mergeParams(
  configParams?: ModelConfig,
  requestParams?: ChatParams,
): ChatParams | undefined {
  const merged: ChatParams = {};
  let hasAny = false;
  
  // Config defaults
  if (configParams?.temperature != null) { merged.temperature = configParams.temperature; hasAny = true; }
  if (configParams?.top_p != null) { merged.top_p = configParams.top_p; hasAny = true; }
  if (configParams?.top_k != null) { merged.top_k = configParams.top_k; hasAny = true; }
  if (configParams?.max_tokens != null) { merged.maxTokens = configParams.max_tokens; hasAny = true; }
  if (configParams?.timeout != null) { merged.timeout = configParams.timeout; hasAny = true; }
  
  // Request overrides (wins)
  if (requestParams?.temperature != null) { merged.temperature = requestParams.temperature; hasAny = true; }
  if (requestParams?.top_p != null) { merged.top_p = requestParams.top_p; hasAny = true; }
  if (requestParams?.top_k != null) { merged.top_k = requestParams.top_k; hasAny = true; }
  if (requestParams?.maxTokens != null) { merged.maxTokens = requestParams.maxTokens; hasAny = true; }
  if (requestParams?.timeout != null) { merged.timeout = requestParams.timeout; hasAny = true; }
  
  return hasAny ? merged : undefined;
}

/**
 * Strip the engine prefix from an engine model ID.
 * Engine model IDs are stored as "engineId/bareModelId" (e.g., "openrouter/anthropic/claude-3-haiku").
 * The multi-llm-ts engine expects just the bare part: "anthropic/claude-3-haiku".
 */
function stripEnginePrefix(engineModelId: string, engineId: string): string {
  const prefix = `${engineId}/`;
  if (engineModelId.startsWith(prefix)) {
    return engineModelId.substring(prefix.length);
  }
  return engineModelId;
}
