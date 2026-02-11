/**
 * OpenLLM gRPC service implementation
 */
import * as grpc from '@grpc/grpc-js';
import { DaemonState } from '../state.js';
/**
 * Create the OpenLLM service handlers
 */
export declare function createOpenLLMService(state: DaemonState): {
    /**
     * Register a client with the daemon
     */
    Register(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Unregister a client
     */
    Unregister(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * List providers
     */
    ListProviders(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * List models (dynamic from provider APIs)
     */
    ListModels(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Streaming chat
     */
    Chat(call: grpc.ServerWritableStream<any, any>): void;
    /**
     * Get secret
     */
    GetSecret(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Set secret
     */
    SetSecret(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Delete secret
     */
    DeleteSecret(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * List secrets
     */
    ListSecrets(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Get connected workspaces from VS Code clients
     */
    GetConnectedWorkspaces(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * VS Code bidirectional stream
     *
     * Proto: rpc VSCodeStream(stream VSCodeResponse) returns (stream VSCodeRequest)
     * - VS Code sends VSCodeResponse messages (input stream)
     * - Daemon sends VSCodeRequest messages (output stream)
     */
    VSCodeStream(call: grpc.ServerDuplexStream<any, any>): void;
    /**
     * Get daemon status
     */
    GetStatus(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Health check
     */
    HealthCheck(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Get current configuration
     */
    GetConfig(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Update configuration (not fully implemented yet)
     */
    UpdateConfig(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Get provider status
     */
    GetProviderStatus(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Start the embedded web server
     */
    StartWebServer(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Stop the embedded web server
     */
    StopWebServer(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Shutdown the daemon
     */
    Shutdown(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Session RPCs (deferred)
     */
    SessionChat(call: grpc.ServerWritableStream<any, any>): void;
    CreateSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    GetSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    ListSessions(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    DeleteSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    WatchSessions(call: grpc.ServerWritableStream<any, any>): void;
    ReplaySession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    SummarizeSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    ForkSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    ExportSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    ImportSession(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * Tool RPCs (stub - future MCP integration)
     */
    ListTools(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    ExecuteTool(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    /**
     * MCP Server Registration (stub)
     */
    RegisterMcpServer(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
    UnregisterMcpServer(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>): void;
};
//# sourceMappingURL=openllm-service.d.ts.map