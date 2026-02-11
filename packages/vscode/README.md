# Open LLM Provider

**Use any LLM with any VS Code extension** — OpenAI, Anthropic, Google, Ollama & more.

## Overview

This VS Code extension connects to the OpenLLM daemon and registers configured LLM models with VS Code's Language Model API. Other extensions can then use these models through the standard `vscode.lm` API.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Other VS Code Extensions (e.g., Ansible, custom tools)        │
│                                                                 │
│  const models = await vscode.lm.selectChatModels({             │
│    vendor: 'openllm'                                            │
│  });                                                            │
│  const response = await models[0].sendRequest(messages, ...);  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  OpenLLM Extension (this extension)                            │
│                                                                 │
│  • Connects to daemon on activation                            │
│  • Registers models with VS Code Language Model API            │
│  • Provides workspace path via backchannel                     │
│  • Starts daemon if not running                                │
└─────────────────────────────────────────────────────────────────┘
                              │ gRPC (Unix socket)
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  OpenLLM Daemon (TypeScript/Node.js)                             │
│                                                                 │
│  • Handles all LLM provider communication                      │
│  • Manages configuration and secrets                           │
│  • Provides streaming chat responses                           │
└─────────────────────────────────────────────────────────────────┘
```

## Installation

### From VSIX

```bash
cd packages/vscode
npm install
npm run package
code --install-extension open-llm-provider-0.1.0.vsix
```

### Prerequisites

The OpenLLM daemon must be running:

```bash
# From the repository root
cd packages/daemon
npm install
npm run build

# Start the daemon
node dist/index.js daemon
```

## Configuration

Configuration is managed through the **web dashboard**, not VS Code settings.

### Start the Web Dashboard

```bash
# If daemon is already running:
node dist/index.js web

# Or start both daemon and web server:
node dist/index.js web
```

Open http://localhost:8787 to:
- Add API keys (stored in system keychain or referenced from environment variables)
- Enable/disable providers
- Select which models to expose

### Config Files

Configuration is stored in YAML files:

| Location | Purpose |
|----------|---------|
| `~/.openllm/config.yaml` | User-level (global) settings |
| `<workspace>/.openllm/config.yaml` | Workspace-specific settings |

Example config:

```yaml
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

## Commands

| Command | Description |
|---------|-------------|
| `Open LLM: Show Daemon Status` | Check daemon connection status |
| `Open LLM: Open Dashboard` | Open web dashboard in browser |
| `Open LLM: Configure Provider` | Open provider configuration |

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

## Using OpenLLM Models from Other Extensions

Other extensions can use OpenLLM models through the standard VS Code Language Model API:

```typescript
import * as vscode from 'vscode';

// Get OpenLLM models
const models = await vscode.lm.selectChatModels({
  vendor: 'openllm'
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

## Extension Architecture

The extension is a thin gRPC client with these responsibilities:

| Component | Description |
|-----------|-------------|
| **Daemon Client** | Connects to the OpenLLM daemon via Unix socket |
| **Backchannel** | Provides workspace path to daemon for workspace-level config |
| **LM Provider** | Implements `LanguageModelChatProvider` to register models with VS Code |
| **Status Bar** | Shows connection status |

The extension does **not**:
- Store secrets (secrets are in system keychain)
- Store configuration (config is in YAML files)
- Make direct HTTP calls to LLM providers (daemon handles this)
- Provide a chat UI (use the web dashboard or other extensions)

## Development

```bash
cd packages/vscode

# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode
npm run watch

# Package to VSIX
npm run package

# Press F5 in VS Code to debug
```

## Troubleshooting

### Extension Not Connecting

1. Check if daemon is running:
   ```bash
   pgrep -f "openllm daemon"
   ```

2. Check socket exists:
   ```bash
   ls -la /run/user/$(id -u)/openllm/daemon.sock
   ```

3. Restart daemon:
   ```bash
   pkill -f "node.*openllm"
   rm -f /run/user/$(id -u)/openllm/daemon.sock
   cd packages/daemon && node dist/index.js daemon
   ```

4. Check Output panel: View → Output → "Open LLM Provider"

### Models Not Appearing

1. Open web dashboard (http://localhost:8787)
2. Ensure provider has valid API key
3. Enable the models you want
4. Reload VS Code window

## License

MIT
