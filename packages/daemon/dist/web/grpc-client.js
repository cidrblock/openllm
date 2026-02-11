/**
 * Internal gRPC client for the web server to talk to the daemon.
 *
 * When the web server runs in a separate process (started via `openllm web`),
 * it connects to the daemon's Unix socket as a gRPC client.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultSocketPath } from '../transport.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Proto path relative to built dist
const PROTO_PATH = path.resolve(__dirname, '../../../../proto/openllm/v1/service.proto');
const PROTO_INCLUDE = path.resolve(__dirname, '../../../../proto');
let _client = null;
let _clientId = null;
/**
 * Get or create the gRPC client singleton
 */
export function getGrpcClient() {
    if (!_client) {
        const socketPath = getDefaultSocketPath();
        const address = `unix://${socketPath}`;
        const packageDef = protoLoader.loadSync(PROTO_PATH, {
            keepCase: true,
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
            includeDirs: [PROTO_INCLUDE],
        });
        const proto = grpc.loadPackageDefinition(packageDef);
        _client = new proto.openllm.v1.OpenLLM(address, grpc.credentials.createInsecure());
    }
    return _client;
}
/**
 * Register the web server as a client and return the client ID
 */
export async function registerWebClient() {
    if (_clientId)
        return _clientId;
    const client = getGrpcClient();
    const response = await callUnary(client, 'Register', {
        client: { client_type: 2 }, // CLI type for web
        is_spawner: false,
    });
    _clientId = response.client_id;
    return _clientId;
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
/**
 * Create a fresh (non-singleton) gRPC client for one-off streaming calls
 */
export function createFreshGrpcClient() {
    const socketPath = getDefaultSocketPath();
    const address = `unix://${socketPath}`;
    console.log(`[grpc-client] Creating fresh client: proto=${PROTO_PATH}, addr=${address}`);
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
 * Close the gRPC client
 */
export function closeGrpcClient() {
    if (_client) {
        _client.close();
        _client = null;
        _clientId = null;
    }
}
//# sourceMappingURL=grpc-client.js.map