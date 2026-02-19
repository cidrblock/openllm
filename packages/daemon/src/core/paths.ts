/**
 * Platform-aware path utilities for OpenLLM
 *
 * All daemon, extension, and CLI code should use these helpers to ensure
 * consistent file placement across Linux, macOS, and Windows.
 *
 * Conventions:
 *   Runtime dir  (ephemeral: PID, socket, lock)
 *     Linux:   $XDG_RUNTIME_DIR/openllm  → /run/user/<uid>/openllm
 *     macOS:   os.tmpdir()/openllm        → /var/folders/.../openllm
 *     Windows: named pipe (no dir needed for socket)
 *     Fallback: /tmp/openllm
 *
 *   Config dir   (persistent user config)
 *     Linux:   $XDG_CONFIG_HOME/openllm   → ~/.config/openllm
 *     macOS:   ~/Library/Application Support/openllm
 *     Windows: %APPDATA%/openllm
 *
 *   Workspace config dir
 *     All:     <workspace>/.config/openllm
 */

import * as os from 'node:os';
import * as path from 'node:path';

const APP_NAME = 'openllm';

// ── Runtime directory ────────────────────────────────────────────────

/**
 * Get the platform runtime directory (for ephemeral files: PID, socket, lock).
 *
 * - Linux:  XDG_RUNTIME_DIR  → /run/user/<uid>
 * - macOS:  os.tmpdir()      → /var/folders/...
 * - Other:  /tmp
 */
export function getRuntimeDir(): string {
    // 1. Respect XDG_RUNTIME_DIR (standard on Linux)
    if (process.env.XDG_RUNTIME_DIR) {
        return path.join(process.env.XDG_RUNTIME_DIR, APP_NAME);
    }

    // 2. macOS — os.tmpdir() returns DARWIN_USER_TEMP_DIR automatically
    if (process.platform === 'darwin') {
        return path.join(os.tmpdir(), APP_NAME);
    }

    // 3. Linux without XDG_RUNTIME_DIR — try /run/user/<uid>
    if (process.platform !== 'win32') {
        try {
            const uid = os.userInfo().uid;
            return path.join(`/run/user/${uid}`, APP_NAME);
        } catch {
            // os.userInfo() can fail in some sandboxes
        }
    }

    // 4. Fallback
    return path.join('/tmp', APP_NAME);
}

// ── Config directory ─────────────────────────────────────────────────

/**
 * Get the persistent user config directory.
 *
 * - macOS:   ~/Library/Application Support/openllm
 * - Windows: %APPDATA%/openllm
 * - Linux:   $XDG_CONFIG_HOME/openllm → ~/.config/openllm
 */
export function getConfigDir(): string {
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', APP_NAME);
    }

    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        return path.join(appData, APP_NAME);
    }

    // Linux / BSD — XDG Base Directory spec
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configHome, APP_NAME);
}

// ── Workspace config directory ───────────────────────────────────────

/**
 * Get the workspace-level config directory.
 *
 *   <workspacePath>/.config/openllm
 */
export function getWorkspaceConfigDir(workspacePath: string): string {
    return path.join(workspacePath, '.config', APP_NAME);
}

// ── Derived helpers ──────────────────────────────────────────────────

/** Socket path:  <runtimeDir>/daemon.sock  (or Windows named pipe) */
export function getSocketPath(): string {
    if (process.platform === 'win32') {
        return '\\\\.\\pipe\\openllm-daemon';
    }
    return path.join(getRuntimeDir(), 'daemon.sock');
}

/** PID file:  <runtimeDir>/openllm.pid */
export function getPidPath(): string {
    return path.join(getRuntimeDir(), 'openllm.pid');
}

/** User config file:  <configDir>/config.yaml */
export function getUserConfigPath(): string {
    return path.join(getConfigDir(), 'config.yaml');
}

/** Workspace config file:  <workspaceConfigDir>/config.yaml */
export function getWorkspaceConfigPath(workspacePath: string): string {
    return path.join(getWorkspaceConfigDir(workspacePath), 'config.yaml');
}

/** User policies file:  <configDir>/policies.yaml (user-level only, no workspace variant) */
export function getUserPoliciesPath(): string {
    return path.join(getConfigDir(), 'policies.yaml');
}
