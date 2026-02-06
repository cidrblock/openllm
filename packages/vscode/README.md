# Open LLM Provider

**Use any LLM with any VS Code extension** — OpenAI, Anthropic, Google, Ollama & more.

## Features

- **Chat Sidebar** — Built-in chat interface in the Activity Bar
- **Multi-Provider Support** — OpenAI, Anthropic Claude, Google Gemini, Ollama (local), Mistral, Azure OpenAI, OpenRouter
- **Tool Orchestration** — Supports VS Code tools (`vscode.lm.tools`) for agent-style operations
- **Flexible Storage** — VS Code SecretStorage, system keychain, or environment variables
- **Native Config** — Share provider configuration across VS Code, CLI, and Python tools
- **Local Model Support** — Run models locally with Ollama for privacy and cost savings
- **Streaming Support** — Real-time streaming responses from all providers

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "Open LLM Provider"
4. Click Install

## Quick Start

### Configure Providers

1. Open Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
2. Run **"Open LLM: Providers and Models"**
3. Add API keys for your providers
4. Click "Models..." to fetch available models
5. Select models and save

### Manual Configuration

Add to your VS Code settings (`settings.json`):

```json
{
  "openLLM.providers": [
    {
      "name": "openai",
      "enabled": true,
      "models": ["gpt-4o", "gpt-4o-mini"]
    },
    {
      "name": "anthropic",
      "enabled": true,
      "models": ["claude-3-5-sonnet-20241022"]
    },
    {
      "name": "ollama",
      "enabled": true,
      "apiBase": "http://localhost:11434",
      "models": ["llama3.2", "qwen2.5-coder"]
    }
  ]
}
```

API keys can be stored in:
- VS Code SecretStorage (via "Providers and Models" panel)
- System keychain
- Environment variables (`OPENAI_API_KEY`, etc.)
- `.env` files (`~/.openllm/.env` or workspace `.env`)

## Chat Sidebar

Click the chat icon in the Activity Bar to open the built-in chat interface:

- Model selector with all available models
- Streaming responses with real-time display
- Rich markdown formatting with syntax highlighting
- Session history with persistence
- Stop generation button
- New chat / clear conversation

## Commands

| Command | Description |
|---------|-------------|
| `Open LLM: Providers and Models` | Configure providers, API keys, and models |
| `Open LLM: Show Available Models` | View all configured models |
| `Open LLM: Reload Configuration` | Reload configuration |
| `Open LLM: Show Status Panel` | Open status and debug panel |
| `Open LLM: Open Playground` | Compare responses from multiple models |
| `Open LLM: Focus Chat Panel` | Open the Chat sidebar |
| `Open LLM: Clear Chat History` | Clear the current conversation |
| `Open LLM: Export Config to Native` | Export to YAML file |
| `Open LLM: Import Config from Native` | Import from YAML file |

## Supported Providers

| Provider | Tool Calling | Vision | Local |
|----------|-------------|--------|-------|
| OpenAI | ✓ | ✓ | ✗ |
| Anthropic | ✓ | ✓ | ✗ |
| Google Gemini | ✓ | ✓ | ✗ |
| Mistral | ✓ | ✗ | ✗ |
| Ollama | ✗ | ✗ | ✓ |
| Azure OpenAI | ✓ | ✓ | ✗ |
| OpenRouter | ✓ | ✓ | ✗ |

## Configuration Options

### Provider Configuration

| Setting | Description |
|---------|-------------|
| `openLLM.providers` | Array of provider configurations |
| `openLLM.autoReload` | Auto-reload when config changes |
| `openLLM.logLevel` | Logging level (debug, info, warn, error) |

### Secret Storage

| Setting | Default | Description |
|---------|---------|-------------|
| `openLLM.secrets.primaryStore` | `"vscode"` | `"vscode"` or `"keychain"` |
| `openLLM.secrets.checkEnvironment` | `true` | Check env vars as fallback |
| `openLLM.secrets.checkDotEnv` | `false` | Check .env files as fallback |

### Config Source

| Setting | Default | Description |
|---------|---------|-------------|
| `openLLM.config.source` | `"vscode"` | `"vscode"` or `"native"` |
| `openLLM.config.nativeLevel` | `"both"` | `"user"`, `"workspace"`, or `"both"` |

## Native Config Files

Share configuration with CLI and Python tools:

**User level:** `~/.openllm/config.yaml`
**Workspace level:** `.openllm/config.yaml`

```yaml
providers:
  - name: openai
    enabled: true
    models:
      - gpt-4o
      - gpt-4o-mini
  - name: ollama
    enabled: true
    api_base: http://localhost:11434
    models:
      - llama3
```

## Using with Other Extensions

Extensions can use the VS Code Language Model API:

```typescript
import * as vscode from 'vscode';

// Get Open LLM models
const models = await vscode.lm.selectChatModels({
  vendor: 'open-llm'
});

if (models.length > 0) {
  const messages = [
    vscode.LanguageModelChatMessage.User('Hello!')
  ];
  
  const response = await models[0].sendRequest(messages, {}, token);
  
  for await (const chunk of response.text) {
    console.log(chunk);
  }
}
```

## Architecture

The extension serves four distinct roles:

| Role | Description |
|------|-------------|
| **Configuration UI** | Visual interface for managing providers, API keys, and models |
| **RPC Server** | JSON-RPC server exposing VS Code's SecretStorage and settings to the Rust core |
| **LM Provider** | Implements VS Code's Language Model API to register LLM models |
| **Test UIs** | Chat sidebar and playground for testing models |

The extension communicates with the Rust core (`openllm-core`) via NAPI bindings. The Rust core handles:
- Unified secret resolution (env vars, VS Code, keychain)
- Unified config resolution (VS Code settings, native YAML files)
- LLM provider implementations (OpenAI, Anthropic, Gemini, etc.)
- Intelligent write routing (decides where to store secrets/config)

See [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) for detailed documentation.

## Development

```bash
# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch

# Press F5 to debug
```

## License

MIT
