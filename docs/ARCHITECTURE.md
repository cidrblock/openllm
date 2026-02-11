# OpenLLM Architecture

## Overview

OpenLLM is a unified AI daemon written in TypeScript/Node.js that provides:
- A gRPC API for chat, sessions, and configuration
- A web dashboard for provider/model management
- A VS Code extension that registers models with VS Code's Language Model API

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Consumer Applications                            │
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │   VS Code Ext   │  │   Python Apps   │  │   Web Dashboard         │  │
│  │   (gRPC)        │  │   (gRPC)        │  │   (HTTP → DaemonState)   │  │
│  └────────┬────────┘  └────────┬────────┘  └────────────┬────────────┘  │
│           │                    │                        │               │
│           └────────────────────┼────────────────────────┘               │
│                                │                                         │
└────────────────────────────────┼─────────────────────────────────────────┘
                                 │ gRPC over Unix Socket (or named pipe)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     openllm daemon (TypeScript)                          │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  gRPC Server (@grpc/grpc-js + proto-loader)                        │  │
│  │  └── OpenLLM Service: chat, sessions, models, secrets             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │  DaemonState    │  │  Providers      │  │  Session Manager          │  │
│  │  (Central Hub)  │  │  (multi-llm-ts) │  │  (Deferred / Stub)       │  │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────────────┘  │
│           │                    │                                         │
│  ┌────────▼────────┐  ┌────────▼────────┐  ┌─────────────────────────┐  │
│  │  keytar + env   │  │  Config Loader   │  │  VS Code Backchannel    │  │
│  │  (Secrets)      │  │  (YAML)         │  │  (workspace paths)      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘  │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Web Dashboard (Express) - Embedded, direct DaemonState access     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└────────────────────────────────────────────┬────────────────────────────┘
                                             │
         ┌───────────────────────────────────┼───────────────────┐
         │                                   │                   │
         ▼                                   ▼                   ▼
