# Usage Guide

Open LLM provides a unified interface for multiple LLM providers across Python, Node.js, and VS Code.

## Quick Start

### Python

```python
from openllm import (
    EnvSecretStore, 
    MemorySecretStore,
    KeychainSecretStore,
    FileConfigProvider,
    ProviderConfig,
    list_providers
)

# List available providers
providers = list_providers()
for p in providers:
    print(f"{p.id}: {p.display_name}")

# Use environment variables for API keys
env_store = EnvSecretStore()
key = env_store.get("openai")  # Checks OPENAI_API_KEY

# Use system keychain
keychain = KeychainSecretStore()
keychain.store("openai", "sk-...")
key = keychain.get("openai")

# Use file-based config
config = FileConfigProvider.user()
config.add_provider(ProviderConfig(
    name="openai",
    enabled=True,
    api_base=None,
    models=["gpt-4o", "gpt-4o-mini"]
))

providers = config.get_providers()
print(f"Configured providers: {[p.name for p in providers]}")
```

### Node.js

```javascript
const { 
    EnvSecretStore, 
    MemorySecretStore,
    KeychainSecretStore,
    FileConfigProvider,
    listProviders 
} = require('@openllm/native');

// List available providers
const providers = listProviders();
providers.forEach(p => console.log(`${p.id}: ${p.displayName}`));

// Use environment variables
const envStore = new EnvSecretStore();
const key = await envStore.get('openai');

// Use system keychain
const keychain = new KeychainSecretStore();
await keychain.store('openai', 'sk-...');
const key = await keychain.get('openai');

// Use file-based config
const config = FileConfigProvider.user();
await config.addProvider({
    name: 'openai',
    enabled: true,
    apiBase: undefined,
    models: ['gpt-4o', 'gpt-4o-mini']
});

const configs = await config.getProviders();
console.log('Configured:', configs.map(p => p.name));
```

### VS Code Extension

1. Install the Open LLM Provider extension
2. Open Command Palette → **"Open LLM: Providers and Models"**
3. Add API keys for your providers
4. Click "Models..." to fetch available models
5. Select models and save
6. Use in any extension that supports `vscode.lm`

## Secret Stores

### EnvSecretStore

Read-only store that checks environment variables:

```python
from openllm import EnvSecretStore

store = EnvSecretStore()

# Checks OPENAI_API_KEY
key = store.get("openai")

# Also supports direct env var names
key = store.get("CUSTOM_API_KEY")
```

Environment variable mapping:
| Provider | Variables Checked |
|----------|------------------|
| openai | `OPENAI_API_KEY` |
| anthropic | `ANTHROPIC_API_KEY` |
| gemini | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| mistral | `MISTRAL_API_KEY` |
| azure | `AZURE_API_KEY`, `AZURE_OPENAI_API_KEY` |
| openrouter | `OPENROUTER_API_KEY` |

### MemorySecretStore

In-memory store for testing:

```python
from openllm import MemorySecretStore

store = MemorySecretStore()
store.store("openai", "sk-test-...")
print(store.get("openai"))  # sk-test-...
store.delete("openai")
store.clear()  # Remove all
```

### KeychainSecretStore

System keychain integration (macOS Keychain, Windows Credential Manager, Linux Secret Service):

```python
from openllm import KeychainSecretStore

store = KeychainSecretStore()  # Default service: "openllm"
store = KeychainSecretStore("myapp")  # Custom service name

if store.is_available():
    store.store("openai", "sk-...")
    key = store.get("openai")
    store.delete("openai")
```

### ChainSecretStore

Fallback chain of multiple stores:

```python
from openllm import ChainSecretStore, KeychainSecretStore, EnvSecretStore

# Try keychain first, then environment
chain = ChainSecretStore([
    KeychainSecretStore(),
    EnvSecretStore()
])

# Returns first match
key = chain.get("openai")
```

## Configuration Providers

### MemoryConfigProvider

In-memory configuration for testing:

```python
from openllm import MemoryConfigProvider, ProviderConfig

config = MemoryConfigProvider()

config.add_provider(ProviderConfig(
    name="openai",
    enabled=True,
    api_base=None,
    models=["gpt-4o"]
))

providers = config.get_providers()
```

### FileConfigProvider

YAML-based configuration:

