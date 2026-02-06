# Open LLM Architecture

## Overview

Open LLM is a multi-language LLM provider library with a Rust core and bindings for Node.js, Python, and a VS Code extension.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Consumer Applications                            │
│                                                                          │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────────┐  │
│  │   VS Code Ext   │  │   Python Apps   │  │   Node.js / CLI Tools   │  │
│  │   (TypeScript)  │  │                 │  │                         │  │
│  └────────┬────────┘  └────────┬────────┘  └────────────┬────────────┘  │
│           │                    │                        │               │
│   VS Code Adapter       PyO3 Bindings            NAPI-rs Bindings       │
│           │                    │                        │               │
└───────────┼────────────────────┼────────────────────────┼───────────────┘
            │                    │                        │
            └────────────────────┼────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     openllm-core        │
                    │       (Rust)            │
                    │                         │
                    │  ┌───────────────────┐  │
                    │  │    Providers      │  │
                    │  │  OpenAI, Claude,  │  │
                    │  │  Gemini, Ollama,  │  │
                    │  │  Mistral, Azure,  │  │
                    │  │  OpenRouter       │  │
                    │  └───────────────────┘  │
                    │                         │
                    │  ┌───────────────────┐  │
                    │  │  Secret Stores    │  │
                    │  │  Env, Memory,     │  │
                    │  │  Keychain         │  │
                    │  └───────────────────┘  │
                    │                         │
                    │  ┌───────────────────┐  │
                    │  │  Config Providers │  │
                    │  │  Memory, File     │  │
                    │  │  (YAML)           │  │
                    │  └───────────────────┘  │
                    └─────────────────────────┘
                                 │
                                 │ HTTP
                                 ▼
                    ┌─────────────────────────┐
                    │     LLM Provider APIs   │
                    │  OpenAI, Anthropic,     │
                    │  Google, Mistral, etc.  │
                    └─────────────────────────┘
