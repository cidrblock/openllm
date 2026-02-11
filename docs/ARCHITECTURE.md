# OpenLLM Architecture

## Overview

OpenLLM is a unified AI daemon written in Rust that provides:
- A gRPC API for chat, sessions, and configuration
- A web dashboard for provider/model management
- A VS Code extension that registers models with VS Code's Language Model API

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Consumer Applications                            │
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │   VS Code Ext   │  │   Python Apps   │  │   Web Dashboard         │  │
│  │   (gRPC)        │  │   (gRPC)        │  │   (HTTP → gRPC)         │  │
│  └────────┬────────┘  └────────┬────────┘  └────────────┬────────────┘  │
│           │                    │                        │               │
│           └────────────────────┼────────────────────────┘               │
│                                │                                         │
└────────────────────────────────┼─────────────────────────────────────────┘
                                 │ gRPC over Unix Socket
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        openllm daemon (Rust)                             │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  gRPC Server (tonic)                                               │  │
│  │  └── OpenLLM Service: chat, sessions, models, secrets             │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │  DaemonState    │  │  Providers      │  │  Session Manager        │  │
│  │  (Central Hub)  │  │  (via genai)    │  │  (Persistence)          │  │
│  └────────┬────────┘  └────────┬────────┘  └─────────────────────────┘  │
│           │                    │                                         │
│  ┌────────▼────────┐  ┌────────▼────────┐  ┌─────────────────────────┐  │
│  │ UnifiedSecret   │  │ UnifiedConfig   │  │  VS Code Backchannel    │  │
│  │ Resolver        │  │ Resolver        │  │  (workspace paths)      │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────────────┘  │
│                                                                          │
└────────────────────────────────────────────┬─────────────────────────────┘
                                             │
         ┌───────────────────────────────────┼───────────────────┐
         │                                   │                   │
         ▼                                   ▼                   ▼
