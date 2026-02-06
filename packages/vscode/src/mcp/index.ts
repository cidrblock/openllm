/**
 * MCP (Model Context Protocol) module
 * 
 * Provides an MCP-compliant server using the official @modelcontextprotocol/sdk.
 * The server runs over HTTP on a Unix socket (or Windows named pipe) for security.
 * 
 * Features:
 * - Internal tools (openllm_*) for secrets and config management
 * - VS Code tools proxied from vscode.lm.tools
 * - Full MCP protocol compliance via official SDK
 */

export { McpToolServer, McpServerInfo, createMcpToolServer } from './McpToolServer';
