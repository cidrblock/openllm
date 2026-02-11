/**
 * Central daemon state
 */
import type { SecretStore } from './secrets/types.js';
import { type ProviderConfig } from './config/loader.js';
/**
 * Client type enum (matches proto)
 */
export declare enum ClientType {
    UNSPECIFIED = "UNSPECIFIED",
    VSCODE = "VSCODE",
    CLI = "CLI",
    PYTHON = "PYTHON",
    NODEJS = "NODEJS",
    MCP = "MCP"
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
}
/**
 * Provider information
 */
export interface ProviderInfo {
    id: string;
    displayName: string;
    configured: boolean;
    healthy: boolean;
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
    stream?: any;
    pendingRequests: Map<string, {
        resolve: (response: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>;
}
/**
 * Central daemon state
 */
export declare class DaemonState {
    readonly version = "0.1.0";
    readonly startedAt: Date;
    private clients;
    private vscodeConnections;
    readonly secretStore: SecretStore;
    constructor();
    /**
     * Load provider config from YAML, optionally merged with workspace config
     */
    loadProviderConfig(workspacePath?: string): Record<string, ProviderConfig>;
    /**
     * Resolve the API key for a provider from config (keychain or env var)
     */
    resolveApiKey(providerId: string, providerCfg?: ProviderConfig): Promise<string | null>;
    /**
     * List all providers with configuration status
     */
    listProviders(): Promise<ProviderInfo[]>;
    /**
     * List models dynamically from provider APIs
     */
    listModels(): Promise<ModelInfo[]>;
    /**
     * Stream a chat response
     */
    chat(model: string, messages: Array<{
        role: string;
        content: string;
    }>): AsyncGenerator<{
        type: string;
        text?: string;
        finishReason?: string;
    }>;
    /**
     * Register a new client
     */
    registerClient(clientType: ClientType, isSpawner?: boolean, workspacePath?: string): string;
    /**
     * Unregister a client
     */
    unregisterClient(clientId: string): boolean;
    /**
     * Get client count
     */
    get clientCount(): number;
    /**
     * Get all connected clients
     */
    getClients(): ConnectedClient[];
    /**
     * Register a VS Code connection with its stream
     */
    registerVSCodeConnection(stream?: any): string;
    /**
     * Unregister a VS Code connection
     */
    unregisterVSCodeConnection(id: string): boolean;
    /**
     * Update VS Code workspace info
     */
    updateVSCodeWorkspace(id: string, workspacePath: string, workspaceFolders: string[]): void;
    /**
     * Handle a response from VS Code (resolve pending request)
     */
    handleVSCodeResponse(connId: string, response: any): void;
    /**
     * Send a request to VS Code via the backchannel stream and wait for response
     */
    sendVSCodeRequest(connId: string, request: any, timeoutMs?: number): Promise<any>;
    /**
     * Send GetWorkspace request to a VS Code connection
     */
    requestWorkspace(connId: string): Promise<{
        workspacePath: string;
        workspaceFolders: string[];
    }>;
    /**
     * Send InvokeTool request to VS Code
     */
    invokeVSCodeTool(toolName: string, args: Record<string, unknown>): Promise<{
        resultJson: string;
        isError: boolean;
    }>;
    /**
     * Send ListVSCodeModels request
     */
    listVSCodeModels(familyFilter?: string): Promise<any[]>;
    /**
     * Get the first available VS Code connection ID
     */
    private getFirstVSCodeConnection;
    /**
     * Get all VS Code workspaces
     */
    getVSCodeWorkspaces(): string[];
    /**
     * Get all VS Code connection IDs
     */
    getVSCodeConnectionIds(): string[];
    /**
     * Check if any VS Code is connected
     */
    hasVSCodeConnection(): boolean;
}
//# sourceMappingURL=state.d.ts.map