# OpenLLM

A unified AI daemon for OpenAI, Anthropic, Google Gemini, Mistral, Ollama, and more.

## Features

- **Unified daemon**: TypeScript/Node.js daemon serves all clients via gRPC
- **Multi-provider**: 15+ LLM providers via multi-llm-ts with consistent API
- **Web dashboard**: Configure providers, API keys, and models via browser UI (Red Hat Design System)
- **VS Code integration**: Models appear in VS Code's Language Model picker
- **Dynamic model discovery**: Fetches available models from provider APIs
- **Mock provider**: Built-in mock provider for testing without API keys

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Clients                                                             │
│  ├── VS Code Extension                                               │
│  ├── Web Dashboard                                                   │
│  ├── Python scripts                                                  │
│  ├── Node.js apps                                                    │
│  └── CLI                                                             │
└─────────────────────────────────────────────────────────────────────┘
                              │ gRPC (Unix socket)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  openllm daemon (TypeScript/Node.js)                                 │
│  ├── @grpc/grpc-js      # gRPC server                                │
│  ├── multi-llm-ts       # LLM providers                              │
│  ├── keytar             # Secrets (keychain)                         │
│  └── Express            # Embedded web server                        │
└─────────────────────────────────────────────────────────────────────┘
```

## Quick Start

### 1. Install and run

```bash
cd packages/daemon
npm install
npm run build
node dist/index.js daemon
```

### 2. Start web dashboard

```bash
node dist/index.js web
# Opens http://localhost:8787
```

### 3. Install VS Code Extension

```bash
cd packages/vscode
npm install
npm run package
code --install-extension open-llm-provider-0.1.0.vsix
```

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
| xAI (Grok) | ✓ | ✗ | ✓ |
| Cerebras | ✓ | ✗ | ✓ |
| LM Studio | ✓ | ✗ | ✓ |
| Meta | ✓ | ✗ | ✓ |
| Mock | ✓ | ✓ | ✓ |

*Mock provider is for testing without API keys.*

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
├── packages/
│   ├── daemon/              # TypeScript daemon (gRPC + web server)
│   │   ├── src/
│   │   │   ├── index.ts     # CLI entrypoint (commander.js)
│   │   │   ├── daemon.ts    # Daemon lifecycle
│   │   │   ├── state.ts     # Central DaemonState
│   │   │   ├── transport.ts # Socket/PID management
│   │   │   ├── server/      # gRPC service handlers
│   │   │   ├── providers/   # LLM providers (via multi-llm-ts)
│   │   │   ├── secrets/     # Keychain + env var secrets
│   │   │   ├── config/      # YAML config loader
│   │   │   └── web/         # Embedded Express web server
│   │   ├── static/          # Web dashboard HTML
│   │   └── tests/           # Integration tests
│   ├── python/              # Python gRPC client
│   └── vscode/              # VS Code extension
├── proto/
│   └── openllm/v1/service.proto
├── tests/                   # Test documentation
└── docs/                    # Documentation
```

## gRPC Services

The daemon exposes the `OpenLLM` service:

- **Chat** – Streaming chat
- **ListModels** / **ListProviders** – Discovery
- **GetSecret** / **SetSecret** / **DeleteSecret** – Secrets management
- **Register** / **Unregister** – Client lifecycle
- **VSCodeStream** – Bidirectional backchannel for VS Code extension
- **StartWebServer** / **StopWebServer** – Web dashboard control
- **HealthCheck** – Liveness probe
- **GetStatus** – Daemon status
- **GetConfig** / **UpdateConfig** – Configuration

## Development

```bash
cd packages/daemon
npm run build && node dist/index.js daemon
npm test  # runs vitest (53 tests)
```

## Testing

- Unit tests co-located with source (`src/**/*.test.ts`)
- Integration tests in `tests/integration/`
- Mock provider for testing without API keys

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System architecture
- [Daemon Vision](docs/DAEMON_VISION.md) - Full design document
- [Configuration](docs/CONFIGURATION.md) - Config file reference

## License

MIT
