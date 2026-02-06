/**
 * MCP Tool Server using official @modelcontextprotocol/sdk
 * 
 * Runs an HTTP server over Unix socket (or Windows named pipe) that exposes:
 * 
 * Internal tools (openllm_* prefix, hidden from LLM):
 *   - openllm_secrets_get, openllm_secrets_set, openllm_secrets_delete, openllm_secrets_list
 *   - openllm_config_get, openllm_config_set
 *   - openllm_workspace_root
 * 
 * User tools (proxied from vscode.lm.tools):
 *   - All registered VS Code language model tools
 * 
 * Security:
 *   - Socket has mode 0600 (owner only) on Unix
 *   - Random socket path prevents guessing
 */

import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as zod from 'zod';

import { getLogger } from '../utils/logger';

export interface McpServerInfo {
  socketPath: string;
  httpUrl: string;  // For clients that need URL format
}

export class McpToolServer {
  private mcpServer: McpServer;
  private httpServer: http.Server | null = null;
  private socketPath: string = '';
  private context: vscode.ExtensionContext;
  private logger = getLogger();
  private transports: Map<string, StreamableHTTPServerTransport> = new Map();

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // Create MCP server with official SDK
    this.mcpServer = new McpServer({
      name: 'vscode-openllm',
      version: '1.0.0',
    });

