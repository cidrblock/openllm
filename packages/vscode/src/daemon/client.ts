/**
 * OpenLLM Daemon Client for VS Code Extension
 * 
 * This module provides the gRPC client for communicating with the OpenLLM daemon.
 * The client is generated from proto/openllm/v1/service.proto
 * 
 * The daemon uses Unix Domain Sockets for local IPC:
 * - Socket: $XDG_RUNTIME_DIR/openllm/daemon.sock (or ~/.openllm/daemon.sock)
 * - PID file: $XDG_RUNTIME_DIR/openllm/daemon.pid (or ~/.openllm/daemon.pid)
 */

import { createChannel, createClient, Channel, ClientError, Status } from 'nice-grpc';
import * as proto from '../proto/openllm/v1/service';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from '../utils/logger';

// Re-export the generated types for convenience
export * from '../proto/openllm/v1/service';

/**
 * Get the OpenLLM runtime directory.
 * Uses XDG_RUNTIME_DIR if available (Linux standard), otherwise ~/.openllm/
 */
function getOpenLLMDir(): string {
    const xdgRuntime = process.env.XDG_RUNTIME_DIR;
    if (xdgRuntime) {
        return path.join(xdgRuntime, 'openllm');
    }
    return path.join(os.homedir(), '.openllm');
}

// Daemon paths
const OPENLLM_DIR = getOpenLLMDir();
const PID_FILE = path.join(OPENLLM_DIR, 'daemon.pid');
const SOCKET_FILE = path.join(OPENLLM_DIR, 'daemon.sock');

// gRPC address for Unix Domain Socket
const DEFAULT_DAEMON_ADDRESS = `unix://${SOCKET_FILE}`;

// Extension path for finding bundled binaries (set during activation)
let extensionPath: string | undefined;

/**
 * Set the extension path for finding bundled binaries.
 * Must be called during extension activation before connecting to daemon.
 */
export function setExtensionPath(path: string): void {
    extensionPath = path;
}

/**
 * Check if the daemon is running by verifying PID file and process
 */
export function isDaemonRunning(): boolean {
    try {
        if (!fs.existsSync(PID_FILE)) {
            return false;
        }
        
        const pidStr = fs.readFileSync(PID_FILE, 'utf-8').trim();
        const pid = parseInt(pidStr, 10);
        
        if (isNaN(pid)) {
            return false;
        }
        
        // Check if process is running (signal 0 just checks existence)
        process.kill(pid, 0);
        
        // Also verify socket exists
        return fs.existsSync(SOCKET_FILE);
    } catch (e) {
        // process.kill throws if process doesn't exist
        return false;
    }
}

/**
 * Get the daemon PID if running
 */
export function getDaemonPid(): number | null {
    try {
        if (!fs.existsSync(PID_FILE)) {
            return null;
        }
        
        const pidStr = fs.readFileSync(PID_FILE, 'utf-8').trim();
        const pid = parseInt(pidStr, 10);
        
        if (isNaN(pid)) {
            return null;
        }
        
        // Verify process exists
        process.kill(pid, 0);
        return pid;
    } catch (e) {
        return null;
    }
}

/**
 * Get daemon socket path
 */
export function getSocketPath(): string {
    return SOCKET_FILE;
}

/**
 * Get daemon directory
 */
export function getDaemonDir(): string {
    return OPENLLM_DIR;
}

/**
 * Wrapper around the generated OpenLLM gRPC client
 */
export class DaemonClient {
    private channel: Channel | null = null;
    private client: proto.OpenLLMClient | null = null;
    private clientId: string | null = null;
    private address: string;

    constructor(address: string = DEFAULT_DAEMON_ADDRESS) {
        this.address = address;
    }

    /**
     * Connect to the daemon.
     * By default, will auto-start the daemon if it's not running.
     * 
     * @param options.autoStart - Start daemon if not running (default: true)
     * @param options.timeout - Timeout waiting for daemon to start (default: 15000ms)
     */
    async connect(options: { autoStart?: boolean; timeout?: number } = {}): Promise<void> {
        if (this.channel) {
            return; // Already connected
        }

        const { autoStart = true, timeout = 15000 } = options;

        // Check if daemon is running
        if (!isDaemonRunning()) {
            if (autoStart) {
                await this.startDaemon();
                // Wait for daemon to be ready
                await this.waitForDaemon(timeout);
            } else {
                throw new Error(
                    `OpenLLM daemon is not running. ` +
                    `Expected socket at ${SOCKET_FILE}. ` +
                    `Start the daemon with: openllm daemon start`
                );
            }
        }

        this.channel = createChannel(this.address);
        this.client = createClient(proto.OpenLLMDefinition, this.channel);
    }

