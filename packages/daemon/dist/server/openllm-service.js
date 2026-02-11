/**
 * OpenLLM gRPC service implementation
 */
import * as grpc from '@grpc/grpc-js';
import { ClientType } from '../state.js';
import { getSupportedProviders, getDefaultEnvVar } from '../providers/adapter.js';
import { startEmbeddedWebServer, stopEmbeddedWebServer, isWebServerRunning, getWebServerPort, } from '../web/server.js';
/**
 * Map proto client type to enum
 */
function toClientType(protoType) {
    switch (protoType) {
        case 'CLIENT_TYPE_VSCODE':
        case 1:
            return ClientType.VSCODE;
        case 'CLIENT_TYPE_CLI':
        case 2:
            return ClientType.CLI;
        case 'CLIENT_TYPE_PYTHON':
        case 3:
            return ClientType.PYTHON;
        case 'CLIENT_TYPE_NODEJS':
        case 4:
            return ClientType.NODEJS;
        case 'CLIENT_TYPE_MCP':
        case 5:
            return ClientType.MCP;
        default:
            return ClientType.UNSPECIFIED;
    }
}
/**
 * Map proto role to string
 */
function toRole(protoRole) {
    switch (protoRole) {
        case 'ROLE_SYSTEM':
        case 0:
            return 'system';
        case 'ROLE_USER':
        case 1:
            return 'user';
        case 'ROLE_ASSISTANT':
        case 2:
            return 'assistant';
        case 'ROLE_TOOL':
        case 3:
            return 'tool';
        default:
            return 'user';
    }
}
/**
 * Create the OpenLLM service handlers
 */
