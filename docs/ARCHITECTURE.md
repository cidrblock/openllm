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
│   NAPI + MCP Server     PyO3 Bindings            NAPI-rs Bindings       │
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
                    │  │  OpenRouter,      │  │
                    │  │  **VsCodeProvider**│  │
                    │  └───────────────────┘  │
                    │                         │
                    │  ┌───────────────────┐  │
                    │  │  Secret Stores    │  │
                    │  │  Env, Memory,     │  │
                    │  │  Keychain, MCP    │  │
                    │  └───────────────────┘  │
                    │                         │
                    │  ┌───────────────────┐  │
                    │  │  Config Providers │  │
                    │  │  Memory, File,    │  │
                    │  │  MCP (VS Code)    │  │
                    │  └───────────────────┘  │
                    └─────────────────────────┘
                       │                    │
                       │ HTTP               │ MCP
                       ▼                    ▼
    ┌─────────────────────────┐  ┌─────────────────────────┐
    │     LLM Provider APIs   │  │    VS Code Extension    │
    │  OpenAI, Anthropic,     │  │      MCP Server         │
    │  Google, Mistral, etc.  │  │  (vscode.lm, secrets,   │
    └─────────────────────────┘  │   config, tools)        │
                                 └─────────────────────────┘
```

**Key architectural feature:** The `VsCodeProvider` in Rust treats VS Code's language models (Copilot, GitHub Models) as just another provider. It uses MCP to communicate with the VS Code extension, which proxies requests to `vscode.lm`. This allows unified orchestration - the same Rust code handles tool calling for both direct HTTP providers and VS Code LM models.

## Crate Structure

```
crates/
├── openllm-core/           # Pure Rust - core library
│   └── src/
│       ├── providers/      # LLM provider implementations
│       │   ├── openai.rs   # OpenAI, Anthropic, etc. (via genai)
│       │   └── vscode.rs   # VS Code LM provider (via MCP)
│       ├── tools/          # Tool orchestration
│       │   ├── registry.rs # Tool discovery and management
│       │   └── orchestrator.rs # Tool calling loop
│       ├── mcp/            # MCP client for VS Code communication
│       ├── secrets/        # Secret store implementations
│       ├── config/         # Config provider implementations
│       ├── resolver/       # Unified secret & config resolvers
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

Each LLM provider is accessed through the unified `LlmProvider`:

```rust
// Create any provider with a simple ID
let provider = create_provider("openai", logger);
let provider = create_provider("anthropic", logger);
let provider = create_provider("mock", logger);  // For testing

// All providers implement the same trait
#[async_trait]
pub trait Provider: Send + Sync {
    fn metadata(&self) -> ProviderMetadata;
    
    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderModelConfig,
        options: StreamOptions,
        token: CancellationToken,
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
- **VS Code** - Access vscode.lm models (Copilot, GitHub Models) via MCP
- **Mock** - Testing provider with configurable behavior

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
- **McpSecretStore** - VS Code SecretStorage via MCP
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
- **McpConfigProvider** - VS Code settings via MCP

## VS Code Extension

The VS Code extension (`packages/vscode`) serves **four distinct roles**:

### Extension Roles

| Role | Description | Key Files |
|------|-------------|-----------|
| **1. Configuration UI** | Visual interface for managing providers, API keys, and models | `ApiKeyPanel.ts`, `StatusPanel.ts` |
| **2. MCP Server** | MCP server exposing VS Code's SecretStorage, settings, and tools to the Rust core | `McpToolServer.ts` |
| **3. VS Code LM Provider** | Implements `LanguageModelChatProvider` to register LLM models with VS Code's AI features | `OpenLLMProvider.ts`, `ConfigManager.ts` |
| **4. Test/Playground UIs** | Chat interface and playground for testing and comparing models | `ChatViewProvider.ts`, `PlaygroundPanel.ts` |

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      VS Code Extension                           │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐  │
│  │  Configuration   │  │   MCP Server     │  │  LM Provider  │  │
│  │       UI         │  │  (McpToolServer) │  │  (Chat API)   │  │
│  │  ─────────────   │  │  ─────────────   │  │  ───────────  │  │
│  │  ApiKeyPanel     │  │  Secrets API     │  │  OpenLLM      │  │
│  │  StatusPanel     │  │  Config API      │  │  Provider     │  │
│  │                  │  │  Workspace API   │  │               │  │
│  │                  │  │  VS Code Tools   │  │               │  │
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
│  │                      LlmProvider                          │  │
│  └─────────────────────────────┬─────────────────────────────┘  │
└────────────────────────────────┼────────────────────────────────┘
                                 │
                                 ▼
                   ┌───────────────────────────┐
                   │     openllm-core (Rust)   │
                   │                           │
                   │  ┌─────────────────────┐  │
                   │  │  Unified Resolvers  │──┼──► MCP Client
                   │  │  (secrets, config)  │  │    (calls back to
                   │  └─────────────────────┘  │     VS Code MCP)
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

### Role 2: MCP Server

The extension runs an MCP server (`McpToolServer.ts`) that exposes VS Code APIs to the Rust core:

```
Rust Core (openllm-core)
    │
    │  MCP over HTTP/Unix socket
    ▼
