# MCP Tools Architecture

This document describes how OpenLLM implements MCP (Model Context Protocol) for tool handling, LLM access, and VS Code integration.

## Overview

The entire chat orchestration loop runs in Rust (`openllm-core`), with the VS Code extension acting as an MCP server. The extension exposes three types of capabilities via MCP:

1. **User-visible tools** - From `vscode.lm.tools` (Copilot tools, extension tools)
2. **Internal tools** - OpenLLM configuration, secrets, and workspace (`openllm_*` prefix, hidden from LLM)
3. **LLM access** - Access to `vscode.lm` models (Copilot, GitHub Models) via MCP

```
┌─────────────────────────────────────────────────────────────────┐
│  openllm-core (Rust) - MCP Client & Unified Orchestrator        │
│                                                                 │
│  ChatOrchestrator:                                              │
│    - Routes to providers (direct HTTP or MCP-based vscode.lm)   │
│    - Handles complete tool calling loop                         │
│    - Streams events back to caller                              │
│                                                                 │
│  VsCodeProvider:                                                │
│    - Uses MCP to access vscode.lm models (Copilot, etc.)        │
│    - Calls openllm_llm_list, openllm_llm_send                   │
│                                                                 │
│  ToolRegistry:                                                  │
│    - Fetches tools via MCP tools/list                           │
│    - Filters internal tools (openllm_* → hidden from LLM)       │
│    - Executes tool calls via MCP tools/call                     │
└─────────────────────────────────────────────────────────────────┘
         │
         │ MCP Protocol (HTTP over Unix Socket/Named Pipe)
         │   tools/list → list available tools
         │   tools/call → execute a tool
         │   openllm_llm_list → list vscode.lm models
         │   openllm_llm_send → send chat to vscode.lm model
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  VS Code Extension - MCP Server (McpToolServer)                 │
│                                                                 │
│  Secrets tools (openllm_secrets_* prefix):                      │
│    - openllm_secrets_get(key) → get API key                     │
│    - openllm_secrets_set(key, value) → store API key            │
│    - openllm_secrets_delete(key) → delete API key               │
│    - openllm_secrets_list() → list stored API key names         │
│                                                                 │
│  Config tools (openllm_config_* prefix):                        │
│    - openllm_config_get(provider, scope) → get provider config  │
│    - openllm_config_set(provider, config, scope) → save config  │
│    - openllm_workspace_root() → get workspace path              │
│                                                                 │
│  LLM tools (openllm_llm_* prefix):                              │
│    - openllm_llm_list(family?) → list vscode.lm models          │
│      • Filters out OpenLLM's own models (vendor: 'open-llm')    │
│      • Prevents circular dependency when Rust queries for LLMs  │
│    - openllm_llm_send(modelId, messages, options?) → chat       │
│      • Sends request to vscode.lm model                         │
│      • Returns response chunks (text, tool_call)                │
│                                                                 │
│  User tools (proxied from vscode.lm.tools):                     │
│    - cursor_read_file, cursor_edit_file, ...                    │
│    - Any Copilot or extension-registered tools                  │
└─────────────────────────────────────────────────────────────────┘
```

## MCP Protocol

OpenLLM uses the official MCP SDKs:
- **Rust (client):** `rmcp` crate
- **TypeScript (server):** `@modelcontextprotocol/sdk`

### Transport

Communication occurs over HTTP transported via Unix sockets (Linux/macOS) or named pipes (Windows):

```
Rust Core                    VS Code Extension
    │                              │
    │  HTTP POST /mcp             │
    │  Content-Type: application/json
    │  ─────────────────────────► │
    │                              │
    │  ◄───────────────────────── │
    │  200 OK                      │
    │  Content-Type: application/json
```

### tools/list

Lists all available tools.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      {
        "name": "openllm_secrets_get",
        "description": "[Internal] Get an API key from VS Code SecretStorage",
        "inputSchema": {
          "type": "object",
          "properties": {
            "key": { "type": "string", "description": "Provider name" }
          },
          "required": ["key"]
        }
      },
      {
        "name": "cursor_read_file",
        "description": "Read contents of a file",
        "inputSchema": { ... }
      }
    ]
  }
}
```

### tools/call

Executes a tool.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "cursor_read_file",
    "arguments": {
      "path": "/path/to/file.ts"
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      { "type": "text", "text": "file contents here..." }
    ],
    "isError": false
  }
}
```

## Rust API

### McpClient

The `McpClient` in `openllm-core` manages MCP communication:

```rust
use openllm_core::mcp::{McpClient, McpTool, McpToolResult};
use std::sync::Arc;

// Connect to MCP server
let client = McpClient::connect("/path/to/socket").await?;

// List all tools
let tools = client.list_tools().await?;

// Call a tool
let result = client.call_tool("cursor_read_file", serde_json::json!({
    "path": "/path/to/file"
})).await?;
```

### McpSecretStore

Access VS Code SecretStorage via MCP:

