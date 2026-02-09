# OpenLLM Daemon Vision

**Status:** Proposal  
**Author:** OpenLLM Team  
**Date:** February 2026

---

## Executive Summary

OpenLLM evolves from a library with language bindings to a **unified AI daemon** that serves as the single source of truth for LLM access, configuration, and session state across all clients—VS Code, CLI, Python scripts, and external MCP tools like Claude Desktop.

The daemon enables:
- **Session continuity**: Start a chat in VS Code, continue it from the CLI
- **Universal model access**: Python scripts can use Copilot models via the daemon's connection to VS Code
- **Zero configuration conflicts**: One daemon = one config = one source of truth
- **MCP server exposure**: Claude Desktop, Cursor, and other MCP clients can use OpenLLM's configured models

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Clients                                     │
│                                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │ VS Code Ext  │  │  Python CLI  │  │ Claude Desk  │  │  Other MCP   │ │
│  │  (gRPC +     │  │   (gRPC)     │  │  (MCP stdio) │  │   Clients    │ │
│  │   MCP Srv)   │  │              │  │              │  │              │ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘ │
│         │                 │                 │                 │         │
│         │ gRPC            │ gRPC            │ MCP→gRPC        │         │
│         └─────────────────┴─────────────────┴─────────────────┘         │
└─────────────────────────────────────────────┬───────────────────────────┘
                                              │
                                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        openllm-daemon (Rust)                             │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────────┐│
│  │                         Session Manager                              ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                  ││
│  │  │ sess-abc123 │  │ sess-def456 │  │ sess-xyz789 │                  ││
│  │  │ VS Code     │  │ CLI         │  │ Claude Desk │                  ││
│  │  │ 15 messages │  │ 3 messages  │  │ 8 messages  │                  ││
│  │  └─────────────┘  └─────────────┘  └─────────────┘                  ││
│  └─────────────────────────────────────────────────────────────────────┘│
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐         │
│  │  LLM Providers  │  │  Tool Registry  │  │  Config/Secrets │         │
│  │  OpenAI, etc.   │  │  (Orchestrator) │  │  (Single Source)│         │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────┘         │
│           │                    │                                         │
│           │ HTTP               │ MCP Client                              │
└───────────┼────────────────────┼─────────────────────────────────────────┘
            │                    │
            ▼                    ▼
    ┌───────────────┐    ┌───────────────────────┐
    │   LLM APIs    │    │  VS Code Extension    │
    │  OpenAI       │    │    (MCP Server)       │
    │  Anthropic    │    │  • vscode.lm models   │
    │  Google       │    │  • vscode.lm.tools    │
    │  Mistral      │    │  • SecretStorage      │
    └───────────────┘    └───────────────────────┘
```

---

## Core Components

### 1. openllm-daemon

The central Rust binary that runs as a background process.

**Responsibilities:**
- Serve gRPC API on Unix socket (`/run/user/{uid}/openllm.sock`)
- Manage persistent chat sessions
- Route requests to LLM providers (HTTP) or VS Code (MCP)
- Execute tool calling loops
- Hold unified configuration and secrets

**Lifecycle:**
- Started by first client (VS Code, CLI, MCP shim)
- Stays alive while any client is connected
- Graceful shutdown after configurable idle timeout (default: 5 min)

### 2. VS Code Extension

Dual role: **gRPC client** to daemon + **MCP server** for daemon.

**On activation:**
1. Check if daemon is running (try connect to socket)
2. If not running → spawn daemon as child process
3. Connect to daemon via gRPC
4. Start MCP server (exposing vscode.lm, tools, secrets)
5. Register MCP endpoint with daemon

**On deactivation:**
1. Disconnect from daemon
2. If spawner and no other clients → signal shutdown

### 3. openllm-mcp-server (MCP Shim)

Thin binary that speaks MCP over stdio and proxies to daemon.

**Purpose:** Allow MCP clients (Claude Desktop, Cursor) to use OpenLLM.

**`~/.config/claude/mcpserver.json`:**
```json
{
  "openllm": {
    "command": "openllm-mcp-server",
    "args": []
  }
}
```

**Behavior:**
1. MCP client spawns this binary
2. Binary connects to daemon (starting it if needed)
3. Translates MCP ↔ gRPC
4. Client thinks it owns a dedicated server

### 4. Python/Node.js Clients

Thin gRPC client libraries (auto-generated from proto).

```python
from openllm import Client

