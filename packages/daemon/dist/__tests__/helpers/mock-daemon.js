/**
 * Mock gRPC daemon server for testing.
 *
 * Implements the OpenLLM gRPC service with predictable, deterministic responses.
 * Uses TCP (127.0.0.1:0) so tests don't need Unix socket permissions.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Proto path relative to this test helper
const PROTO_PATH = path.resolve(__dirname, '../../../../../proto/openllm/v1/service.proto');
const PROTO_INCLUDE = path.resolve(__dirname, '../../../../../proto');
/**
 * Create and start a mock daemon gRPC server.
 * Binds to a random TCP port on localhost.
 */
export async function createMockDaemon(chatOptions) {
    let currentChatOptions = chatOptions || {};
    const chatRequests = [];
    const registerRequests = [];
    // Load proto
    const packageDef = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [PROTO_INCLUDE],
    });
    const proto = grpc.loadPackageDefinition(packageDef);
    const openllmProto = proto.openllm.v1;
    const server = new grpc.Server();
    // ─── Service implementation ───────────────────────────────────────────
    server.addService(openllmProto.OpenLLM.service, {
        /**
         * Register - return a mock client ID
         */
        Register(call, callback) {
            registerRequests.push(call.request);
            callback(null, {
                client_id: 'mock-client-001',
                connected_clients: 1,
            });
        },
        Unregister(call, callback) {
            callback(null, {});
        },
        /**
         * Chat - Stream text chunks with configurable behavior
         */
        Chat(call) {
            const request = call.request;
            chatRequests.push({
                model: request.model,
                messages: request.messages || [],
            });
            const opts = currentChatOptions;
            const chunks = opts.chunks || ['Hello', ' world', '!'];
            const delayMs = opts.chunkDelayMs ?? 10;
            const finishReason = opts.finishReason || 'stop';
            const initialDelay = opts.initialDelayMs ?? 0;
            if (opts.errorMessage) {
                call.write({ error: { code: 'INTERNAL', message: opts.errorMessage } });
                call.end();
                return;
            }
            // Stream chunks asynchronously
            (async () => {
                try {
                    if (initialDelay > 0) {
                        await sleep(initialDelay);
                    }
                    for (const text of chunks) {
                        // Check if stream was cancelled
                        if (call.cancelled) {
                            return;
                        }
                        call.write({ text: { text } });
                        if (delayMs > 0) {
                            await sleep(delayMs);
                        }
                    }
                    if (!call.cancelled) {
                        call.write({ done: { finish_reason: finishReason } });
                        call.end();
                    }
                }
                catch (err) {
                    // Stream may have been cancelled/closed
                    if (!call.cancelled) {
                        try {
                            call.end();
                        }
                        catch { }
                    }
                }
            })();
        },
        /**
         * HealthCheck
         */
        HealthCheck(call, callback) {
            callback(null, {
                healthy: true,
                version: '0.1.0-mock',
            });
        },
        /**
         * GetStatus
         */
        GetStatus(call, callback) {
            callback(null, {
                version: '0.1.0-mock',
                started_at: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 },
                connected_clients: 1,
                active_sessions: 0,
                clients: [],
            });
        },
        /**
         * ListProviders
         */
        ListProviders(call, callback) {
            callback(null, {
                providers: [
                    { id: 'openai', display_name: 'OpenAI', configured: true, healthy: true },
                    { id: 'anthropic', display_name: 'Anthropic', configured: false, healthy: true },
                ],
            });
        },
        /**
         * ListModels
         */
        ListModels(call, callback) {
            callback(null, {
                models: [
                    { id: 'openai/gpt-4o', provider: 'openai', display_name: 'GPT-4o' },
                    { id: 'openai/gpt-4o-mini', provider: 'openai', display_name: 'GPT-4o Mini' },
                ],
            });
        },
        /**
         * GetConnectedWorkspaces
         */
        GetConnectedWorkspaces(call, callback) {
            callback(null, { workspaces: ['/home/test/project'] });
        },
        /**
         * Secrets - in-memory store for testing
         */
        GetSecret(call, callback) {
            callback(null, { value: 'mock-secret-value', found: true });
        },
        SetSecret(call, callback) {
            callback(null, {});
        },
        DeleteSecret(call, callback) {
            callback(null, {});
        },
        ListSecrets(call, callback) {
            callback(null, {
                secrets: [
                    { key: 'OPENAI_API_KEY', has_value: true },
                    { key: 'ANTHROPIC_API_KEY', has_value: false },
                ],
            });
        },
        /**
         * Config
         */
        GetConfig(call, callback) {
            callback(null, { default_model: '', providers: {}, session_ttl_days: 0, log_level: 3 });
        },
        UpdateConfig(call, callback) {
            callback(null, { default_model: '', providers: {}, session_ttl_days: 0, log_level: 3 });
        },
        GetProviderStatus(call, callback) {
            callback(null, { provider_id: call.request.provider_id, configured: true, healthy: true });
        },
        Shutdown(call, callback) {
            callback(null, {});
        },
        // ─── Stub RPCs ──────────────────────────────────────────────────────
        SessionChat(call) {
            call.write({ error: { code: 'UNIMPLEMENTED', message: 'Not implemented in mock' } });
            call.end();
        },
        CreateSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
        },
        GetSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
        },
        ListSessions(call, callback) {
            callback(null, { sessions: [], total_count: 0 });
        },
        DeleteSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
        },
        WatchSessions(call) { call.end(); },
        ReplaySession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
        },
        SummarizeSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
        },
        ForkSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
        },
        ExportSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
        },
        ImportSession(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
        },
        ListTools(call, callback) {
            callback(null, { tools: [] });
        },
        ExecuteTool(call, callback) {
            callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented in mock' });
        },
        RegisterMcpServer(call, callback) {
            callback(null, {});
        },
        UnregisterMcpServer(call, callback) {
            callback(null, {});
        },
        VSCodeStream(call) {
            call.on('end', () => call.end());
        },
    });
    // ─── Bind to random TCP port ──────────────────────────────────────────
    const boundPort = await new Promise((resolve, reject) => {
        server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (error, port) => {
            if (error)
                reject(error);
            else
                resolve(port);
        });
    });
    const address = `127.0.0.1:${boundPort}`;
    return {
        address,
        server,
        port: boundPort,
        stop: () => new Promise((resolve) => {
            server.tryShutdown(() => resolve());
        }),
        setChatOptions: (opts) => {
            currentChatOptions = opts;
        },
        chatRequests,
        registerRequests,
    };
}
/**
 * Create a gRPC client connected to the given address (for testing)
 */
export function createTestClient(address) {
    const packageDef = protoLoader.loadSync(PROTO_PATH, {
        keepCase: true,
        longs: String,
        enums: String,
        defaults: true,
        oneofs: true,
        includeDirs: [PROTO_INCLUDE],
    });
    const proto = grpc.loadPackageDefinition(packageDef);
    return new proto.openllm.v1.OpenLLM(address, grpc.credentials.createInsecure());
}
/**
 * Helper: call a unary RPC and return the result as a promise
 */
export function callUnary(client, method, request) {
    return new Promise((resolve, reject) => {
        client[method](request, (error, response) => {
            if (error)
                reject(error);
            else
                resolve(response);
        });
    });
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=mock-daemon.js.map