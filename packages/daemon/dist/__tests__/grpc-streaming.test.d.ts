/**
 * Layer 1: Direct gRPC streaming tests
 *
 * Tests the gRPC Chat streaming RPC directly (client → mock server).
 * No Express, no SSE — pure gRPC streaming isolation.
 *
 * This layer verifies that:
 * - gRPC server-streaming works correctly
 * - Text chunks are received in order
 * - Done/error chunks are handled
 * - Stream cancellation works
 * - Multiple concurrent streams work
 */
export {};
//# sourceMappingURL=grpc-streaming.test.d.ts.map