export function createOpenLLMService(state) {
    return {
        /**
         * Register a client with the daemon
         */
        Register(call, callback) {
            const request = call.request;
            // Proto: RegisterRequest { ClientInfo client = 1; bool is_spawner = 2; string workspace_path = 3; }
            // ClientInfo { ClientType client_type = 1; string client_id = 2; string user = 3; }
            const clientInfo = request.client || {};
            const clientType = toClientType(clientInfo.client_type || request.client_type);
            const clientId = state.registerClient(clientType, request.is_spawner || false, request.workspace_path || undefined);
            callback(null, {
                client_id: clientId,
                connected_clients: state.clientCount,
            });
        },
        /**
         * Unregister a client
         */
        Unregister(call, callback) {
            state.unregisterClient(call.request.client_id);
            callback(null, {});
        },
        /**
         * List providers
         */
        ListProviders(call, callback) {
            state.listProviders().then((providers) => {
                callback(null, {
                    providers: providers.map((p) => ({
                        id: p.id,
                        display_name: p.displayName,
                        configured: p.configured,
                        healthy: p.healthy,
                    })),
                });
            }).catch((error) => {
                console.error('[gRPC] ListProviders error:', error);
                callback({
                    code: grpc.status.INTERNAL,
                    message: error.message,
                });
            });
        },
        /**
         * List models (dynamic from provider APIs)
         */
        ListModels(call, callback) {
            state.listModels().then((models) => {
                callback(null, {
                    models: models.map((m) => ({
                        id: m.id,
                        provider: m.provider,
                        display_name: m.displayName,
                        context_window: m.contextWindow,
                        capabilities: {
                            supports_tools: m.capabilities?.supportsTools || false,
                            supports_vision: m.capabilities?.supportsVision || false,
                        },
                    })),
                });
            }).catch((error) => {
                console.error('[gRPC] ListModels error:', error);
                callback({
                    code: grpc.status.INTERNAL,
                    message: error.message,
                });
            });
        },
        /**
         * Streaming chat
         */
        Chat(call) {
            const request = call.request;
            const model = request.model;
            // Convert proto messages to simple format
            const messages = (request.messages || []).map((m) => ({
                role: toRole(m.role),
                content: m.content || '',
            }));
            if (!model) {
                call.write({ error: { code: 'INVALID_ARGUMENT', message: 'Model is required' } });
                call.end();
                return;
            }
            // Stream the response
            (async () => {
                try {
                    for await (const chunk of state.chat(model, messages)) {
                        if (chunk.type === 'text' && chunk.text) {
                            call.write({ text: { text: chunk.text } });
                        }
                        else if (chunk.type === 'done') {
                            call.write({ done: { finish_reason: chunk.finishReason || 'stop' } });
                        }
                    }
                }
                catch (error) {
                    console.error('[gRPC] Chat error:', error.message);
                    call.write({ error: { code: 'INTERNAL', message: error.message } });
                }
                finally {
                    call.end();
                }
            })();
        },
        /**
         * Get secret
         */
        GetSecret(call, callback) {
            const key = call.request.key;
            state.secretStore.get(key).then((value) => {
                callback(null, {
                    value: value || '',
                    found: value !== null,
                });
            }).catch((error) => {
                callback({
                    code: grpc.status.INTERNAL,
                    message: error.message,
                });
            });
        },
        /**
         * Set secret
         */
        SetSecret(call, callback) {
            const { key, value } = call.request;
            state.secretStore.set(key, value).then(() => {
                callback(null, {});
            }).catch((error) => {
                callback({
                    code: grpc.status.INTERNAL,
                    message: error.message,
                });
            });
        },
        /**
         * Delete secret
         */
        DeleteSecret(call, callback) {
            state.secretStore.delete(call.request.key).then(() => {
                callback(null, {});
            }).catch((error) => {
                callback({
                    code: grpc.status.INTERNAL,
                    message: error.message,
                });
            });
        },
        /**
         * List secrets
         */
        ListSecrets(call, callback) {
            // Return known key names with availability status
            const providers = getSupportedProviders();
            const checks = providers.map(async (pid) => {
                const envVar = getDefaultEnvVar(pid);
                const key = envVar || `${pid.toUpperCase()}_API_KEY`;
                const hasValue = await state.secretStore.has(key);
                return { key, has_value: hasValue };
            });
            Promise.all(checks).then((secrets) => {
                callback(null, { secrets });
            }).catch((error) => {
                callback({
                    code: grpc.status.INTERNAL,
                    message: error.message,
                });
            });
        },
        /**
         * Get connected workspaces from VS Code clients
         */
        GetConnectedWorkspaces(call, callback) {
            const workspaces = state.getVSCodeWorkspaces();
            callback(null, { workspaces });
        },
        /**
         * VS Code bidirectional stream
         *
         * Proto: rpc VSCodeStream(stream VSCodeResponse) returns (stream VSCodeRequest)
         * - VS Code sends VSCodeResponse messages (input stream)
         * - Daemon sends VSCodeRequest messages (output stream)
         */
        VSCodeStream(call) {
            const connId = state.registerVSCodeConnection(call);
            console.log(`[gRPC] VS Code stream started: ${connId}`);
            // Immediately request workspace info from VS Code
            setTimeout(async () => {
                try {
                    console.log(`[gRPC] Requesting workspace from VS Code (${connId})...`);
                    const ws = await state.requestWorkspace(connId);
                    console.log(`[gRPC] Got workspace: ${ws.workspacePath} (${ws.workspaceFolders.length} folders)`);
                }
                catch (err) {
                    console.error(`[gRPC] Failed to get workspace from VS Code: ${err.message}`);
                }
            }, 100);
            // Handle incoming responses from VS Code
            call.on('data', (response) => {
                console.log(`[gRPC] VS Code response received:`, Object.keys(response));
                // Route the response to the pending request handler
                state.handleVSCodeResponse(connId, response);
            });
            call.on('end', () => {
                console.log(`[gRPC] VS Code stream ended: ${connId}`);
                state.unregisterVSCodeConnection(connId);
                call.end();
            });
            call.on('error', (error) => {
                console.error(`[gRPC] VS Code stream error: ${error.message}`);
                state.unregisterVSCodeConnection(connId);
            });
        },
        /**
         * Get daemon status
         */
        GetStatus(call, callback) {
            const clients = state.getClients();
            callback(null, {
                version: state.version,
                started_at: {
                    seconds: String(Math.floor(state.startedAt.getTime() / 1000)),
                    nanos: 0,
                },
                connected_clients: state.clientCount,
                active_sessions: 0, // Sessions deferred
                clients: clients.map(c => ({
                    client_id: c.clientId,
                    client_type: c.clientType === 'VSCODE' ? 1 : c.clientType === 'CLI' ? 2 : 0,
                    connected_at: {
                        seconds: String(Math.floor(c.connectedAt.getTime() / 1000)),
                        nanos: 0,
                    },
                    is_spawner: c.isSpawner,
                    workspace_path: c.workspacePath || '',
                })),
            });
        },
        /**
         * Health check
         */
        HealthCheck(call, callback) {
            callback(null, {
                healthy: true,
                version: state.version,
            });
        },
        /**
         * Get current configuration
         */
        GetConfig(call, callback) {
            const config = state.loadProviderConfig();
            const providers = {};
            for (const [pid, pcfg] of Object.entries(config)) {
                providers[pid] = {
                    enabled: true,
                    api_key_ref: pcfg.api_key_keychain_name || pcfg.api_key_env_var_name || '',
                    base_url: pcfg.api_base || '',
                };
            }
            callback(null, {
                default_model: '',
                providers,
                session_ttl_days: 0,
                log_level: 3, // INFO
            });
        },
        /**
         * Update configuration (not fully implemented yet)
         */
        UpdateConfig(call, callback) {
            // For now, just return the existing config
            const config = state.loadProviderConfig();
            callback(null, {
                default_model: '',
                providers: {},
                session_ttl_days: 0,
                log_level: 3,
            });
        },
        /**
         * Get provider status
         */
        GetProviderStatus(call, callback) {
            const providerId = call.request.provider_id;
            state.listProviders().then(providers => {
                const provider = providers.find(p => p.id === providerId);
                if (!provider) {
                    callback({ code: grpc.status.NOT_FOUND, message: `Provider not found: ${providerId}` });
                    return;
                }
                callback(null, {
                    provider_id: providerId,
                    configured: provider.configured,
                    healthy: provider.healthy,
                });
            }).catch(error => {
                callback({ code: grpc.status.INTERNAL, message: error.message });
            });
        },
        /**
         * Start the embedded web server
         */
        StartWebServer(call, callback) {
            const port = call.request.port || 8787;
            if (isWebServerRunning()) {
                const currentPort = getWebServerPort();
                callback(null, {
                    started: false,
                    already_running: true,
                    port: currentPort,
                    url: `http://localhost:${currentPort}`,
                });
                return;
            }
            startEmbeddedWebServer(state, port).then(({ port: actualPort, url }) => {
                callback(null, {
                    started: true,
                    already_running: false,
                    port: actualPort,
                    url,
                });
            }).catch((error) => {
                callback({
                    code: grpc.status.INTERNAL,
                    message: `Failed to start web server: ${error.message}`,
                });
            });
        },
        /**
         * Stop the embedded web server
         */
        StopWebServer(call, callback) {
            stopEmbeddedWebServer().then(() => {
                callback(null, {});
            }).catch((error) => {
                callback({
                    code: grpc.status.INTERNAL,
                    message: error.message,
                });
            });
        },
        /**
         * Shutdown the daemon
         */
        Shutdown(call, callback) {
            console.log('[gRPC] Shutdown requested');
            callback(null, {});
            setTimeout(() => {
                process.emit('SIGTERM', 'SIGTERM');
            }, 100);
        },
        // ─── Stub RPCs (not yet implemented) ──────────────────────────────────
        /**
         * Session RPCs (deferred)
         */
        SessionChat(call) {
            call.write({ error: { code: 'UNIMPLEMENTED', message: 'Session chat not yet implemented' } });
            call.end();
        },
        CreateSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
        },
        GetSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
        },
        ListSessions(call, callback) {
            callback(null, { sessions: [], total_count: 0 });
        },
        DeleteSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
        },
        WatchSessions(call) {
            call.end();
        },
        ReplaySession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
        },
        SummarizeSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
        },
        ForkSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
        },
        ExportSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
        },
        ImportSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Sessions not yet implemented' });
        },
        /**
         * Tool RPCs (stub - future MCP integration)
         */
        ListTools(call, callback) {
            callback(null, { tools: [] });
        },
        ExecuteTool(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Tool execution not yet implemented' });
        },
        /**
         * MCP Server Registration (stub)
         */
        RegisterMcpServer(call, callback) {
            callback(null, {});
        },
        UnregisterMcpServer(call, callback) {
            callback(null, {});
        },
    };
}
//# sourceMappingURL=openllm-service.js.map