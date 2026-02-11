# OpenLLM

A unified AI daemon for OpenAI, Anthropic, Google Gemini, Mistral, Ollama, and more.

## Features

- **Unified daemon**: Single Rust binary serves all clients via gRPC
- **Multi-provider**: 15+ LLM providers with consistent API
- **Web dashboard**: Configure providers, API keys, and models via browser UI
- **Session continuity**: Start a chat in VS Code, continue in CLI, share with teammates
- **VS Code integration**: Models appear in VS Code's Language Model picker
- **Dynamic model discovery**: Fetches available models from provider APIs

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Clients                                                             │
│  ├── VS Code Extension (gRPC + backchannel)                         │
│  ├── Web Dashboard (HTTP → gRPC proxy)                              │
│  ├── Python scripts (gRPC)                                          │
│  ├── Node.js apps (gRPC)                                            │
│  └── CLI (gRPC)                                                     │
└─────────────────────────────────────────────────────────────────────┘
                              │ gRPC (Unix socket)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  openllm daemon (Rust)                                               │
│  ├── OpenLLM Service: chat, sessions, models, config                │
│  ├── Providers: OpenAI, Anthropic, Gemini, Ollama, etc.             │
│  ├── Sessions: persistence, replay, sharing                         │
│  └── Secrets: keychain storage, env var references                  │
└─────────────────────────────────────────────────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
    LLM APIs           Web Dashboard         VS Code
  (HTTP direct)       (localhost:8787)    (backchannel)
```

## Quick Start

### 1. Build and Run

```bash
# Build
cargo build --release

# Start the daemon
./target/release/openllm daemon

# Start the web server (in another terminal)
./target/release/openllm web
```

### 2. Configure via Web Dashboard

Open http://localhost:8787 to:
- Add API keys for providers (stored in system keychain)
- Or reference environment variables for keys
- Enable/disable models per provider

### 3. Install VS Code Extension

```bash
cd packages/vscode
npm install
npm run package
code --install-extension open-llm-provider-0.1.0.vsix
```

The extension:
- Connects to the daemon automatically
- Registers configured models with VS Code's Language Model API
- Provides workspace path info to the daemon for workspace-level config

## Supported Providers

| Provider | Tool Calling | Vision | Streaming |
|----------|-------------|--------|-----------|
| OpenAI | ✓ | ✓ | ✓ |
| Anthropic | ✓ | ✓ | ✓ |
| Google Gemini | ✓ | ✓ | ✓ |
| Mistral | ✓ | ✗ | ✓ |
| Ollama | ✗ | ✗ | ✓ |
| Azure OpenAI | ✓ | ✓ | ✓ |
| OpenRouter | ✓ | ✓ | ✓ |
| DeepSeek | ✓ | ✗ | ✓ |
| Groq | ✓ | ✗ | ✓ |
| Together | ✓ | ✗ | ✓ |
| Cohere | ✓ | ✗ | ✓ |
| xAI (Grok) | ✓ | ✗ | ✓ |

## Configuration

### API Keys

Two options per provider (mutually exclusive):

1. **Keychain storage**: Enter key value → stored securely in system keychain
2. **Environment variable**: Specify env var name (e.g., `OPENAI_API_KEY`)

### Config Files

- **User config**: `~/.openllm/config.yaml`
- **Workspace config**: `<workspace>/.openllm/config.yaml`

```yaml
# Example config.yaml
providers:
  openai:
    api_key_keychain_name: "OPENAI_API_KEY"
    enabled_models:
      - gpt-4o
      - gpt-4o-mini
  anthropic:
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    enabled_models:
      - claude-3-5-sonnet-20241022
```

## Project Structure

```
openllm/
├── crates/
│   └── openllm/              # Rust daemon + web server
│       ├── src/
│       │   ├── main.rs       # CLI entrypoint
│       │   ├── server/       # gRPC services
│       │   ├── providers/    # LLM providers (via genai)
│       │   ├── session/      # Session management
│       │   ├── secrets/      # Keychain integration
│       │   ├── resolver/     # Config & secret resolution
│       │   └── web/          # Web dashboard (axum + embedded assets)
│       └── Cargo.toml
├── proto/
│   └── openllm/v1/service.proto  # gRPC service definition
├── packages/
│   ├── python/               # Python gRPC client
│   ├── proto-ts/             # TypeScript proto definitions
│   └── vscode/               # VS Code extension
└── docs/
```

## gRPC Services

The daemon exposes the `OpenLLM` service:

- `Chat` / `SessionChat` - Streaming chat
- `CreateSession` / `ListSessions` / `ForkSession` - Session management
- `ExportSession` / `ImportSession` - Session sharing
- `ListModels` / `ListProviders` - Discovery
- `GetSecret` / `SetSecret` / `DeleteSecret` - Secrets management
- `VSCodeStream` - Bidirectional backchannel for VS Code extension

## Development

```bash
# Build
cargo build --release

# Run daemon
./target/release/openllm daemon

# Run web server
./target/release/openllm web

# Generate TypeScript proto stubs
./scripts/generate-clients.sh typescript

# Build VS Code extension
cd packages/vscode && npm run compile
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System architecture
- [Daemon Vision](docs/DAEMON_VISION.md) - Full design document
- [Configuration](docs/CONFIGURATION.md) - Config file reference

## License

MIT
