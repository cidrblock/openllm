/**
 * Transport layer for daemon communication
 * 
 * Handles Unix socket (Linux/macOS) and named pipe (Windows) transport.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';

export interface Transport {
  type: 'unix' | 'tcp';
  socketPath?: string;
  host?: string;
  port?: number;
}

/**
 * Get the default socket path for the current platform
 */
export function getDefaultSocketPath(): string {
  if (process.platform === 'win32') {
    // Windows: use named pipe
    return '\\\\.\\pipe\\openllm-daemon';
  }
  
  // Linux/macOS: use Unix socket in XDG_RUNTIME_DIR or /tmp
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${os.userInfo().uid}`;
  const socketDir = path.join(runtimeDir, 'openllm');
  return path.join(socketDir, 'daemon.sock');
}

/**
 * Get the PID file path
 */
export function getPidFilePath(): string {
  const homeDir = os.homedir();
  return path.join(homeDir, '.openllm', 'openllm.pid');
}

/**
 * Ensure the socket directory exists
 */
export function ensureSocketDir(): void {
  const socketPath = getDefaultSocketPath();
  const socketDir = path.dirname(socketPath);
  
  if (!fs.existsSync(socketDir)) {
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Ensure the config directory exists
 */
export function ensureConfigDir(): void {
  const homeDir = os.homedir();
  const configDir = path.join(homeDir, '.openllm');
  
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Clean up stale socket file
 */
export function cleanupSocket(): void {
  const socketPath = getDefaultSocketPath();
  
  if (fs.existsSync(socketPath)) {
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      // Ignore errors - socket might be in use
    }
  }
}

/**
 * Write PID file
 */
export function writePidFile(): void {
  ensureConfigDir();
  const pidPath = getPidFilePath();
  fs.writeFileSync(pidPath, process.pid.toString(), { mode: 0o600 });
}

/**
 * Read PID from file
 */
export function readPidFile(): number | null {
  const pidPath = getPidFilePath();
  
  if (!fs.existsSync(pidPath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(pidPath, 'utf-8').trim();
    return parseInt(content, 10);
  } catch {
    return null;
  }
}

/**
 * Remove PID file
 */
export function removePidFile(): void {
  const pidPath = getPidFilePath();
  
  if (fs.existsSync(pidPath)) {
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // Ignore errors
    }
  }
}

/**
 * Check if a process is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if daemon is running by testing socket connection
 */
export function isDaemonRunning(): boolean {
  const socketPath = getDefaultSocketPath();
  
  // First check PID file
  const pid = readPidFile();
  if (pid && isProcessRunning(pid)) {
    return true;
  }
  
  // Check if socket exists and is connectable
  if (!fs.existsSync(socketPath)) {
    return false;
  }
  
  // Try to connect briefly
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection(socketPath);
    
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    
    socket.on('connect', () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    
    socket.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });
  }) as unknown as boolean; // Sync check for simple cases
}

/**
 * Check daemon status synchronously (best effort)
 * 
 * Only considers the daemon running if:
 * 1. PID file exists AND the process is alive, OR
 * 2. None of the above — if only a stale socket exists, we treat it as not running
 */
export function isDaemonRunningSync(): boolean {
  const pid = readPidFile();
  if (pid && isProcessRunning(pid)) {
    return true;
  }
  
  // If PID file has a stale PID, clean up
  if (pid && !isProcessRunning(pid)) {
    removePidFile();
    cleanupSocket();
  }
  
  return false;
}

/**
 * Kill daemon process
 */
export function killDaemon(): boolean {
  const pid = readPidFile();
  
  if (!pid) {
    return false;
  }
  
  try {
    // Send SIGTERM first
    process.kill(pid, 'SIGTERM');
    
    // Wait briefly then check if still running
    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      if (!isProcessRunning(pid)) {
        break;
      }
      // Busy wait (not ideal, but simple)
    }
    
    // Force kill if still running
    if (isProcessRunning(pid)) {
      process.kill(pid, 'SIGKILL');
    }
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Get transport configuration
 */
export function getTransport(): Transport {
  return {
    type: 'unix',
    socketPath: getDefaultSocketPath(),
  };
}