```python
from openllm import FileConfigProvider, ConfigLevel

# User-level: ~/.openllm/config.yaml
user_config = FileConfigProvider.user()

# Workspace-level: .openllm/config.yaml
workspace_config = FileConfigProvider.workspace("/path/to/project")

# Check if file exists
print(f"Config exists: {user_config.exists()}")
print(f"Config path: {user_config.path}")

# Get all providers
providers = user_config.get_providers()

# Add a provider
user_config.add_provider(ProviderConfig(
    name="anthropic",
    enabled=True,
    models=["claude-3-5-sonnet-20241022"]
))

# Update a provider
user_config.update_provider("anthropic", ProviderConfig(
    name="anthropic",
    enabled=True,
    models=["claude-3-5-sonnet-20241022", "claude-3-opus-20240229"]
))

# Remove a provider
user_config.remove_provider("anthropic")

# Backup before major changes
backup_path = user_config.backup()
print(f"Backed up to: {backup_path}")

# Reload from disk
user_config.reload()
```

### Import/Export

Convert between JSON (VS Code) and YAML (native):

```python
# Export to JSON (for VS Code)
json_str = config.export_json()
print(json_str)

# Import from JSON (from VS Code)
config.import_json('{"providers": [...]}')

# Import providers directly
config.import_providers([
    ProviderConfig("openai", True, None, ["gpt-4o"]),
    ProviderConfig("anthropic", True, None, ["claude-3-5-sonnet-20241022"])
])
```

## Chat Messages

```python
from openllm import ChatMessage, MessageRole

# Create messages
system_msg = ChatMessage.system("You are a helpful assistant.")
user_msg = ChatMessage.user("Hello!")
assistant_msg = ChatMessage.assistant("Hi! How can I help?")

# Or with explicit role
msg = ChatMessage(MessageRole.User, "What's the weather?")

# Access properties
print(msg.role)     # MessageRole.User
print(msg.content)  # "What's the weather?"
```

## Tools

```python
from openllm import Tool, ToolCall, ToolResult

# Define a tool
weather_tool = Tool(
    name="get_weather",
    description="Get current weather for a location",
    input_schema='{"type": "object", "properties": {"location": {"type": "string"}}}'
)

# Handle tool calls from LLM
tool_call = ToolCall(
    id="call_123",
    name="get_weather",
    arguments='{"location": "San Francisco"}'
)

# Return tool results
result = ToolResult.success("call_123", '{"temp": 72, "condition": "sunny"}')
# or
error_result = ToolResult.error("call_123", "Location not found")
```

## Model Configuration

```python
from openllm import ModelConfig, ModelCapabilities

# Define model configuration
config = ModelConfig(
    id="openai/gpt-4o",
    provider="openai",
    model="gpt-4o",
    api_key="sk-...",
    api_base="https://api.openai.com/v1",
    context_length=128000
)

# Define capabilities
caps = ModelCapabilities(
    image_input=True,
    tool_calling=True,
    streaming=True
)

# Or use preset
full_caps = ModelCapabilities.full()  # All capabilities
```

## VS Code Extension Integration

### Using Open LLM Models in Your Extension

```typescript
import * as vscode from 'vscode';

async function useOpenLLM() {
    // Get available models from Open LLM
    const models = await vscode.lm.selectChatModels({ vendor: 'open-llm' });
    
    if (models.length === 0) {
        vscode.window.showErrorMessage('No Open LLM models configured');
        return;
    }
    
    // Send a request
    const messages = [
        vscode.LanguageModelChatMessage.User('Explain this code')
    ];
    
    const response = await models[0].sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    
    // Collect streaming response
    let result = '';
    for await (const chunk of response.text) {
        result += chunk;
    }
    
    return result;
}
```

### Sending to Open LLM Chat UI

```typescript
// Open the chat panel
await vscode.commands.executeCommand('openLLM.chatView.focus');

// Send a message with context
await vscode.commands.executeCommand('openLLM.chat.send', {
    message: 'Explain this code',
    context: [{
        path: '/path/to/file.ts',
        name: 'file.ts',
        language: 'typescript',
        content: 'const x = 1;'
    }],
    newSession: true
});
```

## Error Handling

```python
from openllm import FileConfigProvider

config = FileConfigProvider.user()

try:
    config.add_provider(ProviderConfig(
        name="openai",
        enabled=True,
        models=["gpt-4o"]
    ))
except RuntimeError as e:
    print(f"Failed to save config: {e}")

try:
    config.import_json("invalid json")
except RuntimeError as e:
    print(f"Invalid JSON: {e}")
```

## Listing Available Stores

```python
from openllm import list_secret_stores

stores = list_secret_stores()
for store in stores:
    print(f"{store.name}: {store.description} (plugin: {store.is_plugin})")
```

Output:
```
env: Environment variables (OPENAI_API_KEY, etc.) (plugin: False)
memory: In-memory store for testing (plugin: False)
keychain: System keychain (macOS/Windows/Linux) (plugin: False)
```