```

## Crate Structure

```
crates/
├── openllm-core/           # Pure Rust - core library
│   └── src/
│       ├── providers/      # LLM provider implementations
│       ├── secrets/        # Secret store implementations
│       ├── config/         # Config provider implementations
│       ├── types/          # Shared types (messages, tools, etc.)
│       └── logging/        # Logger implementations
│
├── openllm-napi/           # Node.js bindings (NAPI-rs)
│   └── npm/                # npm package wrapper
│
└── openllm-python/         # Python bindings (PyO3)
```

## Key Abstractions

### Providers

Each LLM provider implements the `Provider` trait:

```rust
#[async_trait]
pub trait Provider: Send + Sync {
    fn metadata(&self) -> ProviderMetadata;
    
    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderModelConfig,
        options: StreamOptions,
        token: Arc<dyn CancellationToken>,
    ) -> Result<impl Stream<Item = StreamChunk>>;
}
```

Supported providers:
- **OpenAI** - GPT-4, GPT-3.5, etc.
- **Anthropic** - Claude 3.5, Claude 3
- **Google Gemini** - Gemini Pro, Flash
- **Mistral** - Mistral Large, Medium
- **Ollama** - Local models (Llama, Qwen, etc.)
- **Azure OpenAI** - Azure-hosted OpenAI
- **OpenRouter** - Multi-provider router

### Secret Stores

Secret stores implement the `SecretStore` trait:

```rust
pub trait SecretStore: Send + Sync {
    fn name(&self) -> &str;
    fn is_available(&self) -> bool;
    fn get(&self, key: &str) -> Option<String>;
    fn store(&self, key: &str, value: &str) -> Result<()>;
    fn delete(&self, key: &str) -> Result<()>;
}
```

Available stores:
- **EnvSecretStore** - Environment variables (read-only)
- **MemorySecretStore** - In-memory (testing)
- **KeychainSecretStore** - System keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- **ChainSecretStore** - Fallback chain of multiple stores

### Config Providers

Config providers manage provider and model configuration:

```rust
#[async_trait]
pub trait ConfigProvider: Send + Sync {
    async fn get_providers(&self) -> Vec<ProviderConfig>;
    async fn add_provider(&self, config: ProviderConfig) -> Result<()>;
    async fn update_provider(&self, name: &str, config: ProviderConfig) -> Result<()>;
    async fn remove_provider(&self, name: &str) -> Result<()>;
}
```

Available providers:
- **MemoryConfigProvider** - In-memory
- **FileConfigProvider** - YAML files (`~/.openllm/config.yaml` or `.openllm/config.yaml`)

## VS Code Extension

The VS Code extension (`packages/vscode`) serves **four distinct roles**:

### Extension Roles

| Role | Description | Key Files |
|------|-------------|-----------|
| **1. Configuration UI** | Visual interface for managing providers, API keys, and models | `ApiKeyPanel.ts`, `StatusPanel.ts` |
| **2. RPC Server / MCP Tool Provider** | JSON-RPC server exposing VS Code's SecretStorage, settings, and tools to the Rust core | `RpcServer.ts` |
| **3. VS Code LM Provider** | Implements `LanguageModelChatProvider` to register LLM models with VS Code's AI features | `OpenLLMProvider.ts`, `ConfigManager.ts` |
| **4. Test/Playground UIs** | Chat interface and playground for testing and comparing models | `ChatViewProvider.ts`, `PlaygroundPanel.ts` |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      VS Code Extension                           │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  Configuration   │  │   RPC Server     │  │  LM Provider  │  │
│  │       UI         │  │  (JSON-RPC)      │  │  (Chat API)   │  │
│  │  ─────────────   │  │  ─────────────   │  │  ───────────  │  │
│  │  ApiKeyPanel     │  │  Secrets API     │  │  OpenLLM      │  │
│  │  StatusPanel     │  │  Config API      │  │  Provider     │  │
│  │                  │  │  Workspace API   │  │               │  │
│  └────────┬─────────┘  └────────▲─────────┘  └───────┬───────┘  │
│           │                     │                    │          │
│           │    ┌────────────────┴────────────────┐   │          │
│           │    │  Test/Playground UIs            │   │          │
│           │    │  ChatViewProvider, Playground   │   │          │
│           │    └─────────────────────────────────┘   │          │
│           │                                          │          │
│           ▼                                          ▼          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                NAPI Bindings (in-process)                 │  │
│  │         UnifiedSecretResolver, UnifiedConfigResolver      │  │
│  └─────────────────────────────┬─────────────────────────────┘  │
└────────────────────────────────┼────────────────────────────────┘
                                 │
                                 ▼
                   ┌───────────────────────────┐
                   │     openllm-core (Rust)   │
                   │                           │
                   │  ┌─────────────────────┐  │
                   │  │  Unified Resolvers  │──┼──► RPC Client
                   │  │  (secrets, config)  │  │    (calls back to
                   │  └─────────────────────┘  │     VS Code RPC)
                   │                           │
                   │  ┌─────────────────────┐  │
                   │  │   LLM Providers     │  │
                   │  │  OpenAI, Anthropic, │  │
                   │  │  Gemini, Ollama...  │  │
                   │  └─────────────────────┘  │
                   └───────────────────────────┘
```

### Role 1: Configuration UI

The extension provides a visual interface (`ApiKeyPanel`) for:
- Adding/removing API keys for providers
- Selecting which models to enable
- Configuring provider settings (base URLs, etc.)
- Choosing between VS Code settings or native YAML config

### Role 2: RPC Server (MCP-Compatible Tool Provider)

The extension runs a JSON-RPC server (`RpcServer.ts`) that exposes VS Code APIs to the Rust core using MCP-compatible endpoints:

```
Rust Core (openllm-core)
    │
    │  JSON-RPC over Unix socket
    ▼
VS Code RPC Server
    │
    ├── Secrets & Config API:
    │   ├── secrets/get    → context.secrets.get()
    │   ├── secrets/store  → context.secrets.store()
    │   ├── secrets/delete → context.secrets.delete()
    │   ├── config/get     → workspace.getConfiguration()
    │   └── config/set     → workspace.getConfiguration().update()
    │
    └── MCP Tools API:
        ├── tools/list     → List all available tools
        └── tools/call     → Execute a tool
```

This allows the Rust core to:
1. Access VS Code's SecretStorage and settings without direct coupling
2. Discover and execute VS Code tools (vscode.lm.tools)

**See [MCP_TOOLS_ARCHITECTURE.md](MCP_TOOLS_ARCHITECTURE.md) for details on tool handling.**

### Role 3: VS Code Language Model Provider

The extension implements `vscode.LanguageModelChatProvider` to register LLM models with VS Code's native AI features:

