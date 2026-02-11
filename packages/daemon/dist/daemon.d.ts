/**
 * Daemon lifecycle management
 */
import { DaemonState } from './state.js';
/**
 * Start the daemon (gRPC server only, no web).
 * Returns the DaemonState for callers that need it (e.g. `openllm web` in-process mode).
 */
export declare function startDaemon(opts?: {
    keepAlive?: boolean;
}): Promise<DaemonState>;
/**
 * Get the current DaemonState (if daemon is running in-process).
 */
export declare function getDaemonState(): DaemonState | null;
/**
 * Stop external daemon
 */
export declare function stopDaemon(): Promise<void>;
/**
 * Get daemon status
 */
export declare function getDaemonStatus(): {
    running: boolean;
    pid: number | null;
    socketPath: string;
};
//# sourceMappingURL=daemon.d.ts.map