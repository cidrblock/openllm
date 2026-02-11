/**
 * Layer 2: Express SSE tests (direct DaemonState)
 *
 * Tests the web server's SSE chat endpoint with a mock DaemonState.
 * No gRPC in the loop — the Express app calls DaemonState directly.
 *
 *   HTTP POST → Express → DaemonState.chat() → SSE events → HTTP response
 *
 * This layer verifies that:
 * - Express correctly calls DaemonState methods
 * - SSE events are properly formatted
 * - Text chunks arrive in order via SSE
 * - Error handling works
 * - Multiple concurrent SSE connections work
 * - Client disconnect stops streaming
 */
export {};
//# sourceMappingURL=web-sse.test.d.ts.map