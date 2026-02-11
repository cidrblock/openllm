/**
 * Thin gRPC client used ONLY by `openllm web` CLI (Case A)
 * to send StartWebServer / StopWebServer to an already-running daemon.
 *
 * This is NOT used by the web dashboard itself — the dashboard
 * calls DaemonState directly (no gRPC in the loop).
 */
/**
 * Send StartWebServer gRPC to an already-running daemon.
 */
export declare function sendStartWebServer(port: number): Promise<{
    started: boolean;
    already_running: boolean;
    port: number;
    url: string;
}>;
/**
 * Send StopWebServer gRPC to an already-running daemon.
 */
export declare function sendStopWebServer(): Promise<void>;
//# sourceMappingURL=grpc-web-control.d.ts.map