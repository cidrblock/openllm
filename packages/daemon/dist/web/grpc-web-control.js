/**
 * Thin gRPC client used ONLY by `openllm web` CLI (Case A)
 * to send StartWebServer / StopWebServer to an already-running daemon.
 *
 * This is NOT used by the web dashboard itself — the dashboard
 * calls DaemonState directly (no gRPC in the loop).
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDefaultSocketPath } from '../transport.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROTO_PATH = path.resolve(__dirname, '../../../../proto/openllm/v1/service.proto');
const PROTO_INCLUDE = path.resolve(__dirname, '../../../../proto');
function createClient() {
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
    return new proto.openllm.v1.OpenLLM(address, grpc.credentials.createInsecure());
}
function callUnary(client, method, request) {
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
 * Send StartWebServer gRPC to an already-running daemon.
 */
export async function sendStartWebServer(port) {
    const client = createClient();
    try {
        const result = await callUnary(client, 'StartWebServer', { port });
        return result;
    }
    finally {
        client.close();
    }
}
/**
 * Send StopWebServer gRPC to an already-running daemon.
 */
export async function sendStopWebServer() {
    const client = createClient();
    try {
        await callUnary(client, 'StopWebServer', {});
    }
    finally {
        client.close();
    }
}
//# sourceMappingURL=grpc-web-control.js.map