```typescript
// Other extensions can use Open LLM models:
const models = await vscode.lm.selectChatModels({ vendor: 'open-llm' });
const response = await models[0].sendRequest(messages, {}, token);
```

### Role 4: Test/Playground UIs

For development and testing:
- **ChatViewProvider** - Sidebar chat interface for direct model interaction
- **PlaygroundPanel** - Compare responses from multiple models side-by-side

### Extension Settings

The extension provides configuration via VS Code settings:

**Secret Storage:**
- `openLLM.secrets.primaryStore`: `"vscode"` or `"keychain"`
- `openLLM.secrets.checkEnvironment`: Check env vars as fallback
- `openLLM.secrets.checkDotEnv`: Check .env files as fallback

**Config Source:**
- `openLLM.config.source`: `"vscode"` or `"native"`
- `openLLM.config.nativeLevel`: `"user"`, `"workspace"`, or `"both"`

### Import/Export

The extension supports bidirectional config migration:
- **Export Config to Native (YAML)** - VS Code settings → YAML file
- **Import Config from Native (YAML)** - YAML file → VS Code settings

## Data Flow

### Chat Request

```
1. User sends message in VS Code
   ↓
2. OpenLLMProvider.provideLanguageModelResponse()
   ↓
3. VSCodeProviderAdapter.streamChat()
   ↓
4. MessageConverter converts VS Code messages → Core messages
   ↓
5. @openllm/native (Rust via NAPI-rs)
   ↓
6. openllm-core Provider.stream_chat()
   ↓
7. HTTP request to LLM API
   ↓
8. SSE stream response
   ↓
9. Async stream back to VS Code
```

### Secret Resolution (Unified Resolver)

The Rust core's `UnifiedSecretResolver` checks multiple sources in priority order:

```
1. Extension calls secretResolver.resolve("openai")
   ↓
2. Rust UnifiedSecretResolver checks sources:
   │
   ├── 1. Environment variables (OPENAI_API_KEY)
   │       └── Direct env::var() call - highest priority
   │
   ├── 2. RPC endpoint (VS Code)
   │       └── JSON-RPC call to VS Code RPC Server
   │           └── VS Code calls context.secrets.get()
   │
   └── 3. System keychain
           └── macOS Keychain / Windows Credential Manager / Linux Secret Service
   ↓
3. Return first found value with source info
```

### Config Resolution (Unified Resolver)

The Rust core's `UnifiedConfigResolver` merges config from multiple sources:

```
1. Extension calls configResolver.getAllProviders()
   ↓
2. Rust UnifiedConfigResolver queries sources:
   │
   ├── Native YAML (user): ~/.config/openllm/config.yaml
   ├── Native YAML (workspace): .config/openllm/config.yaml
   │
   └── RPC endpoint (VS Code)
       └── JSON-RPC call to VS Code RPC Server
           └── VS Code returns workspace.getConfiguration()
   ↓
3. Merge and prioritize (workspace > user, native > vscode)
   ↓
4. Return unified provider list with source attribution
```

### Write Routing

When writing config or secrets, the unified resolvers handle routing:

```
1. Extension calls secretResolver.store("openai", key, "auto")
   ↓
2. Rust determines best destination:
   │
   ├── If RPC endpoint available → route to VS Code SecretStorage
   └── Else → route to system keychain
   ↓
3. Return destination name for UI feedback
```

## Native Config Files

### User Level: `~/.openllm/config.yaml`

```yaml
providers:
  - name: openai
    enabled: true
    models:
      - gpt-4o
      - gpt-4o-mini
  - name: anthropic
    enabled: true
    models:
      - claude-3-5-sonnet-20241022
  - name: ollama
    enabled: true
    api_base: http://localhost:11434
    models:
      - llama3
```

### Workspace Level: `.openllm/config.yaml`

Same format, overrides user config when both are used.

## Benefits

### Reusability
The Rust core works in any environment via bindings:
- VS Code extensions (Node.js)
- Python scripts and applications
- CLI tools
- Other Node.js applications

### Type Safety
- Full TypeScript support in VS Code
- Python type hints via PyO3
- Rust's compile-time guarantees

### Performance
- Native Rust performance
- Async/streaming support
- Minimal overhead from bindings

### Security
- System keychain integration
- No keys in config files
- Environment variable fallback