┌─────────────────┐              ┌─────────────────┐    ┌───────────────┐
│   LLM APIs      │              │  keytar         │    │  Config Files│
│   (HTTP)        │              │  (keychain)     │    │  (YAML)      │
└─────────────────┘              └─────────────────┘    └───────────────┘
```

## Components

### openllm daemon

The core TypeScript/Node.js process that runs as a background daemon.

**Subcommands:**
- `openllm daemon` - Start the gRPC server on Unix socket (or named pipe on Windows)
- `openllm web` - Start the web dashboard (embedded in daemon or started via gRPC if daemon already running)
- `openllm status` - Check if daemon is running
- `openllm stop` - Stop the running daemon

**Socket location:**
- Linux/macOS: `$XDG_RUNTIME_DIR/openllm/daemon.sock` or `/run/user/{uid}/openllm/daemon.sock`
- Windows: `\\.\pipe\openllm-daemon`

### Web Dashboard (Embedded)

The web dashboard runs inside the daemon process via Express:

- **Port**: `localhost:8787` (configurable)
- **Static assets**: Served from `packages/daemon/static/`
- **API routes**: `/api/*` → Direct calls to `DaemonState` (no gRPC in the loop)
- **Chat SSE**: `POST /api/chat` → Streaming responses via Server-Sent Events

The web server is started either:
1. In-process when `openllm web` runs and no daemon is running
2. Via gRPC `StartWebServer` when a daemon is already running and `openllm web` is invoked

### VS Code Extension

The extension acts as a **thin gRPC client** to the daemon:

1. On activation: Connects to daemon (starts if not running)
2. Registers as a `LanguageModelChatProvider` with VS Code
3. Provides workspace paths via gRPC backchannel (`VSCodeStream`)
4. Opens web dashboard on command

**Key files:**
- `extension.ts` - Activation, commands, status bar
- `daemon/client.ts` - gRPC client wrapper
- `daemon/backchannel.ts` - Bidirectional stream handler
- `providers/OpenLLMLanguageModelProvider.ts` - VS Code LM API integration

## Provider Architecture

All LLM providers are implemented via the `multi-llm-ts` library with a unified adapter:

```typescript
// Provider adapter maps OpenLLM provider IDs to multi-llm-ts engine names
const PROVIDER_ENGINE_MAP: Record<string, string> = {
  mock: 'mock',
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  mistral: 'mistralai',
  ollama: 'ollama',
  azure: 'azure',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
  groq: 'groq',
  xai: 'xai',
  cerebras: 'cerebras',
  lmstudio: 'lmstudio',
  meta: 'meta',
};

// fetchModels() uses loadModels(engineName, config)
// streamChat() uses igniteEngine(engineName, config).generate(modelId, thread)
```

**Supported providers:**
- OpenAI, Anthropic, Google Gemini, Mistral, Ollama
- Azure OpenAI, OpenRouter, DeepSeek, Groq
- xAI (Grok), Cerebras, LM Studio, Meta (Llama)

## Secret Management

Secrets are managed explicitly per-provider with two options:

### Option 1: Keychain Storage (keytar)
- Uses keytar for cross-platform keychain access:
  - macOS: Keychain
  - Linux: libsecret (GNOME Keyring / KDE Wallet)
  - Windows: Credential Vault
- Config references key by name: `api_key_keychain_name: "OPENAI_API_KEY"`

### Option 2: Environment Variable Reference
- Config specifies env var name: `api_key_env_var_name: "OPENAI_API_KEY"`
- Value read from `process.env` at runtime

**Important:** These options are mutually exclusive per provider. The web UI provides a toggle to choose between them.

### SecretStore interface

```typescript
interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
}
```

`DaemonState` uses `KeychainSecretStore` (keytar-backed) by default. If keytar is unavailable, keychain storage is disabled and only env vars work.

## Configuration

### Config Files

- **User level**: `~/.openllm/config.yaml`
- **Workspace level**: `<workspace>/.openllm/config.yaml`

```yaml
providers:
  openai:
    api_key_keychain_name: "OPENAI_API_KEY"  # OR api_key_env_var_name
    enabled_models:
      - gpt-4o
      - gpt-4o-mini
  anthropic:
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    enabled_models:
      - claude-3-5-sonnet-20241022
```

### Config Loader

User and workspace configs are merged (workspace overrides user):

```typescript
// loadConfig(), loadWorkspaceConfig(), mergeConfigs()
// Provider config: api_key_keychain_name | api_key_env_var_name, api_base, enabled_models
```

## gRPC Protocol

Defined in `proto/openllm/v1/service.proto`. The daemon loads protos dynamically via `@grpc/proto-loader` (no code generation for the daemon).

### Core RPCs (Implemented)

| RPC | Description |
|-----|-------------|
| `Chat` | Streaming chat with a model |
| `ListModels` | List available models from providers |
| `ListProviders` | List configured providers |
| `GetSecret` / `SetSecret` / `DeleteSecret` / `ListSecrets` | Secret management |
| `Register` / `Unregister` | Client registration |
| `VSCodeStream` | Bidirectional backchannel |
| `GetStatus` / `HealthCheck` | Daemon status |
| `GetConfig` / `UpdateConfig` | Configuration |
| `GetProviderStatus` | Provider status |
| `GetConnectedWorkspaces` | Workspace paths from VS Code |
| `StartWebServer` / `StopWebServer` | Embedded web dashboard lifecycle |
| `Shutdown` | Daemon shutdown |

### Stub RPCs (Deferred)

| RPC | Description |
|-----|-------------|
| `SessionChat` | Chat within a persistent session |
| `CreateSession` / `GetSession` / `ListSessions` / `DeleteSession` | Session CRUD |
| `WatchSessions` / `ReplaySession` / `SummarizeSession` | Session features |
| `ForkSession` / `ExportSession` / `ImportSession` | Session branching |
| `ListTools` / `ExecuteTool` | Tool execution (future MCP) |
| `RegisterMcpServer` / `UnregisterMcpServer` | MCP server registration |

### VS Code Backchannel

The `VSCodeStream` RPC enables bidirectional communication:

**Daemon → VS Code requests:**
- `GetWorkspace` - Get connected workspace paths
- `InvokeTool` - Invoke VS Code tools (future)
- `ListModels` - List VS Code LM models (future)

**VS Code → Daemon responses:**
- Workspace folder paths
- Tool results
- Error responses

## Session Management

Session management is **deferred**. Stub RPCs exist in the proto and service handlers return `UNIMPLEMENTED` or empty results. Full session persistence (create, fork, export, replay) will be implemented in a future release.

## Data Flow

### Chat Request Flow

```
1. Client sends ChatRequest via gRPC (or POST /api/chat for web)
   ↓
2. DaemonState.chat() parses provider/model from model ID
   ↓
3. DaemonState.resolveApiKey() gets API key (keytar or env var based on config)
   ↓
4. Provider adapter streamChat() uses multi-llm-ts to call LLM API
   ↓
5. Response chunks streamed back to client
```

### Model Discovery Flow

```
1. Client calls ListModels (gRPC or GET /api/models)
   ↓
2. DaemonState.listModels() iterates providers
   ↓
3. For each configured provider:
   - Load API key from config (keychain name or env var name)
   - Resolve key value via secretStore or process.env
   - Call fetchModels(providerId, apiKey) → multi-llm-ts loadModels()
   ↓
4. Aggregate and return all models
```

### Web Dashboard Flow

```
1. Browser loads http://localhost:8787
   ↓
2. Express serves static HTML/JS from packages/daemon/static/
   ↓
3. Frontend makes API calls to Express routes:
   - GET /api/providers → state.listProviders()
   - GET /api/models → state.listModels()
   - GET /api/config → loadConfig()
   - POST /api/config → saveConfig()
   - POST /api/secrets → state.secretStore.set()
   - POST /api/chat → state.chat() (SSE stream)
   ↓
4. Web server has direct DaemonState access (no gRPC in the loop)
```

## File Locations

| File | Path | Purpose |
|------|------|---------|
| Socket (Linux/macOS) | `$XDG_RUNTIME_DIR/openllm/daemon.sock` | gRPC server socket |
| Socket (Windows) | `\\.\pipe\openllm-daemon` | gRPC named pipe |
| PID file | `~/.openllm/openllm.pid` | Daemon process ID |
| User Config | `~/.openllm/config.yaml` | User-level provider config |
| Workspace Config | `<ws>/.openllm/config.yaml` | Workspace-level config |
| Logs | Stdout/stderr | Daemon logs |

## Security

- **Secrets**: Stored in system keychain via keytar when available; never in config files
- **Socket**: Unix socket (or named pipe) with user-only permissions
- **Web dashboard**: Listens on localhost only
- **No remote access**: Daemon designed for local use only
- **Config files**: Created with mode `0o600` (user read/write only)