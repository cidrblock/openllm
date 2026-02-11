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
import express from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDefaultSocketPath } from '../transport.js';
import { loadConfig, saveConfig, loadWorkspaceConfig, saveWorkspaceConfig } from '../config/loader.js';
import { getSupportedProviders, getDefaultEnvVar } from '../providers/adapter.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Static files path (the Rust web dashboard files)
const STATIC_PATH = path.resolve(__dirname, '../../../../crates/openllm/src/web/static');
/**
 * Create the Express application with direct DaemonState access.
 *
 * Used both for production (embedded in daemon) and testing.
 */
export function createWebApp(state) {
    const app = express();
    // Parse JSON bodies
    app.use(express.json());
    // CORS for local development
    app.use((req, res, next) => {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') {
            res.sendStatus(200);
            return;
        }
        next();
    });
    // Serve static files
    if (fs.existsSync(STATIC_PATH)) {
        app.use(express.static(STATIC_PATH));
    }
    // ─── API Routes ────────────────────────────────────────────────────────
    /**
     * GET /api/health - Health check
     */
    app.get('/api/health', (req, res) => {
        res.json({
            status: 'ok',
            daemon: 'connected',
            version: state.version,
            healthy: true,
            socketPath: getDefaultSocketPath(),
        });
    });
    /**
     * GET /api/providers - List all providers with configuration status
     */
    app.get('/api/providers', async (req, res) => {
        try {
            const providers = await state.listProviders();
            res.json(providers.map((p) => ({
                id: p.id,
                display_name: p.displayName,
                configured: p.configured,
                healthy: p.healthy,
            })));
        }
        catch (err) {
            console.error('[Web] /api/providers error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * GET /api/models - List models from configured providers
     */
    app.get('/api/models', async (req, res) => {
        try {
            const models = await state.listModels();
            res.json(models.map((m) => ({
                id: m.id,
                provider: m.provider,
                display_name: m.displayName,
                context_window: m.contextWindow,
                capabilities: {
                    supports_tools: m.capabilities?.supportsTools || false,
                    supports_vision: m.capabilities?.supportsVision || false,
                },
            })));
        }
        catch (err) {
            console.error('[Web] /api/models error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * GET /api/config - Get user configuration
     */
    app.get('/api/config', (req, res) => {
        try {
            const config = loadConfig();
            res.json(config);
        }
        catch (err) {
            console.error('[Web] /api/config GET error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * POST /api/config - Save user configuration
     */
    app.post('/api/config', (req, res) => {
        try {
            const config = req.body;
            saveConfig(config);
            res.json({ success: true });
        }
        catch (err) {
            console.error('[Web] /api/config POST error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * GET /api/config/workspace?path=... - Get workspace configuration
     */
    app.get('/api/config/workspace', (req, res) => {
        try {
            const wsPath = req.query.path;
            if (!wsPath) {
                res.status(400).json({ error: 'path query param required' });
                return;
            }
            const config = loadWorkspaceConfig(wsPath);
            res.json(config);
        }
        catch (err) {
            console.error('[Web] /api/config/workspace GET error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * POST /api/config/workspace?path=... - Save workspace configuration
     */
    app.post('/api/config/workspace', (req, res) => {
        try {
            const wsPath = req.query.path;
            if (!wsPath) {
                res.status(400).json({ error: 'path query param required' });
                return;
            }
            const config = req.body;
            saveWorkspaceConfig(wsPath, config);
            res.json({ success: true });
        }
        catch (err) {
            console.error('[Web] /api/config/workspace POST error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * GET /api/workspaces - Get connected VS Code workspaces
     */
    app.get('/api/workspaces', (req, res) => {
        try {
            const workspaces = state.getVSCodeWorkspaces();
            res.json(workspaces);
        }
        catch (err) {
            console.error('[Web] /api/workspaces error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * GET /api/status - Get daemon status
     */
    app.get('/api/status', (req, res) => {
        try {
            const clients = state.getClients();
            res.json({
                version: state.version,
                started_at: state.startedAt.toISOString(),
                connected_clients: state.clientCount,
                active_sessions: 0,
                clients: clients.map(c => ({
                    client_id: c.clientId,
                    client_type: c.clientType,
                    connected_at: c.connectedAt.toISOString(),
                    is_spawner: c.isSpawner,
                    workspace_path: c.workspacePath || '',
                })),
            });
        }
        catch (err) {
            console.error('[Web] /api/status error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * GET /api/secrets - List secret keys with availability status
     */
    app.get('/api/secrets', async (req, res) => {
        try {
            const providers = getSupportedProviders();
            const secrets = await Promise.all(providers.map(async (pid) => {
                const envVar = getDefaultEnvVar(pid);
                const key = envVar || `${pid.toUpperCase()}_API_KEY`;
                const hasValue = await state.secretStore.has(key);
                return { key, has_value: hasValue };
            }));
            res.json(secrets);
        }
        catch (err) {
            console.error('[Web] /api/secrets error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * POST /api/secrets - Set a secret (API key)
     */
    app.post('/api/secrets', async (req, res) => {
        try {
            const { key, value } = req.body;
            if (!key || !value) {
                res.status(400).json({ error: 'key and value required' });
                return;
            }
            await state.secretStore.set(key, value);
            res.json({ success: true });
        }
        catch (err) {
            console.error('[Web] /api/secrets POST error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * DELETE /api/secrets/:key - Delete a secret
     */
    app.delete('/api/secrets/:key', async (req, res) => {
        try {
            await state.secretStore.delete(req.params.key);
            res.json({ success: true });
        }
        catch (err) {
            console.error('[Web] /api/secrets DELETE error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * POST /api/chat - Stream chat via Server-Sent Events
     *
     * Calls state.chat() directly — no gRPC in the loop.
     */
    app.post('/api/chat', (req, res) => {
        const { model, messages } = req.body;
        if (!model || !messages) {
            res.status(400).json({ error: 'model and messages required' });
            return;
        }
        // Set up SSE
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        });
        res.flushHeaders();
        let ended = false;
        const safeWrite = (data) => {
            if (ended || res.writableEnded)
                return false;
            try {
                res.write(data);
                return true;
            }
            catch {
                return false;
            }
        };
        const safeEnd = () => {
            if (!ended && !res.writableEnded) {
                ended = true;
                try {
                    res.end();
                }
                catch { }
            }
        };
        // Convert web messages to the format state.chat() expects
        const chatMessages = messages.map((m) => ({
            role: m.role || 'user',
            content: m.content || '',
        }));
        console.log('[Web] Starting Chat stream:', model, `messages: ${chatMessages.length}`);
        // Detect actual client disconnect (connection close, not request body consumed)
        // IMPORTANT: use res.on('close') — NOT req.on('close') which fires
        // when the POST body is fully read by express.json() middleware.
        res.on('close', () => {
            if (!ended) {
                ended = true;
                console.log('[Web] Client disconnected during chat stream');
            }
        });
        // Stream directly from DaemonState — no gRPC involved
        (async () => {
            try {
                for await (const chunk of state.chat(model, chatMessages)) {
                    if (ended)
                        break;
                    if (chunk.type === 'text' && chunk.text) {
                        safeWrite(`data: ${JSON.stringify({ type: 'text', text: chunk.text })}\n\n`);
                    }
                    else if (chunk.type === 'done') {
                        safeWrite(`data: ${JSON.stringify({ type: 'done', finish_reason: chunk.finishReason || 'stop' })}\n\n`);
                    }
                }
            }
            catch (err) {
                console.error('[Web] Chat stream error:', err.message);
                safeWrite(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
            }
            finally {
                safeWrite('data: [DONE]\n\n');
                safeEnd();
            }
        })();
    });
    /**
     * POST /api/provider/:id/configure - Configure a provider (set API key + update config)
     */
    app.post('/api/provider/:id/configure', async (req, res) => {
        try {
            const providerId = req.params.id;
            const { apiKey, envVarName, apiBase, target, workspacePath } = req.body;
            const config = (target === 'workspace' && workspacePath
                ? loadWorkspaceConfig(workspacePath)
                : loadConfig()) || { providers: {} };
            if (!config.providers)
                config.providers = {};
            config.providers[providerId] = config.providers[providerId] || {};
            if (apiKey) {
                const keychainName = `${providerId.toUpperCase()}_API_KEY`;
                await state.secretStore.set(keychainName, apiKey);
                config.providers[providerId].api_key_keychain_name = keychainName;
                delete config.providers[providerId].api_key_env_var_name;
            }
            else if (envVarName) {
                config.providers[providerId].api_key_env_var_name = envVarName;
                delete config.providers[providerId].api_key_keychain_name;
            }
            if (apiBase) {
                config.providers[providerId].api_base = apiBase;
            }
            if (target === 'workspace' && workspacePath) {
                saveWorkspaceConfig(workspacePath, config);
            }
            else {
                saveConfig(config);
            }
            res.json({ success: true });
        }
        catch (err) {
            console.error('[Web] /api/provider configure error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    /**
     * DELETE /api/provider/:id - Remove a provider configuration
     */
    app.delete('/api/provider/:id', async (req, res) => {
        try {
            const providerId = req.params.id;
            const target = req.query.target || 'user';
            const workspacePath = req.query.workspacePath;
            const config = (target === 'workspace' && workspacePath
                ? loadWorkspaceConfig(workspacePath)
                : loadConfig()) || { providers: {} };
            if (config.providers && config.providers[providerId]) {
                const keychainName = config.providers[providerId].api_key_keychain_name;
                if (keychainName) {
                    try {
                        await state.secretStore.delete(keychainName);
                    }
                    catch { }
                }
                delete config.providers[providerId];
                if (target === 'workspace' && workspacePath) {
                    saveWorkspaceConfig(workspacePath, config);
                }
                else {
                    saveConfig(config);
                }
            }
            res.json({ success: true });
        }
        catch (err) {
            console.error('[Web] /api/provider delete error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });
    return app;
}
// ─── Embedded Web Server Lifecycle ──────────────────────────────────────
let _httpServer = null;
let _webPort = null;
/**
 * Start the embedded web server in the daemon process.
 * Returns the actual port and URL.
 */
export async function startEmbeddedWebServer(state, port = 8787) {
    if (_httpServer) {
        return { port: _webPort, url: `http://localhost:${_webPort}` };
    }
    const app = createWebApp(state);
    // SPA fallback (serve index.html for non-API routes)
    app.get('*', (req, res) => {
        const indexPath = path.join(STATIC_PATH, 'index.html');
        if (fs.existsSync(indexPath)) {
            res.sendFile(indexPath);
        }
        else {
            res.status(404).send('Web dashboard not found. Static files not at: ' + STATIC_PATH);
        }
    });
    _webPort = port;
    await new Promise((resolve, reject) => {
        _httpServer = app.listen(port, () => {
            console.log(`[Web] Dashboard started: http://localhost:${port}`);
            resolve();
        });
        _httpServer.on('error', reject);
    });
    return { port, url: `http://localhost:${port}` };
}
/**
 * Stop the embedded web server.
 */
export async function stopEmbeddedWebServer() {
    if (!_httpServer)
        return;
    await new Promise((resolve) => {
        _httpServer.close(() => {
            console.log('[Web] Dashboard stopped');
            resolve();
        });
    });
    _httpServer = null;
    _webPort = null;
}
/**
 * Check if the embedded web server is running.
 */
export function isWebServerRunning() {
    return _httpServer !== null;
}
/**
 * Get the current web server port (null if not running).
 */
export function getWebServerPort() {
    return _webPort;
}
//# sourceMappingURL=server.js.map