/**
 * JSON-RPC Server for OpenLLM
 * 
 * Provides a Unix socket (or named pipe on Windows) server that exposes
 * VS Code's configuration and secret storage to external consumers like
 * the openllm-core Rust library.
 * 
 * This server exposes functionality as MCP-compatible tools:
 * 
 * Internal tools (openllm_* prefix, hidden from LLM):
 *   - openllm_secrets_get, openllm_secrets_set, openllm_secrets_delete
 *   - openllm_config_get, openllm_config_set
 *   - openllm_workspace_root
 * 
 * User-visible tools (proxied from vscode.lm.tools):
 *   - All registered VS Code language model tools
 * 
 * Security:
 * - Socket has mode 0600 (owner only)
 * - Random socket path
 * - Authentication token required for all requests
 */

import * as net from 'net';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
// Note: We use manual JSON-RPC parsing instead of vscode-jsonrpc
// due to compatibility issues with vscode-jsonrpc closing connections prematurely

// Request types
export interface AuthenticatedParams {
  auth: string;
}

export interface SecretsGetParams extends AuthenticatedParams {
  key: string;
}

export interface SecretsStoreParams extends AuthenticatedParams {
  key: string;
  value: string;
}

export interface SecretsDeleteParams extends AuthenticatedParams {
  key: string;
}

export interface ConfigGetParams extends AuthenticatedParams {
  provider: string;  // Provider name or "*" for all
  scope: 'user' | 'workspace';
  workspacePath?: string;
}

export interface ConfigSetParams extends AuthenticatedParams {
  provider: string;
  scope: 'user' | 'workspace';
  workspacePath?: string;
  config: {
    enabled?: boolean;
    models?: string[];
    apiBase?: string;
    [key: string]: unknown;
  };
}

export interface ProviderConfig {
  name: string;
  enabled: boolean;
  models: string[];
  apiBase?: string;
  source: string;
  sourceDetail: string;
}

export interface RpcServerInfo {
  socketPath: string;
  authToken: string;
}

// ============ MCP TOOL TYPES ============

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
  /** If true, this tool is internal and should not be sent to the LLM */
  _internal?: boolean;
}

export interface McpToolCallParams extends AuthenticatedParams {
  name: string;
  arguments: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string } | { type: 'error'; text: string }>;
  isError?: boolean;
}

/** Prefix for internal tools (hidden from LLM) */
const INTERNAL_TOOL_PREFIX = 'openllm_';

export class RpcServer {
  private server: net.Server | null = null;
  private activeSockets: Set<net.Socket> = new Set();
  private socketPath: string = '';
  private authToken: string = '';
  private context: vscode.ExtensionContext;
  private logger: { info(msg: string): void; debug?(msg: string): void; error(msg: string, ...args: unknown[]): void };

  constructor(context: vscode.ExtensionContext, logger: { info(msg: string): void; debug?(msg: string): void; error(msg: string, ...args: unknown[]): void }) {
    this.context = context;
    this.logger = logger;
  }

  /**
   * Start the JSON-RPC server
   */
  async start(): Promise<RpcServerInfo> {
    // Generate secure random token
    this.authToken = crypto.randomBytes(32).toString('hex');
    
    // Generate socket path
    const randomSuffix = crypto.randomBytes(8).toString('hex');
    if (process.platform === 'win32') {
      // Windows named pipe
      this.socketPath = `\\\\.\\pipe\\openllm-${process.pid}-${randomSuffix}`;
    } else {
      // Unix socket
      this.socketPath = path.join(os.tmpdir(), `openllm-${process.pid}-${randomSuffix}.sock`);
      
      // Clean up any existing socket file
      if (fs.existsSync(this.socketPath)) {
        fs.unlinkSync(this.socketPath);
      }
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.logger.info(`[RPC Server] *** SERVER RECEIVED CONNECTION ***`);
        this.handleConnection(socket);
      });

      this.server.on('connection', (socket) => {
        this.logger.info(`[RPC Server] Server 'connection' event fired`);
      });