    /**
     * Start the daemon process
     */
    private async startDaemon(): Promise<void> {
        const { spawn } = await import('child_process');
        
        // Ensure directory exists
        if (!fs.existsSync(OPENLLM_DIR)) {
            fs.mkdirSync(OPENLLM_DIR, { recursive: true, mode: 0o700 });
        }

        // Try to find the daemon binary
        // Priority: 1) openllm in PATH, 2) bundled binary
        const daemonCmd = await this.findDaemonBinary();
        
        // Start daemon in background with --daemon flag
        const daemon = spawn(daemonCmd, ['--daemon'], {
            detached: true,
            stdio: 'ignore',
            env: {
                ...process.env,
                OPENLLM_SOCKET: SOCKET_FILE,
                OPENLLM_PID_FILE: PID_FILE,
            },
        });
        
        daemon.unref();
    }

    /**
     * Find the daemon binary
     * Priority: 1) User-installed openllm in PATH, 2) Bundled binary in extension
     */
    private async findDaemonBinary(): Promise<string> {
        const { execSync } = await import('child_process');
        const path = await import('path');
        
        // Try to find openllm in PATH first (user may have installed it)
        try {
            const cmd = process.platform === 'win32' ? 'where openllm' : 'which openllm';
            const result = execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0];
            if (result && fs.existsSync(result)) {
                return result;
            }
        } catch {
            // Not in PATH, fall through to bundled
        }

        // Look for bundled binary in extension
        const bundledPath = this.getBundledBinaryPath();
        if (bundledPath && fs.existsSync(bundledPath)) {
            // Ensure it's executable on Unix
            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(bundledPath, 0o755);
                } catch {
                    // Ignore chmod errors
                }
            }
            return bundledPath;
        }

        throw new Error(
            `OpenLLM daemon binary not found. ` +
            `Install it with: cargo install openllm, or ensure the extension is properly installed.`
        );
    }

    /**
     * Get path to bundled binary for current platform
     */
    private getBundledBinaryPath(): string | null {
        if (!extensionPath) {
            console.warn('Extension path not set - cannot find bundled binary');
            return null;
        }
        
        const platform = process.platform;
        const arch = process.arch;
        
        // Map to our binary naming convention
        let binaryName: string;
        switch (platform) {
            case 'linux':
                binaryName = arch === 'arm64' ? 'openllm-linux-arm64' : 'openllm-linux-x64';
                break;
            case 'darwin':
                binaryName = arch === 'arm64' ? 'openllm-darwin-arm64' : 'openllm-darwin-x64';
                break;
            case 'win32':
                binaryName = arch === 'arm64' ? 'openllm-win32-arm64.exe' : 'openllm-win32-x64.exe';
                break;
            default:
                return null;
        }
        
        const binaryPath = path.join(extensionPath, 'bin', binaryName);
        console.log(`Looking for bundled daemon at: ${binaryPath}`);
        return binaryPath;
    }

    /**
     * Wait for daemon to be ready
     */
    private async waitForDaemon(timeout: number): Promise<void> {
        const start = Date.now();
        const pollInterval = 100;

        while (Date.now() - start < timeout) {
            if (isDaemonRunning()) {
                // Give it a moment to accept connections
                await new Promise(r => setTimeout(r, 100));
                return;
            }
            await new Promise(r => setTimeout(r, pollInterval));
        }

        throw new Error(`Daemon did not start within ${timeout}ms`);
    }

    /**
     * Check if connected
     */
    isConnected(): boolean {
        return this.channel !== null && this.client !== null;
    }

    /**
     * Get the raw client for advanced usage
     */
    getClient(): proto.OpenLLMClient {
        if (!this.client) {
            throw new Error('Not connected to daemon. Call connect() first.');
        }
        return this.client;
    }

    /**
     * Register this VS Code extension as a client
     */
    async register(capabilities: string[] = ['chat', 'tools']): Promise<string> {
        const client = this.getClient();
        const extensionVersion = vscode.extensions.getExtension('open-llm.open-llm-provider')?.packageJSON?.version || '0.1.0';
        
        // Get workspace path from VS Code
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspacePath = workspaceFolders && workspaceFolders.length > 0 
            ? workspaceFolders[0].uri.fsPath 
            : '';
        
        const logger = getLogger();
        logger.info('[Daemon] Registering with daemon...');
        logger.info(`[Daemon] Workspace folders: ${JSON.stringify(workspaceFolders?.map(f => f.uri.fsPath))}`);
        logger.info(`[Daemon] Workspace path to send: "${workspacePath}"`);
        
        const response = await client.register({
            client: {
                clientType: proto.ClientType.CLIENT_TYPE_VSCODE,
                user: process.env.USER || 'unknown',
            },
            isSpawner: false,
            workspacePath: workspacePath,
        });
        logger.info(`[Daemon] Registered with client ID: ${response.clientId}`);
        this.clientId = response.clientId;
        return this.clientId;
    }

    /**
     * Unregister this client
     */
    async unregister(): Promise<void> {
        if (this.clientId && this.client) {
            try {
                await this.client.unregister({ clientId: this.clientId });
            } catch (e) {
                // Ignore errors during unregister
            }
            this.clientId = null;
        }
    }

    /**
     * Close the connection
     */
    async close(): Promise<void> {
        await this.unregister();
        if (this.channel) {
            this.channel.close();
            this.channel = null;
            this.client = null;
        }
    }

    /**
     * Health check
     */
    async healthCheck(): Promise<boolean> {
        try {
            const client = this.getClient();
            const response = await client.healthCheck({});
            return response.healthy;
        } catch (e) {
            return false;
        }
    }

    /**
     * Get daemon status
     */
    async getStatus(): Promise<proto.DaemonStatus> {
        const client = this.getClient();
        return client.getStatus({});
    }

    /**
     * List available models
     */
    async listModels(): Promise<proto.Model[]> {
        const client = this.getClient();
        const response = await client.listModels({});
        return response.models;
    }

    /**
     * List available providers
     */
    async listProviders(): Promise<proto.Provider[]> {
        const client = this.getClient();
        const response = await client.listProviders({});
        return response.providers;
    }

    /**
     * Stateless chat - returns an async iterator of chunks
     */
    chat(request: proto.DeepPartial<proto.ChatRequest>): AsyncIterable<proto.ChatChunk> {
        const client = this.getClient();
        return client.chat(request);
    }

    /**
     * Session-based chat
     */
    sessionChat(request: proto.DeepPartial<proto.SessionChatRequest>): AsyncIterable<proto.ChatChunk> {
        const client = this.getClient();
        return client.sessionChat(request);
    }

    /**
     * Create a new session
     */
    async createSession(model: string, topic?: string, metadata?: Record<string, string>): Promise<proto.Session> {
        const client = this.getClient();
        return client.createSession({ model, topic, metadata: metadata || {} });
    }

    /**
     * Get a session by ID
     */
    async getSession(sessionId: string, includeMessages: boolean = true): Promise<proto.Session> {
        const client = this.getClient();
        return client.getSession({ sessionId, includeMessages });
    }

    /**
     * List all sessions
     */
    async listSessions(): Promise<proto.SessionSummary[]> {
        const client = this.getClient();
        const response = await client.listSessions({});
        return response.sessions;
    }

    /**
     * Delete a session
     */
    async deleteSession(sessionId: string): Promise<void> {
        const client = this.getClient();
        await client.deleteSession({ sessionId });
    }

    /**
     * List available tools
     */
    async listTools(): Promise<proto.Tool[]> {
        const client = this.getClient();
        const response = await client.listTools({});
        return response.tools;
    }

    /**
     * Execute a tool
     */
    async executeTool(toolName: string, args: Record<string, unknown>): Promise<proto.ExecuteToolResponse> {
        const client = this.getClient();
        return client.executeTool({
            name: toolName,
            arguments: JSON.stringify(args),
        });
    }

    // Note: Secret management (getSecret/setSecret) removed - secrets are now managed 
    // by the daemon's keychain store or environment variables, configured via the web UI

    /**
     * Delete a secret
     */
    async deleteSecret(key: string): Promise<void> {
        const client = this.getClient();
        await client.deleteSecret({ key });
    }

    /**
     * List secrets (returns SecretInfo with key, store, hasValue)
     */
    async listSecrets(): Promise<proto.SecretInfo[]> {
        const client = this.getClient();
        const response = await client.listSecrets({});
        return response.secrets;
    }

    /**
     * Get configuration
     */
    async getConfig(): Promise<proto.Config> {
        const client = this.getClient();
        return client.getConfig({});
    }

    /**
     * Register MCP server (VS Code extension registers itself)
     */
    async registerMcpServer(serverId: string, transport: string, capabilities: string[]): Promise<void> {
        const client = this.getClient();
        await client.registerMcpServer({
            serverId,
            transport,
            capabilities,
        });
    }
}

