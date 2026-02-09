# Open LLM

Bring Your Own LLM — a unified interface for OpenAI, Anthropic, Google Gemini, Mistral, Ollama, Copilot, and more.

## Features

- **Multi-provider support**: 8+ LLM providers with unified API
- **Multi-language**: Rust core with Python and Node.js bindings
- **VS Code extension**: Native integration with `vscode.lm` API (Copilot, GitHub Models)
- **Unified orchestration**: Tool calling handled in Rust for all providers
- **MCP integration**: Access VS Code models and tools via Model Context Protocol
- **Pluggable storage**: Environment variables, system keychain, or custom stores
- **Native configuration**: YAML config files shared across all tools

## Supported Providers

| Provider | Tool Calling | Vision | Streaming | Notes |
|----------|-------------|--------|-----------|-------|
| OpenAI | ✓ | ✓ | ✓ | Direct HTTP |
| Anthropic | ✓ | ✓ | ✓ | Direct HTTP |
| Google Gemini | ✓ | ✓ | ✓ | Direct HTTP |
| Mistral | ✓ | ✗ | ✓ | Direct HTTP |
| Ollama (local) | ✗ | ✗ | ✓ | Direct HTTP |
| Azure OpenAI | ✓ | ✓ | ✓ | Direct HTTP |
| OpenRouter | ✓ | ✓ | ✓ | Direct HTTP |
| **VS Code LM** | ✓ | ✗ | ✓ | **MCP to vscode.lm** |

The **VS Code LM** provider allows accessing Copilot, GitHub Models, and other `vscode.lm` models through the unified API. This works via MCP (Model Context Protocol) - the Rust core calls the VS Code extension, which proxies to `vscode.lm`.

## Installation

### Python

```bash
pip install openllm
```

### Node.js

```bash
npm install @openllm/native
```

### VS Code Extension

Install from VS Code Marketplace or:

```bash
code --install-extension open-llm.open-llm-provider
```

## Quick Start

### Python

```python
from openllm import (
    FileConfigProvider,
    ProviderConfig,
    KeychainSecretStore,
    list_providers
)

# List available providers
for p in list_providers():
    print(f"{p.id}: {p.display_name}")

# Store API key in system keychain
keychain = KeychainSecretStore()
keychain.store("openai", "sk-...")

# Configure providers
config = FileConfigProvider.user()
config.add_provider(ProviderConfig(
    name="openai",
    enabled=True,
    models=["gpt-4o", "gpt-4o-mini"]
))
```

### Node.js

```javascript
const { chat, listProviders, KeychainSecretStore } = require('@openllm/native');

// Simple chat - one function does everything
await chat(
  [{ role: 'user', content: 'Hello, world!' }],
  { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-...' },
  (chunk) => {
    if (chunk.type === 'text') {
      process.stdout.write(chunk.text);
    }
  }
);

// List available providers
listProviders().forEach(p => console.log(`${p.id}: ${p.displayName}`));

// Store API key in system keychain
const keychain = new KeychainSecretStore();
await keychain.store('openai', 'sk-...');
```

### VS Code Extension

1. Open Command Palette → **"Open LLM: Providers and Models"**
2. Add API keys for your providers
3. Click "Models..." to fetch available models
4. Select models and save
5. Models appear in `vscode.lm.selectChatModels({ vendor: 'open-llm' })`

## Configuration

### Native Config Files

**User level:** `~/.openllm/config.yaml`

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

**Workspace level:** `.openllm/config.yaml`

### API Keys

Priority order:
1. System keychain (or VS Code SecretStorage)
2. Environment variables (`OPENAI_API_KEY`, etc.)
3. `.env` files

See [Configuration Guide](docs/CONFIGURATION.md) for details.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) - System design and components
- [Configuration](docs/CONFIGURATION.md) - Settings and API key storage
- [Usage Guide](docs/USAGE.md) - Python and Node.js examples
- [Development](docs/DEVELOPMENT.md) - Building from source

## Repository Structure

```
openllm/
├── crates/
│   ├── openllm-core/       # Rust core library
│   ├── openllm-napi/       # Node.js bindings
│   └── openllm-python/     # Python bindings
├── packages/
│   └── vscode/             # VS Code extension
├── tests/
│   ├── node/               # Node.js tests
│   └── python/             # Python tests
└── docs/                   # Documentation
```

## Building from Source

```bash
# Rust core
cargo build --release

# Node.js bindings
cargo build --release -p openllm-napi
cp target/release/libopenllm_napi.so crates/openllm-napi/npm/openllm.linux-x64-gnu.node

# Python bindings
python3 -m venv .venv
source .venv/bin/activate
pip install maturin
cd crates/openllm-python && maturin develop --release

# VS Code extension
cd packages/vscode && npm install && npm run compile
```

## Testing

```bash
# Rust
cargo test

# Node.js
cd tests/node && node test_secret_stores.js

# Python
source .venv/bin/activate
pytest tests/python/ -v
```

## License

MIT