      this.server.on('error', (err) => {
        this.logger.error(`[RPC Server] Error: ${err.message}`);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        // Set socket permissions (Unix only)
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.socketPath, 0o600);
          } catch (e) {
            this.logger.info(`[RPC Server] Warning: Could not set socket permissions: ${e}`);
          }
        }
        
        this.logger.info(`[RPC Server] Listening on ${this.socketPath}`);
        resolve({
          socketPath: this.socketPath,
          authToken: this.authToken,
        });
      });
    });
  }

  /**
   * Stop the server and clean up
   */
  async stop(): Promise<void> {
    // Close all active sockets
    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    // Close server
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          this.logger.info('[RPC Server] Stopped');
          
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
   * Handle a new connection using manual JSON-RPC parsing
   * (bypasses vscode-jsonrpc which was having compatibility issues)
   */
  private handleConnection(socket: net.Socket): void {
    this.logger.info('[RPC Server] New connection from client');
    
    let buffer = '';
    let contentLength = -1;
    
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      this.logger.info(`[RPC Server] Received ${chunk.length} bytes, buffer now ${buffer.length} bytes`);
      
      // Process messages in the buffer
      while (true) {
        // If we don't have a content length yet, try to parse headers
        if (contentLength === -1) {
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd === -1) {
            // Don't have complete headers yet
            break;
          }
          
          const headers = buffer.substring(0, headerEnd);
          const match = headers.match(/Content-Length:\s*(\d+)/i);
          if (!match) {
            this.logger.error('[RPC Server] No Content-Length header found');
            socket.destroy();
            return;
          }
          
          contentLength = parseInt(match[1], 10);
          buffer = buffer.substring(headerEnd + 4); // Skip past \r\n\r\n
          this.logger.info(`[RPC Server] Content-Length: ${contentLength}`);
        }
        
        // Check if we have the full message body
        if (buffer.length < contentLength) {
          // Don't have complete body yet
          break;
        }
        
        // Extract the message
        const messageStr = buffer.substring(0, contentLength);
        buffer = buffer.substring(contentLength);
        contentLength = -1; // Reset for next message
        
        this.logger.info(`[RPC Server] Processing message: ${messageStr.substring(0, 200)}...`);
        
        try {
          const message = JSON.parse(messageStr);
          this.handleJsonRpcMessage(socket, message);
        } catch (e) {
          this.logger.error(`[RPC Server] Failed to parse JSON: ${e}`);
          this.sendJsonRpcError(socket, null, -32700, 'Parse error');
        }
      }
    });

    // Track this socket
    this.activeSockets.add(socket);

    socket.on('close', () => {
      this.logger.info('[RPC Server] Socket closed');
      this.activeSockets.delete(socket);
    });

    socket.on('error', (err) => {
      this.logger.error(`[RPC Server] Socket error: ${err.message}`);
      this.logger.info(`[RPC Server] Socket error: ${err.message}`);
      this.activeSockets.delete(socket);
    });
  }
  
  /**
   * Handle a parsed JSON-RPC message
   */
  private async handleJsonRpcMessage(socket: net.Socket, message: any): Promise<void> {
    const { id, method, params } = message;
    this.logger.info(`[RPC Server] Handling method: ${method}, id: ${id}`);
    
    try {
      let result: any;
      
      switch (method) {
        case 'lifecycle/ping':
          result = { ok: true, version: '0.1.0' };
          break;
          
        case 'lifecycle/capabilities':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          result = {
            capabilities: {
              secrets: true,
              config: true,
              workspace: true,
            }
          };
          break;
          
        case 'secrets/get':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          const secretValue = await this.context.secrets.get(params.key);
          result = { value: secretValue || null };
          break;
          
        case 'secrets/store':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          await this.context.secrets.store(params.key, params.value);
          result = { success: true };
          break;
          
        case 'secrets/delete':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          await this.context.secrets.delete(params.key);
          result = { success: true };
          break;
          
        case 'config/get':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          result = await this.getConfig(params);
          break;
          
        case 'config/set':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          this.logger.info(`[RPC Server] config/set for provider: ${params.provider}, scope: ${params.scope}`);
          result = await this.setConfig(params);
          this.logger.info(`[RPC Server] config/set completed successfully`);
          break;
          
        case 'config/getSettings':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          const config = vscode.workspace.getConfiguration('openLLM');
          result = {
            settings: {
              configSource: config.get('config.source', 'vscode'),
              secretsSource: config.get('secrets.primaryStore', 'vscode'),
            }
          };
          break;
          
        case 'workspace/getRoot':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          const folders = vscode.workspace.workspaceFolders;
          result = { path: folders?.[0]?.uri.fsPath || null };
          break;
          
        case 'workspace/getPaths':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          const allFolders = vscode.workspace.workspaceFolders || [];
          result = { paths: allFolders.map(f => f.uri.fsPath) };
          break;
        
        // ============ MCP TOOL METHODS ============
        
        case 'tools/list':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          result = await this.listTools(params.includeInternal ?? true);
          break;
          
        case 'tools/call':
          if (!this.validateAuth(params)) {
            throw { code: -32600, message: 'Unauthorized' };
          }
          result = await this.callTool(params as McpToolCallParams);
          break;
          
        default:
          throw { code: -32601, message: `Method not found: ${method}` };
      }
      
      this.sendJsonRpcResult(socket, id, result);
    } catch (e: any) {
      const code = e.code || -32603;
      const errMessage = e.message || String(e);
      this.logger.error(`[RPC Server] Error handling ${method}: ${errMessage}`);
      this.sendJsonRpcError(socket, id, code, errMessage);
    }
  }
  
  /**
   * Send a JSON-RPC success response
   */
  private sendJsonRpcResult(socket: net.Socket, id: number | string | null, result: any): void {
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id,
      result,
    });
    const message = `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`;
    this.logger.info(`[RPC Server] Sending response: ${response.substring(0, 200)}...`);
    socket.write(message);
  }
  
  /**
   * Send a JSON-RPC error response
   */
  private sendJsonRpcError(socket: net.Socket, id: number | string | null, code: number, message: string): void {
    const response = JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
    const msg = `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`;
    this.logger.info(`[RPC Server] Sending error: ${response}`);
    socket.write(msg);
  }

  /**
   * Validate authentication token
   */
  private validateAuth(params: AuthenticatedParams): boolean {
    return params.auth === this.authToken;
  }

  /**
   * Get provider configuration
   */
  private async getConfig(params: ConfigGetParams): Promise<{ providers: ProviderConfig[] }> {
    const { provider, scope, workspacePath } = params;
    
    // Determine the configuration scope
    let resourceUri: vscode.Uri | undefined;
    
    if (scope === 'workspace') {
      if (workspacePath) {
        resourceUri = vscode.Uri.file(workspacePath);
      } else {
        resourceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      }
    }
    
    const config = vscode.workspace.getConfiguration('openLLM', resourceUri);
    
    // Use inspect to get scope-specific values (user vs workspace)
    const inspection = config.inspect<Array<{ name: string; enabled?: boolean; apiBase?: string; models?: string[] }>>('providers');
    
    // Get the value for the requested scope
    const providersArray = scope === 'workspace' 
      ? (inspection?.workspaceValue || [])
      : (inspection?.globalValue || []);
    
    const providers: ProviderConfig[] = [];
    
    if (provider === '*') {
      // Return all providers
      for (const providerData of providersArray) {
        if (providerData && typeof providerData === 'object' && providerData.name) {
          providers.push(this.toProviderConfig(providerData.name, providerData, scope));
        }
      }
    } else {
      // Return specific provider
      const providerData = providersArray.find(p => p.name?.toLowerCase() === provider.toLowerCase());
      if (providerData) {
        providers.push(this.toProviderConfig(providerData.name, providerData, scope));
      }
    }
    
    return { providers };
  }

  /**
   * Convert raw config to ProviderConfig
   */
  private toProviderConfig(name: string, data: { name?: string; enabled?: boolean; apiBase?: string; models?: string[] }, scope: string): ProviderConfig {
    return {
      name,
      enabled: data.enabled !== false,
      models: Array.isArray(data.models) ? data.models : [],
      apiBase: data.apiBase,
      source: 'vscode',
      sourceDetail: scope === 'workspace' ? 'VS Code Workspace Settings' : 'VS Code User Settings',
    };
  }

  /**
   * Set provider configuration
   */
  private async setConfig(params: ConfigSetParams): Promise<{ success: boolean }> {
    const { provider, scope, workspacePath, config: providerConfig } = params;
    
    // Determine the configuration target
    let configTarget: vscode.ConfigurationTarget;
    let resourceUri: vscode.Uri | undefined;
    
    if (scope === 'workspace') {
      configTarget = vscode.ConfigurationTarget.Workspace;
      if (workspacePath) {
        resourceUri = vscode.Uri.file(workspacePath);
      } else {
        resourceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
      }
    } else {
      configTarget = vscode.ConfigurationTarget.Global;
    }
    
    const config = vscode.workspace.getConfiguration('openLLM', resourceUri);
    
    // Get current providers array
    const currentProviders = config.get<Array<{ name: string; enabled?: boolean; apiBase?: string; models?: string[] }>>('providers', []);
    
    // Find existing provider index
    const existingIndex = currentProviders.findIndex(p => p.name?.toLowerCase() === provider.toLowerCase());
    
    // Build updated provider entry
    const updatedProvider = {
      name: provider,
      enabled: providerConfig.enabled ?? true,
      apiBase: providerConfig.apiBase,
      models: providerConfig.models || [],
    };
    
    // Update or add the provider
    let updatedProviders: Array<{ name: string; enabled?: boolean; apiBase?: string; models?: string[] }>;
    if (existingIndex >= 0) {
      // Merge with existing
      updatedProviders = [...currentProviders];
      updatedProviders[existingIndex] = {
        ...currentProviders[existingIndex],
        ...updatedProvider,
      };
    } else {
      // Add new provider
      updatedProviders = [...currentProviders, updatedProvider];
    }
    
    await config.update('providers', updatedProviders, configTarget);
    
    return { success: true };
  }

  /**
   * Notify all connections of a config change
   */
  notifyConfigChanged(scope: 'user' | 'workspace', provider?: string): void {
    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/configChanged',
      params: { scope, provider: provider || null }
    };
    const message = JSON.stringify(notification);
    const fullMessage = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    for (const socket of this.activeSockets) {
      try {
        socket.write(fullMessage);
      } catch (e) {
        // Socket might be closed
      }
    }
  }

  /**
   * Notify all connections of a secret change
   */
  notifySecretChanged(key: string, action: 'added' | 'removed' | 'changed'): void {
    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/secretChanged',
      params: { key, action }
    };
    const message = JSON.stringify(notification);
    const fullMessage = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    for (const socket of this.activeSockets) {
      try {
        socket.write(fullMessage);
      } catch (e) {
        // Socket might be closed
      }
    }
  }

  // ============ MCP TOOL METHODS ============

  /**
   * List all available tools (MCP tools/list)
   * 
   * @param includeInternal - If true, include internal openllm_* tools
   * @returns List of available tools
   */
  private async listTools(includeInternal: boolean): Promise<{ tools: McpTool[] }> {
    const tools: McpTool[] = [];

    // Internal tools (for openllm-core to use)
    if (includeInternal) {
      tools.push(
        {
          name: 'openllm_secrets_get',
          description: '[Internal] Get an API key from VS Code SecretStorage',
          inputSchema: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Provider name (e.g., openai, anthropic)' }
            },
            required: ['key']
          },
          _internal: true
        },
        {
          name: 'openllm_secrets_set',
          description: '[Internal] Store an API key in VS Code SecretStorage',
          inputSchema: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Provider name' },
              value: { type: 'string', description: 'API key value' }
            },
            required: ['key', 'value']
          },
          _internal: true
        },
        {
          name: 'openllm_secrets_delete',
          description: '[Internal] Delete an API key from VS Code SecretStorage',
          inputSchema: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Provider name' }
            },
            required: ['key']
          },
          _internal: true
        },
        {
          name: 'openllm_secrets_list',
          description: '[Internal] List all stored API key names',
          inputSchema: {
            type: 'object',
            properties: {}
          },
          _internal: true
        },
        {
          name: 'openllm_config_get',
          description: '[Internal] Get provider configuration',
          inputSchema: {
            type: 'object',
            properties: {
              provider: { type: 'string', description: 'Provider name or "*" for all' },
              scope: { type: 'string', enum: ['user', 'workspace'], description: 'Config scope' }
            },
            required: ['provider', 'scope']
          },
          _internal: true
        },
        {
          name: 'openllm_config_set',
          description: '[Internal] Set provider configuration',
          inputSchema: {
            type: 'object',
            properties: {
              provider: { type: 'string', description: 'Provider name' },
              config: { type: 'object', description: 'Provider config object' },
              scope: { type: 'string', enum: ['user', 'workspace'], description: 'Config scope' }
            },
            required: ['provider', 'config', 'scope']
          },
          _internal: true
        },
        {
          name: 'openllm_workspace_root',
          description: '[Internal] Get the current workspace root path',
          inputSchema: {
            type: 'object',
            properties: {}
          },
          _internal: true
        }
      );
    }

    // VS Code tools (user-visible, sent to LLM)
    try {
      for (const tool of vscode.lm.tools) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as object,
          _internal: false
        });
      }
    } catch (error) {
      this.logger.error('[RPC Server] Failed to get vscode.lm.tools:', error);
    }

    this.logger.info(`[RPC Server] tools/list returning ${tools.length} tools (${tools.filter(t => t._internal).length} internal)`);
    return { tools };
  }

  /**
   * Call a tool (MCP tools/call)
   * 
   * Routes to either internal handlers or VS Code tool proxy
   */
  private async callTool(params: McpToolCallParams): Promise<McpToolResult> {
    const { name, arguments: args } = params;
    this.logger.info(`[RPC Server] tools/call: ${name}`);

    try {
      // Route internal tools to appropriate handlers
      if (name.startsWith(INTERNAL_TOOL_PREFIX)) {
        return await this.handleInternalToolCall(name, args);
      }

      // Route to VS Code tool proxy
      return await this.handleVSCodeToolCall(name, args);
    } catch (error) {
      this.logger.error(`[RPC Server] Tool ${name} failed:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }

  /**
   * Handle internal tool calls (openllm_* tools)
   */
  private async handleInternalToolCall(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    switch (name) {
      case 'openllm_secrets_get': {
        const key = `openllm.${args.key}`;
        const value = await this.context.secrets.get(key);
        return this.textResult({ found: !!value, value: value || null });
      }

      case 'openllm_secrets_set': {
        const key = `openllm.${args.key}`;
        await this.context.secrets.store(key, args.value as string);
        return this.textResult({ success: true });
      }

      case 'openllm_secrets_delete': {
        const key = `openllm.${args.key}`;
        await this.context.secrets.delete(key);
        return this.textResult({ success: true });
      }

      case 'openllm_secrets_list': {
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
        return this.textResult({ keys: availableKeys });
      }

      case 'openllm_config_get': {
        const result = await this.getConfig({
          auth: '', // Already authenticated
          provider: args.provider as string,
          scope: args.scope as 'user' | 'workspace',
        });
        return this.textResult(result);
      }

      case 'openllm_config_set': {
        const result = await this.setConfig({
          auth: '', // Already authenticated  
          provider: args.provider as string,
          scope: args.scope as 'user' | 'workspace',
          config: args.config as any,
        });
        return this.textResult(result);
      }

      case 'openllm_workspace_root': {
        const folders = vscode.workspace.workspaceFolders;
        return this.textResult({ path: folders?.[0]?.uri.fsPath || null });
      }

      default:
        throw new Error(`Unknown internal tool: ${name}`);
    }
  }

  /**
   * Proxy a tool call to VS Code's language model tools
   */
  private async handleVSCodeToolCall(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    this.logger.info(`[RPC Server] Proxying VS Code tool: ${name}`);

    try {
      // Find the tool
      const tool = vscode.lm.tools.find(t => t.name === name);
      if (!tool) {
        throw new Error(`Tool not found: ${name}`);
      }

      // Invoke the tool
      const result = await vscode.lm.invokeTool(name, {
        input: args,
        toolInvocationToken: undefined
      }, new vscode.CancellationTokenSource().token);

      // Convert result to MCP format
      const content: Array<{ type: 'text'; text: string }> = [];
      
      for (const part of result.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          content.push({ type: 'text', text: part.value });
        } else {
          // Other part types - serialize to JSON
          content.push({ type: 'text', text: JSON.stringify(part) });
        }
      }

      return { content };
    } catch (error) {
      this.logger.error(`[RPC Server] VS Code tool ${name} failed:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  }

  /**
   * Helper to create a text result
   */
  private textResult(data: unknown): McpToolResult {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(data)
      }]
    };
  }

  /**
   * Check if a tool name is internal (hidden from LLM)
   */
  static isInternalTool(toolName: string): boolean {
    return toolName.startsWith(INTERNAL_TOOL_PREFIX);
  }
}
