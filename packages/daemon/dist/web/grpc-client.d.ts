/**
 * Internal gRPC client for the web server to talk to the daemon.
 *
 * When the web server runs in a separate process (started via `openllm web`),
 * it connects to the daemon's Unix socket as a gRPC client.
 */
/**
 * Get or create the gRPC client singleton
 */
export declare function getGrpcClient(): any;
/**
 * Register the web server as a client and return the client ID
 */
export declare function registerWebClient(): Promise<string>;
/**
 * Helper: call a unary RPC and return the result as a promise
 */
export declare function callUnary(client: any, method: string, request: any): Promise<any>;
/**
 * Create a fresh (non-singleton) gRPC client for one-off streaming calls
 */
export declare function createFreshGrpcClient(): any;
/**
 * Close the gRPC client
 */
export declare function closeGrpcClient(): void;
//# sourceMappingURL=grpc-client.d.ts.map