client = Client()  # Connects to daemon, starts if needed

# Chat with any model
for chunk in client.chat("openai/gpt-4o", "Hello!"):
    print(chunk.text, end="")

# Use Copilot (if VS Code is connected to daemon)
for chunk in client.chat("vscode/copilot-gpt-4o", "Explain this code"):
    print(chunk.text, end="")

# Continue a session started in VS Code
session = client.get_session("sess-abc123")
for chunk in session.chat("Now refactor it"):
    print(chunk.text, end="")
```

### 5. CLI

Command-line interface for interactive and scripted use.

```bash
# Quick chat
$ openllm chat "Hello" --model openai/gpt-4o

# List sessions
$ openllm session list
ID            MODEL           MESSAGES  AGE        SOURCE
sess-abc123   openai/gpt-4o   15        10m ago    vscode
sess-def456   anthropic/...   3         2h ago     cli

# Attach to a session (started in VS Code)
$ openllm session attach sess-abc123
Resuming session with openai/gpt-4o (15 messages)
---
You: Now add error handling
Assistant: Here's the updated code...

# Detach (session persists)
$ openllm session detach
Session saved.

# Daemon management
$ openllm daemon status
$ openllm daemon stop
```

---

## Session Management

Sessions are the key to the "pickup" feature—starting a conversation in one client and continuing in another.

### Session State

```rust
pub struct Session {
    /// Unique identifier (e.g., "sess-abc123")
    pub id: String,
    
    /// Provider and model (e.g., "openai/gpt-4o")
    pub model: String,
    
    /// Full conversation history
    pub messages: Vec<ChatMessage>,
    
    /// Which client created this session
    pub created_by: ClientType,  // VsCode, Cli, McpClient, Python
    
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    
    /// Last activity timestamp
    pub updated_at: DateTime<Utc>,
    
    /// Optional metadata (workspace path, etc.)
    pub metadata: HashMap<String, String>,
    
    /// Tool state (pending tool calls, results)
    pub tool_state: Option<ToolState>,
}

pub enum ClientType {
    VsCode { workspace: Option<String> },
    Cli,
    McpClient { name: String },  // "claude-desktop", "cursor"
    Python,
    NodeJs,
}
```

### Session Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│                        Session Lifecycle                          │
└──────────────────────────────────────────────────────────────────┘

  VS Code                    Daemon                      CLI
     │                         │                          │
     │  CreateSession(model)   │                          │
     │ ──────────────────────► │                          │
     │                         │ ← sess-abc123 created    │
     │  ◄────────────────────  │                          │
     │  session_id             │                          │
     │                         │                          │
     │  Chat(sess, "Hello")    │                          │
     │ ──────────────────────► │                          │
     │  ◄──── stream ──────    │                          │
     │                         │                          │
     │  Chat(sess, "Thanks")   │                          │
     │ ──────────────────────► │                          │
     │  ◄──── stream ──────    │                          │
     │                         │                          │
     │         [User switches to terminal]                │
     │                         │                          │
     │                         │   ListSessions()         │
     │                         │ ◄──────────────────────  │
     │                         │ ────────────────────────►│
     │                         │   [sess-abc123, ...]     │
     │                         │                          │
     │                         │   AttachSession(abc123)  │
     │                         │ ◄──────────────────────  │
     │                         │ ────────────────────────►│
     │                         │   session + history      │
     │                         │                          │
     │                         │   Chat(sess, "Continue") │
     │                         │ ◄──────────────────────  │
     │                         │ ────────────────────────►│
     │                         │   stream...              │
     │                         │                          │
```

### Session Persistence

Sessions are persisted to disk for crash recovery:

```
~/.openllm/sessions/
├── sess-abc123.json
├── sess-def456.json
└── index.json  # Quick lookup metadata
```

