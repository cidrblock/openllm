/**
 * Mock gRPC daemon server for testing.
 *
 * Implements the OpenLLM gRPC service with predictable, deterministic responses.
 * Uses TCP (127.0.0.1:0) so tests don't need Unix socket permissions.
 */
import * as grpc from '@grpc/grpc-js';
/**
 * Options for the mock Chat handler
 */
export interface MockChatOptions {
    /** Text chunks to stream (default: ['Hello', ' world', '!']) */
    chunks?: string[];
    /** Delay between chunks in ms (default: 10) */
    chunkDelayMs?: number;
    /** Finish reason (default: 'stop') */
    finishReason?: string;
    /** If set, return an error instead of streaming */
    errorMessage?: string;
    /** If set, delay this long before first chunk (simulates processing) */
    initialDelayMs?: number;
}
/**
 * A running mock daemon with its gRPC address
 */
export interface MockDaemon {
    /** gRPC address (e.g. "127.0.0.1:50123") */
    address: string;
    /** The gRPC server instance */
    server: grpc.Server;
    /** Port the server is listening on */
    port: number;
    /** Stop the mock daemon */
    stop: () => Promise<void>;
    /** Update mock Chat behavior at runtime */
    setChatOptions: (opts: MockChatOptions) => void;
    /** Record of received Chat requests */
    chatRequests: Array<{
        model: string;
        messages: any[];
    }>;
    /** Record of received Register requests */
    registerRequests: any[];
}
/**
 * Create and start a mock daemon gRPC server.
 * Binds to a random TCP port on localhost.
 */
export declare function createMockDaemon(chatOptions?: MockChatOptions): Promise<MockDaemon>;
/**
 * Create a gRPC client connected to the given address (for testing)
 */
export declare function createTestClient(address: string): any;
/**
 * Helper: call a unary RPC and return the result as a promise
 */
export declare function callUnary(client: any, method: string, request: any): Promise<any>;
//# sourceMappingURL=mock-daemon.d.ts.map