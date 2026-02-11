/**
 * Transport layer for daemon communication
 *
 * Handles Unix socket (Linux/macOS) and named pipe (Windows) transport.
 */
export interface Transport {
    type: 'unix' | 'tcp';
    socketPath?: string;
    host?: string;
    port?: number;
}
/**
 * Get the default socket path for the current platform
 */
export declare function getDefaultSocketPath(): string;
/**
 * Get the PID file path
 */
export declare function getPidFilePath(): string;
/**
 * Ensure the socket directory exists
 */
export declare function ensureSocketDir(): void;
/**
 * Ensure the config directory exists
 */
export declare function ensureConfigDir(): void;
/**
 * Clean up stale socket file
 */
export declare function cleanupSocket(): void;
/**
 * Write PID file
 */
export declare function writePidFile(): void;
/**
 * Read PID from file
 */
export declare function readPidFile(): number | null;
/**
 * Remove PID file
 */
export declare function removePidFile(): void;
/**
 * Check if a process is running
 */
export declare function isProcessRunning(pid: number): boolean;
/**
 * Check if daemon is running by testing socket connection
 */
export declare function isDaemonRunning(): boolean;
/**
 * Check daemon status synchronously (best effort)
 *
 * Only considers the daemon running if:
 * 1. PID file exists AND the process is alive, OR
 * 2. None of the above — if only a stale socket exists, we treat it as not running
 */
export declare function isDaemonRunningSync(): boolean;
/**
 * Kill daemon process
 */
export declare function killDaemon(): boolean;
/**
 * Get transport configuration
 */
export declare function getTransport(): Transport;
//# sourceMappingURL=transport.d.ts.map