**Retention policy:**
- Active sessions: kept indefinitely
- Inactive sessions: pruned after configurable TTL (default: 7 days)
- Manual deletion via CLI or API

### Session Notifications

When a session is modified by one client, others can be notified:

```protobuf
service OpenLLM {
  // Subscribe to session events
  rpc WatchSessions(WatchSessionsRequest) returns (stream SessionEvent);
}

message SessionEvent {
  string session_id = 1;
  oneof event {
    SessionCreated created = 2;
    SessionUpdated updated = 3;
    SessionDeleted deleted = 4;
  }
}
```

VS Code could use this to show a notification: "Session updated from CLI."

---

## Protocol Definition

### gRPC Service

```protobuf
syntax = "proto3";
package openllm.v1;

import "google/protobuf/timestamp.proto";
import "google/protobuf/empty.proto";

service OpenLLM {
  //
  // Chat
  //
  
  // Stateless chat (no session)
  rpc Chat(ChatRequest) returns (stream ChatChunk);
  
  // Chat within a session
  rpc SessionChat(SessionChatRequest) returns (stream ChatChunk);
  
  //
  // Sessions
  //
  
  rpc CreateSession(CreateSessionRequest) returns (Session);
  rpc GetSession(GetSessionRequest) returns (Session);
  rpc ListSessions(ListSessionsRequest) returns (ListSessionsResponse);
  rpc DeleteSession(DeleteSessionRequest) returns (google.protobuf.Empty);
  rpc WatchSessions(WatchSessionsRequest) returns (stream SessionEvent);
  
  //
  // Models
  //
  
  rpc ListModels(ListModelsRequest) returns (ListModelsResponse);
  rpc ListProviders(ListProvidersRequest) returns (ListProvidersResponse);
  
  //
  // Tools
  //
  
  rpc ListTools(ListToolsRequest) returns (ListToolsResponse);
  
  //
  // Configuration
  //
  
  rpc GetConfig(GetConfigRequest) returns (GetConfigResponse);
  rpc SetConfig(SetConfigRequest) returns (google.protobuf.Empty);
  
  //
  // Secrets
  //
  
  rpc GetSecret(GetSecretRequest) returns (GetSecretResponse);
  rpc SetSecret(SetSecretRequest) returns (google.protobuf.Empty);
  rpc DeleteSecret(DeleteSecretRequest) returns (google.protobuf.Empty);
  
  //
  // Daemon Lifecycle
  //
  
  rpc Ping(PingRequest) returns (PingResponse);
  rpc GetStatus(GetStatusRequest) returns (DaemonStatus);
  rpc Shutdown(ShutdownRequest) returns (google.protobuf.Empty);
  
  //
  // MCP Registration (for VS Code)
  //
  
  rpc RegisterMcpEndpoint(RegisterMcpEndpointRequest) returns (google.protobuf.Empty);
  rpc UnregisterMcpEndpoint(UnregisterMcpEndpointRequest) returns (google.protobuf.Empty);
}

//
// Chat Messages
//

message ChatRequest {
  string provider = 1;        // "openai", "anthropic", "vscode"
  string model = 2;           // "gpt-4o", "claude-3-5-sonnet"
  repeated ChatMessage messages = 3;
  ChatOptions options = 4;
}

message SessionChatRequest {
  string session_id = 1;
  string content = 2;         // User message
  ChatOptions options = 3;
}

message ChatOptions {
  optional float temperature = 1;
  optional int32 max_tokens = 2;
  bool enable_tools = 3;
  int32 max_tool_iterations = 4;
}

message ChatMessage {
  string role = 1;            // "system", "user", "assistant", "tool"
  string content = 2;
  optional string name = 3;   // For tool messages
  optional string tool_call_id = 4;
  repeated ToolCall tool_calls = 5;
}

message ChatChunk {
  oneof chunk {
    TextChunk text = 1;
    ToolCallChunk tool_call = 2;
    ToolResultChunk tool_result = 3;
    ErrorChunk error = 4;
    DoneChunk done = 5;
  }
}

message TextChunk {
  string text = 1;
}

message ToolCallChunk {
  string id = 1;
  string name = 2;
  string arguments = 3;       // JSON string
}

message ToolResultChunk {
  string id = 1;
  string content = 2;
  bool is_error = 3;
}

message ErrorChunk {
  string message = 1;
  string code = 2;
}

message DoneChunk {
  optional string stop_reason = 1;
}

//
// Sessions
//

message Session {
  string id = 1;
  string model = 2;
  repeated ChatMessage messages = 3;
  string created_by = 4;
  google.protobuf.Timestamp created_at = 5;
  google.protobuf.Timestamp updated_at = 6;
  map<string, string> metadata = 7;
}

message CreateSessionRequest {
  string model = 1;
  optional string system_prompt = 2;
  map<string, string> metadata = 3;
}

message GetSessionRequest {
  string session_id = 1;
}

message ListSessionsRequest {
  optional int32 limit = 1;
  optional string cursor = 2;
}

message ListSessionsResponse {
  repeated SessionSummary sessions = 1;
  optional string next_cursor = 2;
}

message SessionSummary {
  string id = 1;
  string model = 2;
  int32 message_count = 3;
  string created_by = 4;
  google.protobuf.Timestamp created_at = 5;
  google.protobuf.Timestamp updated_at = 6;
}

message DeleteSessionRequest {
  string session_id = 1;
}

message WatchSessionsRequest {}

message SessionEvent {
  string session_id = 1;
  oneof event {
    SessionCreated created = 2;
    SessionUpdated updated = 3;
    SessionDeleted deleted = 4;
  }
}

message SessionCreated {
  Session session = 1;
}

message SessionUpdated {
  int32 new_message_count = 1;
}

message SessionDeleted {}

//
// Models & Providers
//

message ListModelsRequest {
  optional string provider = 1;  // Filter by provider
}

message ListModelsResponse {
  repeated Model models = 1;
}

message Model {
  string id = 1;              // "openai/gpt-4o"
  string provider = 2;        // "openai"
  string name = 3;            // "gpt-4o"
  string display_name = 4;    // "GPT-4o"
  ModelCapabilities capabilities = 5;
}

message ModelCapabilities {
  bool streaming = 1;
  bool tool_calling = 2;
  bool vision = 3;
}

message ListProvidersRequest {}

message ListProvidersResponse {
  repeated Provider providers = 1;
}

message Provider {
  string id = 1;
  string display_name = 2;
  bool requires_api_key = 3;
  bool is_connected = 4;      // For vscode provider: is MCP connected?
}

//
// Tools
//

message ListToolsRequest {}

message ListToolsResponse {
  repeated Tool tools = 1;
}

message Tool {
  string name = 1;
  string description = 2;
  string input_schema = 3;    // JSON Schema
  string source = 4;          // "vscode", "builtin"
}

//
// Daemon
//

message PingRequest {}

message PingResponse {
  string version = 1;
  int64 uptime_seconds = 2;
}

message GetStatusRequest {}

message DaemonStatus {
  string version = 1;
  int64 uptime_seconds = 2;
  int32 active_sessions = 3;
  int32 connected_clients = 4;
  bool mcp_connected = 5;     // Is VS Code MCP connected?
  repeated string connected_providers = 6;
}

message ShutdownRequest {
  bool force = 1;             // Shutdown even with active clients
}

//
// MCP Registration
//

message RegisterMcpEndpointRequest {
  string socket_path = 1;     // Path to VS Code's MCP socket
}

message UnregisterMcpEndpointRequest {}
```