VS Code MCP Server
    │
    ├── Internal Tools (openllm_* prefix):
    │   │
    │   ├── Secrets API:
    │   │   ├── openllm_secrets_get    → context.secrets.get()
    │   │   ├── openllm_secrets_set    → context.secrets.store()
    │   │   ├── openllm_secrets_delete → context.secrets.delete()
    │   │   └── openllm_secrets_list   → list stored keys
    │   │
    │   ├── Config API:
    │   │   ├── openllm_config_get     → workspace.getConfiguration()
    │   │   ├── openllm_config_set     → workspace.getConfiguration().update()
    │   │   └── openllm_workspace_root → get workspace path
    │   │
    │   └── LLM API (for unified orchestration):
    │       ├── openllm_llm_list       → vscode.lm.selectChatModels()
    │       │                            (filters out OpenLLM's own models)
    │       └── openllm_llm_send       → model.sendRequest()
    │                                    (sends chat to vscode.lm model)
    │
    └── User Tools (from vscode.lm.tools):
        ├── cursor_read_file
        ├── cursor_edit_file
        └── ... (Copilot and extension tools)
```

This allows the Rust core to:
1. Access VS Code's SecretStorage and settings without direct coupling
2. Discover and execute VS Code tools (vscode.lm.tools)
3. Use vscode.lm models (Copilot, GitHub Models) as if they were regular providers

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

### Unified Chat API

All chat requests flow through a single `chat()` function that handles everything:

```typescript
// TypeScript - one simple call
await native.chat(
  messages,
  { provider: 'openai', model: 'gpt-4o', apiKey: '...' },
  (chunk) => console.log(chunk.text)
);
```

```
┌─────────────────────────────────────────────────────────────────┐
│                     ChatViewProvider (UI)                        │
│                                                                  │
│  User Message → native.chat() → UI Updates                      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ NAPI
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                    chat() function (Rust)                        │
│                                                                  │
│  1. Creates provider based on config.provider                   │
│  2. Connects to MCP for tools (if registered)                   │
│  3. Handles tool calling loop (detect → execute → continue)     │
│  4. Streams events back via callback                            │
└──────────────────────────┬──────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌───────────────┐  ┌───────────────┐  ┌───────────────┐
│ Direct HTTP   │  │ VsCodeProvider│  │ ToolRegistry  │
│ Providers     │  │ (MCP-based)   │  │ (MCP tools)   │
│               │  │               │  │               │
│ OpenAI, etc.  │  │ openllm_llm_* │  │ tools/list    │
│      ↓        │  │      ↓        │  │ tools/call    │
│  HTTP APIs    │  │  vscode.lm    │  │      ↓        │
└───────────────┘  └───────────────┘  │ vscode.lm     │
                                      │ .invokeTool() │
                                      └───────────────┘
```

### Provider Routing

The `ChatOrchestrator` routes requests based on provider ID:

| Provider ID | Routing | Description |
|-------------|---------|-------------|
| `openai`, `anthropic`, `gemini`, etc. | Direct HTTP | Rust calls provider APIs directly |
| `vscode` | MCP → vscode.lm | Rust calls `openllm_llm_send` MCP tool |
| `mock` | In-memory | Testing/development |

### Tool Orchestration Loop

All tool orchestration runs in Rust, regardless of the model source:

```
1. Send request to LLM (direct HTTP or MCP to vscode.lm)
   ↓
2. Receive response stream
   ↓
3. Detect tool calls in response
   ↓
4. If tool calls found:
   │ ├── Execute via MCP (ToolRegistry → VS Code MCP Server)
   │ ├── Collect results
   │ └── Continue to step 1 with results
   ↓
5. Stream final response back to caller
```

### Legacy Flow (removed)

The previous architecture had separate TypeScript orchestration loops for vscode.lm and direct providers. This has been unified—ALL models now go through the Rust `ChatOrchestrator`.

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
   ├── 2. MCP endpoint (VS Code)
   │       └── MCP call to VS Code MCP Server
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
   └── MCP endpoint (VS Code)
       └── MCP call to VS Code MCP Server
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
   ├── If MCP endpoint available → route to VS Code SecretStorage
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
