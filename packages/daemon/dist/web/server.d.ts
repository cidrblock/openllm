/**
 * Web dashboard server (embedded in daemon)
 *
 * Runs Express in the daemon process with direct DaemonState access.
 * No gRPC client layer — the web server calls state methods directly.
 *
 * Lifecycle:
 * - Started via `openllm web` or gRPC StartWebServer
 * - Stopped via Ctrl+C, `openllm web` exit, or gRPC StopWebServer
 */
import { type Express } from 'express';
import type { DaemonState } from '../state.js';
/**
 * Create the Express application with direct DaemonState access.
 *
 * Used both for production (embedded in daemon) and testing.
 */
export declare function createWebApp(state: DaemonState): Express;
/**
 * Start the embedded web server in the daemon process.
 * Returns the actual port and URL.
 */
export declare function startEmbeddedWebServer(state: DaemonState, port?: number): Promise<{
    port: number;
    url: string;
}>;
/**
 * Stop the embedded web server.
 */
export declare function stopEmbeddedWebServer(): Promise<void>;
/**
 * Check if the embedded web server is running.
 */
export declare function isWebServerRunning(): boolean;
/**
 * Get the current web server port (null if not running).
 */
export declare function getWebServerPort(): number | null;
//# sourceMappingURL=server.d.ts.map