    this.registerInternalTools();
    this.registerVSCodeTools();
  }

  /**
   * Register internal tools for openllm-core
   * These are prefixed with 'openllm_' and marked as internal
   */
  private registerInternalTools(): void {
    // ========== SECRETS ==========

    this.mcpServer.registerTool(
      'openllm_secrets_get',
      {
        description: 'Get an API key from VS Code SecretStorage',
        inputSchema: { key: zod.string().describe('Provider name (e.g., openai, anthropic)') },
      },
      async ({ key }): Promise<CallToolResult> => {
        const secretKey = `openllm.${key}`;
        const value = await this.context.secrets.get(secretKey);
        return {
          content: [{ type: 'text', text: JSON.stringify({ found: !!value, value: value || null }) }],
        };
      }
    );

    this.mcpServer.registerTool(
      'openllm_secrets_set',
      {
        description: 'Store an API key in VS Code SecretStorage',
        inputSchema: {
          key: zod.string().describe('Provider name'),
          value: zod.string().describe('API key value'),
        },
      },
      async ({ key, value }): Promise<CallToolResult> => {
        const secretKey = `openllm.${key}`;
        await this.context.secrets.store(secretKey, value);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      }
    );

    this.mcpServer.registerTool(
      'openllm_secrets_delete',
      {
        description: 'Delete an API key from VS Code SecretStorage',
        inputSchema: { key: zod.string().describe('Provider name') },
      },
      async ({ key }): Promise<CallToolResult> => {
        const secretKey = `openllm.${key}`;
        await this.context.secrets.delete(secretKey);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      }
    );

    this.mcpServer.registerTool(
      'openllm_secrets_list',
      {
        description: 'List all stored API key names',
        inputSchema: {},
      },
      async (): Promise<CallToolResult> => {
        // VS Code SecretStorage doesn't have a list method
        // Check known providers
        const knownProviders = ['openai', 'anthropic', 'gemini', 'ollama', 'mistral', 'azure', 'openrouter'];
        const availableKeys: string[] = [];

        for (const provider of knownProviders) {
          const key = `openllm.${provider}`;
          const value = await this.context.secrets.get(key);
          if (value) {
            availableKeys.push(provider);
          }
        }

        return {
          content: [{ type: 'text', text: JSON.stringify({ keys: availableKeys }) }],
        };
      }
    );

    // ========== CONFIG ==========

    this.mcpServer.registerTool(
      'openllm_config_get',
      {
        description: 'Get provider configuration from VS Code settings',
        inputSchema: {
          provider: zod.string().describe('Provider name or "*" for all'),
          scope: zod.enum(['user', 'workspace']).describe('Config scope'),
        },
      },
      async ({ provider, scope }): Promise<CallToolResult> => {
        const config = vscode.workspace.getConfiguration('openLLM');
        const inspection = config.inspect<any[]>('providers');

        const providersArray = scope === 'workspace'
          ? (inspection?.workspaceValue || [])
          : (inspection?.globalValue || []);

        const providers = provider === '*'
          ? providersArray
          : providersArray.filter((p: any) => p.name?.toLowerCase() === provider.toLowerCase());

        return {
          content: [{ type: 'text', text: JSON.stringify({ providers, scope }) }],
        };
      }
    );

    this.mcpServer.registerTool(
      'openllm_config_set',
      {
        description: 'Set provider configuration in VS Code settings',
        inputSchema: {
          provider: zod.string().describe('Provider name'),
          config: zod.object({
            enabled: zod.boolean().optional(),
            models: zod.array(zod.string()).optional(),
            apiBase: zod.string().optional(),
          }).passthrough().describe('Provider config object'),
          scope: zod.enum(['user', 'workspace']).describe('Config scope'),
        },
      },
      async ({ provider, config: providerConfig, scope }): Promise<CallToolResult> => {
        const vsConfig = vscode.workspace.getConfiguration('openLLM');
        const currentProviders = vsConfig.get<any[]>('providers', []);

        const existingIndex = currentProviders.findIndex(
          (p) => p.name?.toLowerCase() === provider.toLowerCase()
        );

        const updatedProvider = {
          name: provider,
          enabled: (providerConfig as any).enabled ?? true,
          apiBase: (providerConfig as any).apiBase,
          models: (providerConfig as any).models || [],
        };

        let updatedProviders: any[];
        if (existingIndex >= 0) {
          updatedProviders = [...currentProviders];
          updatedProviders[existingIndex] = { ...currentProviders[existingIndex], ...updatedProvider };
        } else {
          updatedProviders = [...currentProviders, updatedProvider];
        }

        const target = scope === 'workspace'
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;

        await vsConfig.update('providers', updatedProviders, target);

        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true }) }],
        };
      }
    );

    // ========== WORKSPACE ==========

    this.mcpServer.registerTool(
      'openllm_workspace_root',
      {
        description: 'Get the current workspace root path',
        inputSchema: {},
      },
      async (): Promise<CallToolResult> => {
        const folders = vscode.workspace.workspaceFolders;
        return {
          content: [{ type: 'text', text: JSON.stringify({ path: folders?.[0]?.uri.fsPath || null }) }],
        };
      }
    );

    this.logger.info('[MCP Server] Registered 7 internal tools');
  }

  /**
   * Register VS Code tools as MCP tools (user-visible)
   */
  private registerVSCodeTools(): void {
    // Register each vscode.lm.tool as an MCP tool
    try {
      for (const tool of vscode.lm.tools) {
        this.mcpServer.registerTool(
          tool.name,
          {
            description: tool.description,
            // Use the tool's input schema directly (it's already JSON Schema compatible)
            inputSchema: tool.inputSchema as any,
          },
          async (args): Promise<CallToolResult> => {
            try {
              const result = await vscode.lm.invokeTool(tool.name, {
                input: args,
                toolInvocationToken: undefined,
              }, new vscode.CancellationTokenSource().token);

              // Convert VS Code result to MCP format
              const content = result.content.map((part) => {
                if (part instanceof vscode.LanguageModelTextPart) {
                  return { type: 'text' as const, text: part.value };
                }
                return { type: 'text' as const, text: JSON.stringify(part) };
              });

              return { content };
            } catch (error) {
              return {
                content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
                isError: true,
              };
            }
          }
        );
      }

      this.logger.info(`[MCP Server] Registered ${vscode.lm.tools.length} VS Code tools`);
    } catch (error) {
      this.logger.error('[MCP Server] Failed to register VS Code tools:', error);
    }
  }

  /**
   * Start the MCP server on a Unix socket (or Windows named pipe)
   */
  async start(): Promise<McpServerInfo> {
    // Generate socket path
    const randomSuffix = crypto.randomBytes(8).toString('hex');
    if (process.platform === 'win32') {
      this.socketPath = `\\\\.\\pipe\\openllm-${process.pid}-${randomSuffix}`;
    } else {
      this.socketPath = path.join(os.tmpdir(), `openllm-${process.pid}-${randomSuffix}.sock`);

      // Clean up any existing socket file
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    }

    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer(async (req, res) => {
        this.logger.debug(`[MCP Server] ${req.method} ${req.url}`);

        // Handle CORS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // Health check endpoint
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', version: '1.0.0' }));
          return;
        }

        // MCP endpoint (Streamable HTTP)
        if (req.url === '/mcp') {
          const sessionId = req.headers['mcp-session-id'] as string | undefined;

          // Parse body for POST requests
          let body: any = undefined;
          if (req.method === 'POST') {
            body = await new Promise<string>((resolve) => {
              let data = '';
              req.on('data', (chunk) => { data += chunk; });
              req.on('end', () => resolve(data));
            });
            try {
              body = JSON.parse(body);
            } catch {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid JSON' }));
              return;
            }
          }

          try {
            // Check if this is an existing session
            if (sessionId && this.transports.has(sessionId)) {
              const transport = this.transports.get(sessionId)!;
              await transport.handleRequest(req as any, res as any, body);
              return;
            }

            // New session - check if it's an initialize request
            if (req.method === 'POST' && body?.method === 'initialize') {
              const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: (newSessionId) => {
                  this.logger.info(`[MCP Server] Session initialized: ${newSessionId}`);
                  this.transports.set(newSessionId, transport);
                },
              });

              // Clean up on close
              transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) {
                  this.logger.info(`[MCP Server] Session closed: ${sid}`);
                  this.transports.delete(sid);
                }
              };

              // Connect to MCP server
              await this.mcpServer.connect(transport);
              await transport.handleRequest(req as any, res as any, body);
              return;
            }

            // Invalid request
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Bad Request: No valid session ID' },
              id: null,
            }));
          } catch (error) {
            this.logger.error('[MCP Server] Error handling request:', error);
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
              }));
            }
          }
          return;
        }

        // Not found
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      });

      this.httpServer.on('error', (err) => {
        this.logger.error('[MCP Server] HTTP server error:', err);
        reject(err);
      });

      this.httpServer.listen(this.socketPath, () => {
        // Set socket permissions (Unix only)
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.socketPath, 0o600);
          } catch (e) {
            this.logger.warn(`[MCP Server] Could not set socket permissions: ${e}`);
          }
        }

        this.logger.info(`[MCP Server] Listening on ${this.socketPath}`);
        resolve({
          socketPath: this.socketPath,
          httpUrl: `http+unix://${encodeURIComponent(this.socketPath)}/mcp`,
        });
      });
    });
  }

  /**
   * Stop the server and clean up
   */
  async stop(): Promise<void> {
    // Close all active transports
    for (const [sessionId, transport] of this.transports) {
      try {
        this.logger.info(`[MCP Server] Closing session: ${sessionId}`);
        await transport.close();
      } catch (e) {
        this.logger.error(`[MCP Server] Error closing session ${sessionId}:`, e);
      }
    }
    this.transports.clear();

    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer!.close(() => {
          this.logger.info('[MCP Server] Stopped');

          // Clean up socket file (Unix only)
          if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
            try {
              fs.unlinkSync(this.socketPath);
            } catch (e) {
              // Ignore cleanup errors
            }
          }

          resolve();
        });
      });
    }
  }

  /**
   * Get the socket path for clients to connect
   */
  getSocketPath(): string {
    return this.socketPath;
  }
}

/**
 * Create and start an MCP tool server
 */
export async function createMcpToolServer(
  context: vscode.ExtensionContext
): Promise<McpToolServer> {
  const server = new McpToolServer(context);
  await server.start();
  return server;
}