┌─────────────────┐              ┌─────────────────┐    ┌───────────────┐
│   LLM APIs      │              │  System Keychain│    │  Config Files │
│   (HTTP)        │              │  (secrets)      │    │  (YAML)       │
└─────────────────┘              └─────────────────┘    └───────────────┘
```

## Components

### openllm daemon

The core Rust binary that runs as a background process.

**Subcommands:**
- `openllm daemon` - Start the gRPC server on Unix socket
- `openllm web` - Start the web dashboard (connects to daemon via gRPC)

**Socket location:** `/run/user/{uid}/openllm/daemon.sock`

### Web Dashboard (`openllm web`)

A separate process that serves the web UI and proxies HTTP requests to gRPC:

- **Port**: `localhost:8787`
- **Static assets**: Embedded in binary via `rust-embed`
- **API routes**: `/api/*` → gRPC calls to daemon
- **Chat SSE**: `/api/chat` → streaming responses

### VS Code Extension

The extension acts as a **thin gRPC client** to the daemon:

1. On activation: Connects to daemon (starts if not running)
2. Registers as a `LanguageModelChatProvider` with VS Code
3. Provides workspace paths via gRPC backchannel
4. Opens web dashboard on command

**Key files:**
- `extension.ts` - Activation, commands, status bar
- `daemon/client.ts` - gRPC client wrapper
- `daemon/backchannel.ts` - Bidirectional stream handler
- `providers/OpenLLMLanguageModelProvider.ts` - VS Code LM API integration

## Provider Architecture

All LLM providers are implemented via the `genai` crate with a unified `Provider` trait:

```rust
#[async_trait]
pub trait Provider: Send + Sync {
    fn metadata(&self) -> ProviderMetadata;
    
    async fn list_models(&self, api_key: Option<&str>) 
        -> ProviderResult<Option<Vec<DynamicModelInfo>>>;
    
    async fn stream_chat(
        &self,
        messages: Vec<Message>,
        config: ProviderModelConfig,
        options: StreamOptions,
        token: CancellationToken,
    ) -> ProviderResult<Pin<Box<dyn Stream<Item = StreamChunk> + Send>>>;
}
```

**Supported providers:**
- OpenAI, Anthropic, Google Gemini, Mistral, Ollama
- Azure OpenAI, OpenRouter, DeepSeek, Groq
- Together, Cohere, xAI (Grok), Fireworks, Nebius

## Secret Management

Secrets are managed explicitly per-provider with two options:

### Option 1: Keychain Storage
- Key stored in system keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- Config references key by name: `api_key_keychain_name: "OPENAI_API_KEY"`

### Option 2: Environment Variable Reference
- Config specifies env var name: `api_key_env_var_name: "OPENAI_API_KEY"`
- Value read from environment at runtime

**Important:** These options are mutually exclusive per provider. The web UI provides a toggle to choose between them.

### UnifiedSecretResolver

```rust
pub struct UnifiedSecretResolver {
    // MCP client for VS Code backchannel (optional)
    mcp_client: Option<Arc<McpClient>>,
}

impl UnifiedSecretResolver {
    pub fn resolve_from_keychain(&self, key_name: &str) -> Option<ResolvedSecret>;
    pub fn resolve_from_env(&self, env_var_name: &str) -> Option<ResolvedSecret>;
    pub fn store_in_keychain(&self, key_name: &str, value: &str) -> Result<(), String>;
    pub fn delete_from_keychain(&self, key_name: &str) -> Result<(), String>;
}
```

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

### UnifiedConfigResolver

Loads and merges config from user and workspace files:

```rust
pub struct UnifiedConfigResolver {
    user_path: PathBuf,          // ~/.openllm/config.yaml
    workspace_path: Option<PathBuf>,  // Set via VS Code backchannel
}
```

## gRPC Protocol

Defined in `proto/openllm/v1/service.proto`:

### Core RPCs

| RPC | Description |
|-----|-------------|
| `Chat` | Streaming chat with a model |
| `SessionChat` | Chat within a persistent session |
| `ListModels` | List available models from providers |
| `ListProviders` | List configured providers |
| `GetSecret` / `SetSecret` / `DeleteSecret` | Keychain management |
| `Register` / `Unregister` | Client registration |
| `VSCodeStream` | Bidirectional backchannel |

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

Sessions persist chat history for continuity across clients:

```rust
pub struct Session {
    pub id: String,
    pub model: String,
    pub messages: Vec<Message>,
    pub created_by: ClientType,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub metadata: HashMap<String, String>,
}
```

**Storage:** `~/.openllm/sessions/`

**Features:**
- Fork sessions to try different approaches
- Export/import as JSON for sharing
- Replay sessions in different tools

## Data Flow

### Chat Request Flow

```
1. Client sends ChatRequest via gRPC
   ↓
2. DaemonState.get_provider() finds provider instance
   ↓
3. UnifiedSecretResolver gets API key (keychain or env var based on config)
   ↓
4. Provider.stream_chat() calls LLM API
   ↓
5. Response chunks streamed back to client
```

### Model Discovery Flow

```
1. Client calls ListModels
   ↓
2. DaemonState.list_models_dynamic() iterates providers
   ↓
3. For each configured provider:
   - Load API key from config (keychain name or env var name)
   - Resolve key value
   - Call provider.list_models(api_key)
   ↓
4. Aggregate and return all models
```

### Web Dashboard Flow

```
1. Browser loads http://localhost:8787
   ↓
2. Static HTML/JS served from embedded assets
   ↓
3. Alpine.js frontend makes API calls:
   - GET /api/providers → gRPC ListProviders
   - GET /api/models → gRPC ListModels
   - POST /api/config → Save to YAML file
   - POST /api/secrets/{key} → gRPC SetSecret (keychain)
   ↓
4. UI updates reactively
```

## File Locations

| File | Path | Purpose |
|------|------|---------|
| Socket | `/run/user/{uid}/openllm/daemon.sock` | gRPC server socket |
| User Config | `~/.openllm/config.yaml` | User-level provider config |
| Workspace Config | `<ws>/.openllm/config.yaml` | Workspace-level config |
| Sessions | `~/.openllm/sessions/*.json` | Persisted sessions |
| Logs | Stdout/stderr | Daemon logs (tracing) |

## Security

- **Secrets**: Stored in system keychain, never in config files
- **Socket**: Unix socket with user-only permissions
- **Web dashboard**: Listens on localhost only
- **No remote access**: Daemon designed for local use only