```rust
use openllm_core::mcp::McpSecretStore;

let store = McpSecretStore::new(mcp_client);

// Get a secret
let api_key = store.get("openai").await?;

// Store a secret
store.store("openai", "sk-...").await?;

// Delete a secret
store.delete("openai").await?;
```

### McpConfigProvider

Access VS Code configuration via MCP:

```rust
use openllm_core::mcp::McpConfigProvider;

let config = McpConfigProvider::new(mcp_client);

// Get provider config
let provider = config.get_provider("openai", "user").await?;

// Save provider config
config.set_provider("openai", config, "user").await?;

// Get workspace path
let workspace = config.get_workspace_path().await?;
```

## Internal Tools

Internal tools (prefixed with `openllm_`) are used by the Rust core for various operations. They are **never sent to the LLM** and are filtered out automatically by the tool orchestrator.

### Secrets API

| Tool | Purpose |
|------|---------|
| `openllm_secrets_get` | Retrieve API key from VS Code SecretStorage |
| `openllm_secrets_set` | Store API key in VS Code SecretStorage |
| `openllm_secrets_delete` | Delete API key from VS Code SecretStorage |
| `openllm_secrets_list` | List all stored API key names |

### Config API

| Tool | Purpose |
|------|---------|
| `openllm_config_get` | Get provider configuration from VS Code settings |
| `openllm_config_set` | Save provider configuration to VS Code settings |
| `openllm_workspace_root` | Get the current workspace root path |

### LLM API

The LLM API tools enable unified orchestration by allowing Rust to use `vscode.lm` models:

| Tool | Purpose |
|------|---------|
| `openllm_llm_list` | List available vscode.lm models (Copilot, GitHub Models) |
| `openllm_llm_send` | Send a chat request to a vscode.lm model |

**Circular Dependency Prevention:**

When `openllm_llm_list` is called, it filters out models with `vendor: 'open-llm'`. This prevents the Rust core from trying to use its own registered models through the MCP bridge, which would create a circular call:

```
Rust ChatOrchestrator
     │ calls VsCodeProvider
     ▼
openllm_llm_list → returns OpenLLM model
     │ 
     ▼ tries to use OpenLLM model
Rust ChatOrchestrator (loop!)
```

By filtering out `vendor: 'open-llm'` models, we ensure only external vscode.lm models (like Copilot) are returned.

## TypeScript Server Implementation

The VS Code extension implements the MCP server in `McpToolServer.ts`:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

class McpToolServer {
    private mcpServer: Server;
    
    constructor(context: vscode.ExtensionContext) {
        this.mcpServer = new Server({
            name: 'openllm-vscode',
            version: '0.1.0'
        }, {
            capabilities: {
                tools: {}
            }
        });
        
        this.registerInternalTools();
        this.registerVSCodeTools();
    }
    
    private registerInternalTools() {
        // Register openllm_secrets_get, openllm_config_get, etc.
    }
    
    private registerVSCodeTools() {
        // Proxy vscode.lm.tools as MCP tools
    }
}
```

## Future: Additional MCP Servers

The architecture supports connecting to additional MCP servers beyond VS Code:

```rust
// Future: Connect to multiple MCP servers
let vscode_client = McpClient::connect("/path/to/vscode.sock").await?;
let filesystem_client = McpClient::connect("/path/to/filesystem.sock").await?;

let registry = ToolRegistry::new(vec![
    ("vscode".to_string(), vscode_client),
    ("filesystem".to_string(), filesystem_client),
]);
```

## VsCodeProvider (Rust)

The `VsCodeProvider` in `openllm-core` treats vscode.lm as just another provider:

```rust
use openllm_core::providers::{create_provider, create_vscode_provider, VsCodeProvider};

// Create standalone (no MCP client yet)
let provider = VsCodeProvider::new(logger);
provider.set_client(mcp_client); // Connect later

// Or create with MCP client
let provider = create_vscode_provider(mcp_client, logger);

// List available vscode.lm models
let models = provider.list_models().await?;

// Use like any other provider
let stream = provider.stream_chat(
    messages,
    ProviderModelConfig::new("copilot/gpt-4o"),
    StreamChatOptions::default(),
    cancel_token,
).await?;
```

### How It Works

1. **Model Discovery:** Calls `openllm_llm_list` MCP tool to get available vscode.lm models
2. **Chat Requests:** Calls `openllm_llm_send` MCP tool with model ID and messages
3. **Response Handling:** Parses JSON response containing text chunks and tool calls
4. **Streaming:** Returns chunks as a standard `StreamResponse` compatible with all other providers

### Model ID Format

VS Code LM models use the format: `vendor/modelId`

Examples:
- `copilot/gpt-4o`
- `github/claude-3-5-sonnet`
- `copilot/gpt-4o-mini`

## Security

- All MCP communication uses Unix sockets with mode 0600 (owner-only access)
- Internal tools are hidden from the LLM to prevent prompt injection
- Tool execution is sandboxed by the VS Code extension
- The MCP server only accepts connections from the local machine
- OpenLLM's own models are filtered from `llm/list` to prevent circular dependencies