---

## MCP Server Exposure

The daemon exposes itself as an MCP server (via the shim) with these tools:

| Tool | Description |
|------|-------------|
| `openllm_chat` | Send a chat message, get streaming response |
| `openllm_list_models` | List all available models (all providers) |
| `openllm_list_sessions` | List active sessions |
| `openllm_create_session` | Create a new session |
| `openllm_session_chat` | Chat within a session |
| `openllm_get_config` | Get configuration |

This allows Claude Desktop to use OpenLLM's configured models:

```
Claude Desktop
     │
     │ "Use openllm_chat with gpt-4o to..."
     ▼
openllm-mcp-server
     │
     │ gRPC Chat(openai/gpt-4o, ...)
     ▼
openllm-daemon
     │
     │ HTTP
     ▼
OpenAI API
```

---

## Client Lifecycle Details

### First Client (VS Code)

```
1. Extension activates
2. Try connect to /run/user/{uid}/openllm.sock
3. Connection fails → socket doesn't exist
4. Spawn: openllm-daemon --socket /run/user/{uid}/openllm.sock
5. Wait for socket to appear (poll with backoff)
6. Connect via gRPC
7. Register MCP endpoint: RegisterMcpEndpoint(my_mcp_socket)
8. Set flag: i_am_spawner = true
```

