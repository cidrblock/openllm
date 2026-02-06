# Configuration Guide

Open LLM supports multiple configuration sources for maximum flexibility.

## Configuration Sources

### 1. VS Code Settings (Default for Extension)

Provider and model configuration in VS Code settings:

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
      "models": ["llama3", "qwen2.5-coder"]
    }
  ]
}
```

### 2. Native YAML Files

YAML configuration shared across all OpenLLM tools (extension, CLI, Python scripts):

**User Level:** `~/.openllm/config.yaml`
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

**Workspace Level:** `.openllm/config.yaml`
Same format. Workspace config can override user config.

## VS Code Extension Settings

### Config Source

Choose where to read provider configuration:

```json
{
  "openLLM.config.source": "vscode",
  "openLLM.config.nativeLevel": "both"
}
```

| Setting | Options | Description |
|---------|---------|-------------|
| `openLLM.config.source` | `"vscode"` / `"native"` | Where to read provider config |
| `openLLM.config.nativeLevel` | `"user"` / `"workspace"` / `"both"` | Which native config files to use |

### Secret Storage

Configure where API keys are stored and resolved:

```json
{
  "openLLM.secrets.primaryStore": "vscode",
  "openLLM.secrets.checkEnvironment": true,
  "openLLM.secrets.checkDotEnv": false
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `openLLM.secrets.primaryStore` | `"vscode"` | Primary key storage: `"vscode"` (VS Code SecretStorage) or `"keychain"` (system keychain) |
| `openLLM.secrets.checkEnvironment` | `true` | Also check environment variables as fallback |
| `openLLM.secrets.checkDotEnv` | `false` | Also check .env files as fallback |

## API Key Storage

API keys are stored separately from configuration for security.

### Priority Order (First Match Wins)

1. **Primary Store** (VS Code SecretStorage or System Keychain)
2. **Environment Variables** (if `checkEnvironment` is true)
3. **`.env` Files** (if `checkDotEnv` is true)

### Environment Variable Names

| Provider | Environment Variables |
|----------|----------------------|
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| Gemini | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Azure | `AZURE_API_KEY`, `AZURE_OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Ollama | *(no key needed)* |

### `.env` File Locations

When `checkDotEnv` is enabled, these files are checked:

1. `~/.openllm/.env` (user global)
2. `<workspace>/.env` (project-specific)
3. `<workspace>/.openllm/.env` (project OpenLLM-specific)

Example `.env` file:
```bash
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-api03-...
GEMINI_API_KEY=AIza...
```

## Import/Export Commands

### Export to Native YAML

**Command:** `Open LLM: Export Config to Native (YAML)`

Exports VS Code settings to a YAML file:
- Choose workspace or user level
- Existing file is backed up automatically
- Creates `.openllm/config.yaml` or `~/.openllm/config.yaml`

### Import from Native YAML

**Command:** `Open LLM: Import Config from Native (YAML)`

Imports YAML configuration into VS Code settings:
- Choose workspace or user level source
- Replaces current VS Code provider settings

## Python Usage

```python
from openllm import FileConfigProvider, ProviderConfig, ConfigLevel

# User-level config
user_config = FileConfigProvider.user()
print(f"Path: {user_config.path}")
print(f"Providers: {[p.name for p in user_config.get_providers()]}")

# Workspace-level config
workspace_config = FileConfigProvider.workspace("/path/to/project")

# Add a provider
user_config.add_provider(ProviderConfig(
    name="openai",
    enabled=True,
    api_base=None,
    models=["gpt-4o", "gpt-4o-mini"]
))

# Export to JSON (for VS Code migration)
json_str = user_config.export_json()

# Import from JSON (from VS Code)
user_config.import_json(json_str)
```

## Node.js Usage

```javascript
const { FileConfigProvider } = require('@openllm/native');

// User-level config
const userConfig = FileConfigProvider.user();
console.log(`Path: ${userConfig.path}`);

// Workspace-level config
const workspaceConfig = FileConfigProvider.workspace('/path/to/project');

// Add a provider
await workspaceConfig.addProvider({
    name: 'openai',
    enabled: true,
    apiBase: undefined,
    models: ['gpt-4o', 'gpt-4o-mini']
});

// Get all providers
const providers = await workspaceConfig.getProviders();
console.log(providers.map(p => p.name));

// Export/import JSON
const json = workspaceConfig.exportJson();
workspaceConfig.importJson(json);
```

## Provider Configuration Options

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Provider identifier (openai, anthropic, gemini, etc.) |
| `enabled` | boolean | Whether provider is active |
| `apiBase` | string? | Custom API endpoint (optional) |
| `models` | string[] | List of model IDs to enable |

### Example Configurations

**OpenAI:**
```yaml
- name: openai
  enabled: true
  models:
    - gpt-4o
    - gpt-4o-mini
    - gpt-4-turbo
```

**Anthropic:**
```yaml
- name: anthropic
  enabled: true
  models:
    - claude-3-5-sonnet-20241022
    - claude-3-opus-20240229
```

**Ollama (Local):**
```yaml
- name: ollama
  enabled: true
  api_base: http://localhost:11434
  models:
    - llama3.2
    - qwen2.5-coder:7b
    - deepseek-coder:6.7b
```

**Azure OpenAI:**
```yaml
- name: azure
  enabled: true
  api_base: https://your-resource.openai.azure.com
  models:
    - gpt-4o  # Your deployment name
```

**OpenRouter:**
```yaml
- name: openrouter
  enabled: true
  models:
    - anthropic/claude-3.5-sonnet
    - google/gemini-pro
    - meta-llama/llama-3.2-70b-instruct
```

## Best Practices

### Personal Development
- Use VS Code SecretStorage (default) for API keys
- Configure providers in VS Code settings for quick iteration

### Team Projects
- Use `.openllm/config.yaml` in workspace (commit to git)
- Use `.env` files for API keys (add to `.gitignore`)
- Team members configure their own keys

### Sharing Across Tools
- Use `~/.openllm/config.yaml` for user-level config
- Use system keychain for API keys
- CLI, Python scripts, and VS Code all share the same config

### CI/CD
- Use environment variables for API keys
- Use workspace config files checked into repo
