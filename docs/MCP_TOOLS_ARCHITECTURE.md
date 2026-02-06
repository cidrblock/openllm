# MCP-Compatible Tools Architecture

This document describes how OpenLLM implements MCP (Model Context Protocol) compatible tool handling.

## Overview

The tool orchestration loop runs entirely in Rust (`openllm-core`), with the VS Code extension acting as a tool provider. The extension exposes two types of tools via JSON-RPC:

1. **User-visible tools** - From `vscode.lm.tools` (Copilot tools, extension tools)
2. **Internal tools** - OpenLLM configuration and secrets (`openllm_*` prefix, hidden from LLM)

```
┌─────────────────────────────────────────────────────────────────┐
│  openllm-core (Rust) - Tool Orchestrator                        │
│                                                                 │
│  ToolRegistry:                                                  │
│    - Fetches tools via RPC tools/list                           │
│    - Filters internal tools (openllm_* → hidden from LLM)       │
│    - Applies user preferences (enable/disable)                  │
│    - Provides filtered tools to LLM                             │
│    - Executes tool calls via RPC tools/call                     │
│    - Orchestrates the full tool calling loop                    │
└─────────────────────────────────────────────────────────────────┘
         │
         │ JSON-RPC (Unix Socket)
         │   tools/list → list available tools
         │   tools/call → execute a tool
         ▼
┌─────────────────────────────────────────────────────────────────┐
│  VS Code Extension - Tool Provider (MCP-compatible Server)      │
│                                                                 │
│  Internal tools (openllm_* prefix, _internal: true):            │
│    - openllm_secrets_get(key) → get API key                     │
│    - openllm_secrets_set(key, value) → store API key            │
│    - openllm_secrets_delete(key) → delete API key               │
│    - openllm_secrets_list() → list stored API key names         │
│    - openllm_config_get(provider, scope) → get provider config  │
│    - openllm_config_set(provider, config, scope) → save config  │
│    - openllm_workspace_root() → get workspace path              │
│                                                                 │
│  User tools (proxied from vscode.lm.tools):                     │
│    - cursor_read_file, cursor_edit_file, ...                    │
│    - Any Copilot or extension-registered tools                  │
└─────────────────────────────────────────────────────────────────┘
```

## RPC Protocol

### tools/list

Lists all available tools.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {
    "auth": "<auth_token>",
    "includeInternal": true
  }
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
        },
        "_internal": true
      },
      {
        "name": "cursor_read_file",
        "description": "Read contents of a file",
        "inputSchema": { ... },
        "_internal": false
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
    "auth": "<auth_token>",
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

### ToolRegistry

The `ToolRegistry` in `openllm-core` manages tool discovery and execution:

```rust
use openllm_core::tools::{ToolRegistry, ToolFilter};
use std::sync::Arc;

// Create registry with RPC client
let registry = ToolRegistry::new(Some(Arc::new(rpc_client)), logger);

// Refresh tool list from VS Code
registry.refresh().await?;

// Get tools for LLM (user-visible, enabled only)
let llm_tools = registry.get_llm_tools();

// Execute tool calls from LLM response
let results = registry.execute_tool_calls(&tool_calls).await;

// Enable/disable specific tools
registry.set_tool_enabled("cursor_edit_file", false);
```

### RpcClient Tool Methods

The `RpcClient` provides low-level tool access:

```rust
// List all tools
let tools = client.list_tools_async(include_internal).await?;

// List only user-visible tools
let user_tools = client.list_user_tools_async().await?;

// Call a tool
let result = client.call_tool_async("cursor_read_file", json!({
    "path": "/path/to/file"
})).await?;

// Check if a tool is internal
let is_internal = RpcClient::is_internal_tool("openllm_secrets_get"); // true
```

## Tool Filtering

Tools can be filtered using `ToolFilter`:

```rust
use openllm_core::tools::ToolFilter;

// Default: user-visible, enabled tools only
let filter = ToolFilter::new();

// Include internal tools
let filter = ToolFilter::new().with_internal();

// Exclude specific tools
let filter = ToolFilter::new()
    .with_exclude(["cursor_edit_file".to_string()]);

// Only include specific tools
let filter = ToolFilter::new()
    .with_include(["cursor_read_file".to_string()]);

// Get matching tools
let tools = registry.get_tools(&filter);
```

## Internal Tools

Internal tools (prefixed with `openllm_`) are used by the Rust core for:

| Tool | Purpose |
|------|---------|
| `openllm_secrets_get` | Retrieve API key from VS Code SecretStorage |
| `openllm_secrets_set` | Store API key in VS Code SecretStorage |
| `openllm_secrets_delete` | Delete API key from VS Code SecretStorage |
| `openllm_secrets_list` | List all stored API key names |
| `openllm_config_get` | Get provider configuration from VS Code settings |
| `openllm_config_set` | Save provider configuration to VS Code settings |
| `openllm_workspace_root` | Get the current workspace root path |

These tools are **never sent to the LLM**. They are filtered out automatically by `ToolRegistry.get_llm_tools()`.

## Future: Additional MCP Servers

The architecture supports connecting to additional MCP servers beyond VS Code:

```rust
// Future: Connect to multiple tool providers
let vscode_client = Arc::new(RpcClient::new(vscode_socket, vscode_token));
let mcp_server = Arc::new(RpcClient::new(mcp_socket, mcp_token));

let registry = ToolRegistry::new(vec![
    ("vscode".to_string(), vscode_client),
    ("filesystem".to_string(), mcp_server),
], logger);
```

## Security

- All RPC communication requires an authentication token
- Unix sockets have mode 0600 (owner-only access)
- Internal tools are hidden from the LLM to prevent prompt injection
- Tool execution is sandboxed by the VS Code extension
