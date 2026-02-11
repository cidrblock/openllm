# Configuration Guide

OpenLLM uses YAML configuration files and system keychain for secrets.

## Config File Locations

### User Level
`~/.openllm/config.yaml` - Applies globally to all workspaces

### Workspace Level
`<workspace>/.openllm/config.yaml` - Workspace-specific settings

## Config File Format

```yaml
providers:
  openai:
    # Option 1: API key stored in system keychain
    api_key_keychain_name: "OPENAI_API_KEY"
    enabled_models:
      - gpt-4o
      - gpt-4o-mini
      - gpt-4-turbo
  
  anthropic:
    # Option 2: API key from environment variable
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    enabled_models:
      - claude-3-5-sonnet-20241022
      - claude-3-opus-20240229
  
  ollama:
    # Ollama doesn't require an API key
    enabled_models:
      - llama3.2
      - qwen2.5-coder:7b
```

## API Key Storage Options

Each provider can specify exactly ONE of these (mutually exclusive):

### Option 1: Keychain Storage (`api_key_keychain_name`)

- Key stored in system keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)
- Specify the key name used in keychain
- Set via web dashboard "API Key" toggle

```yaml
providers:
  openai:
    api_key_keychain_name: "OPENAI_API_KEY"
```

### Option 2: Environment Variable (`api_key_env_var_name`)

- Key read from environment variable at runtime
- Specify the env var name to check
- Set via web dashboard "Env" toggle

```yaml
providers:
  anthropic:
    api_key_env_var_name: "ANTHROPIC_API_KEY"
```

## Supported Providers

| Provider | ID | Default Env Var |
|----------|-----|-----------------|
| OpenAI | `openai` | `OPENAI_API_KEY` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| Google Gemini | `gemini` | `GOOGLE_API_KEY` |
| Mistral | `mistral` | `MISTRAL_API_KEY` |
| Ollama | `ollama` | *(none needed)* |
| Azure OpenAI | `azure` | `AZURE_OPENAI_API_KEY` |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` |
| Groq | `groq` | `GROQ_API_KEY` |
| xAI (Grok) | `xai` | `XAI_API_KEY` |
| Cerebras | `cerebras` | `CEREBRAS_API_KEY` |
| LM Studio | `lmstudio` | *(none needed)* |
| Meta (Llama) | `meta` | `META_API_KEY` |
| Mock (Testing) | `mock` | *(none needed)* |

## Web Dashboard Configuration

The easiest way to configure OpenLLM is via the web dashboard:

1. Start the daemon: `openllm daemon`
2. Start the web server: `openllm web`
3. Open http://localhost:8787

### Provider Cards

Each provider shows:
- **Name**: Provider display name
- **Toggle**: Choose "Key" (keychain) or "Env" (environment variable)
- **Input field**: Enter API key value (for keychain) or env var name
- **Status badge**: "Configured", "Key missing", or "Not configured"
- **Model selection**: Choose which models to enable

### Config Location

Click the settings icon to choose where config is saved:
- **User**: `~/.openllm/config.yaml` (default)
- **Workspace**: `<workspace>/.openllm/config.yaml` (requires VS Code connection)

## VS Code Extension

The VS Code extension:
- Connects to the daemon automatically
- Provides workspace paths for workspace-level config
- Registers configured models with VS Code's Language Model API

No configuration is stored in the extension itself.

## CLI Configuration

### View Config
```bash
# Check daemon status
openllm status
```

For development (from `packages/daemon`):
```bash
node dist/index.js status
```

### Start Services
```bash
# Start daemon (background)
openllm daemon &

# Start web server
openllm web
```

For development (from `packages/daemon`):
```bash
node dist/index.js daemon &
node dist/index.js web
```

## Example Configurations

### Minimal (Single Provider)
```yaml
providers:
  openai:
    api_key_env_var_name: "OPENAI_API_KEY"
    enabled_models:
      - gpt-4o
```

### Multiple Providers
```yaml
providers:
  openai:
    api_key_keychain_name: "OPENAI_API_KEY"
    enabled_models:
      - gpt-4o
      - gpt-4o-mini
  
  anthropic:
    api_key_keychain_name: "ANTHROPIC_API_KEY"
    enabled_models:
      - claude-3-5-sonnet-20241022
  
  ollama:
    enabled_models:
      - llama3.2
      - qwen2.5-coder:7b
```

### Local Development (All from Env Vars)
```yaml
providers:
  openai:
    api_key_env_var_name: "OPENAI_API_KEY"
    enabled_models:
      - gpt-4o
  
  anthropic:
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    enabled_models:
      - claude-3-5-sonnet-20241022
```

## Best Practices

### Personal Development
- Use keychain storage for API keys (secure, persistent)
- Configure via web dashboard for easy management

### Team Projects
- Use workspace-level config (`.openllm/config.yaml`)
- Reference env vars for API keys
- Team members set their own env vars
- Commit config file, add env var docs to README

### CI/CD
- Use environment variables for API keys
- Set `api_key_env_var_name` in config
- Pass secrets via CI/CD platform

### Security
- Never commit API keys to version control
- Use keychain for local development
- Use env vars for CI/CD and containers