// Singleton instance
let _instance: DaemonClient | null = null;

/**
 * Get the shared daemon client instance
 */
export function getDaemonClient(): DaemonClient {
    if (!_instance) {
        _instance = new DaemonClient();
    }
    return _instance;
}

/**
 * Reset the daemon client (for testing)
 */
export function resetDaemonClient(): void {
    if (_instance) {
        _instance.close().catch(() => {});
        _instance = null;
    }
}

/**
 * Check if gRPC error is a specific status
 */
export function isGrpcError(error: unknown, status: Status): boolean {
    return error instanceof ClientError && error.code === status;
}

/**
 * Check if error is "not found"
 */
export function isNotFoundError(error: unknown): boolean {
    return isGrpcError(error, Status.NOT_FOUND);
}

/**
 * Check if error is "unavailable" (daemon not running)
 */
export function isUnavailableError(error: unknown): boolean {
    return isGrpcError(error, Status.UNAVAILABLE);
}

/**
 * Initialize the daemon client for the VS Code extension.
 * This will:
 * 1. Start the daemon if not running
 * 2. Connect to the daemon
 * 3. Register as a VS Code client
 * 
 * Call this during extension activation.
 */
export async function initializeDaemon(): Promise<DaemonClient> {
    const client = getDaemonClient();
    
    await client.connect({ autoStart: true });
    await client.register();
    
    return client;
}

/**
 * Shutdown the daemon client.
 * Call this during extension deactivation.
 */
export async function shutdownDaemon(): Promise<void> {
    const client = getDaemonClient();
    await client.close();
    resetDaemonClient();
}