### Second Client (CLI)

```
1. CLI command: openllm chat "Hello"
2. Try connect to /run/user/{uid}/openllm.sock
3. Connection succeeds → daemon already running
4. Send Chat request
5. Stream response
6. Disconnect
```

### Third Client (Claude Desktop via MCP)

```
1. Claude Desktop spawns: openllm-mcp-server
2. MCP shim tries connect to socket → succeeds
3. MCP shim translates MCP calls to gRPC
4. Claude Desktop uses openllm_chat tool
5. Works seamlessly
```

### Spawner Client Exits

```
1. VS Code deactivates
2. Check: i_am_spawner = true
3. Check: other clients connected?
   - If yes → just disconnect, don't shutdown
   - If no → send Shutdown request with grace period
4. Daemon handles Shutdown:
   - If force=false, wait for grace period (e.g., 5 min)
   - If new client connects during grace → cancel shutdown
   - If grace expires → save sessions, exit
```

---

## Benefits Summary

| Benefit | Description |
|---------|-------------|
| **Session Continuity** | Start in VS Code, continue in CLI, seamlessly |
| **Universal Model Access** | Python/CLI can use Copilot via daemon's MCP connection |
| **Zero Config Conflicts** | One daemon = one config = no drift |
| **MCP Exposure** | Claude Desktop, Cursor can use OpenLLM's models |
| **Warm Performance** | Daemon stays loaded; fast for all clients |
| **Tool Sharing** | VS Code tools available to all clients |
| **Unified Secrets** | One keychain/env lookup, shared |

---

## Migration Path

### Phase 1: Add gRPC Server (Parallel)

1. Add `tonic` gRPC server to `openllm-core`
2. Create `openllm-daemon` binary
3. Implement core RPC methods (Chat, ListModels)
4. VS Code can optionally use daemon mode

### Phase 2: Session Management

1. Implement session state in daemon
2. Add session persistence
3. Add CLI commands: `session list`, `session attach`
4. VS Code shows sessions from daemon

### Phase 3: MCP Shim

1. Create `openllm-mcp-server` binary
2. Publish mcpserver.json configuration
3. Test with Claude Desktop

### Phase 4: Deprecate NAPI/PyO3

1. Generate gRPC clients for Python/Node
2. Update VS Code to use gRPC exclusively
3. Remove NAPI/PyO3 bindings
4. Simplify build (no native compilation per platform)

---

## Open Questions

1. **Session limits?** Max sessions per user? Max message history?
2. **Session sharing?** Can two VS Code windows show the same session?
3. **Conflict resolution?** Two clients chat in same session simultaneously?
4. **Offline mode?** Should CLI work if daemon is down (limited functionality)?
5. **Multi-daemon?** Allow multiple daemons (e.g., per-workspace)?

---

## Appendix: File Locations

| File | Path | Purpose |
|------|------|---------|
| Socket | `/run/user/{uid}/openllm.sock` | gRPC server socket |
| Sessions | `~/.openllm/sessions/*.json` | Persisted sessions |
| Config | `~/.openllm/config.yaml` | User configuration |
| Logs | `~/.openllm/logs/daemon.log` | Daemon logs |
| PID | `~/.openllm/daemon.pid` | Process ID for management |
