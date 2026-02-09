# Python Bindings Documentation

This document describes the Python bindings for OpenLLM. The Python bindings expose the Rust core (`openllm-core`) to Python applications via PyO3.

## Installation

### From PyPI (when published)

```bash
pip install openllm
```

### From Source

```bash
# Install maturin
pip install maturin

# Build and install
cd crates/openllm-python
maturin develop --release
```

## Unified Provider API

All LLM providers are accessed through a single `LlmProvider` class. There are no provider-specific classes—just pass the provider ID as a string.

### Creating a Provider

```python
from openllm import LlmProvider, supported_providers, list_providers

# List all supported provider IDs
providers = supported_providers()
# Returns: ['openai', 'anthropic', 'gemini', 'ollama', 'mistral', 'azure', 'openrouter', 'mock', ...]

# List providers with metadata
for p in list_providers():
    print(f"{p.id}: {p.display_name} (requires key: {p.requires_api_key})")

# Create a provider instance
openai = LlmProvider("openai")
anthropic = LlmProvider("anthropic")
ollama = LlmProvider("ollama")
mock = LlmProvider("mock")  # For testing

# Get provider metadata
meta = openai.metadata()
print(meta.display_name)      # "OpenAI"
print(meta.requires_api_key)  # True

# Get default models
for model in openai.default_models():
    print(f"  {model.id}: {model.name} (context: {model.context_length})")
```

### Streaming Chat

```python
from openllm import (
    LlmProvider, 
    ChatMessage, 
    MessageRole,
    ProviderRequestConfig,
    StreamChatOptions
)

provider = LlmProvider("openai")

# Create messages
messages = [
    ChatMessage.system("You are a helpful assistant."),
    ChatMessage.user("Hello!")
]

# Configure the request
config = ProviderRequestConfig(
    model="gpt-4o",
    api_key="sk-...",
    api_base=None  # Use default
)

# Optional streaming options
options = StreamChatOptions(
    temperature=0.7,
    max_tokens=1000
)

# Stream chat - returns list of chunks
chunks = provider.stream_chat(messages, config, options)

# Process chunks
full_response = ""
for chunk in chunks:
    if chunk.chunk_type == "text":
        full_response += chunk.text
        print(chunk.text, end="", flush=True)
    elif chunk.chunk_type == "tool_call":
        print(f"\nTool call: {chunk.tool_name}({chunk.tool_arguments})")

print(f"\n\nFull response: {full_response}")
```

### Mock Provider

The mock provider is useful for testing without network calls. Configure its behavior via the model name:

```python
mock = LlmProvider("mock")

# Echo mode - echoes back the user's message
chunks = mock.stream_chat(
    messages, 
    ProviderRequestConfig(model="echo"),
    None
)

# Fixed response - returns a specific message
chunks = mock.stream_chat(
    messages,
    ProviderRequestConfig(model="fixed:Hello world!"),
    None
)

# Error mode - simulates a provider error
try:
    chunks = mock.stream_chat(
        messages,
        ProviderRequestConfig(model="error:Connection failed"),
        None
    )
except RuntimeError as e:
    print(f"Expected error: {e}")

# Empty response
chunks = mock.stream_chat(
    messages,
    ProviderRequestConfig(model="empty"),
    None
)
```

## Secret Stores

### EnvSecretStore

Read-only store that checks environment variables:

```python
from openllm import EnvSecretStore

store = EnvSecretStore()

# Get API key from environment
key = store.get("openai")  # Checks OPENAI_API_KEY

# Check if available (always true for env store)
print(store.is_available())  # True

# Check if key exists
print(store.has("openai"))  # True/False

# Get info about a key
info = store.get_info("openai")
print(f"Available: {info.available}, Source: {info.source}")
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

# Store a secret
store.store("openai", "sk-test-...")

# Retrieve it
key = store.get("openai")
print(key)  # sk-test-...

# Check if exists
print(store.has("openai"))  # True

# Delete it
store.delete("openai")

# Clear all
store.clear()

# Check length
print(len(store))  # 0
print(store.is_empty())  # True
```

### KeychainSecretStore

System keychain integration (macOS Keychain, Windows Credential Manager, Linux Secret Service):

```python
from openllm import KeychainSecretStore

# Create with default service name ("openllm")
store = KeychainSecretStore()

# Or with custom service name
store = KeychainSecretStore("my-app")

# Check if keychain is available on this system
if store.is_available():
    store.store("openai", "sk-...")
    key = store.get("openai")
    store.delete("openai")
```

### ChainSecretStore

Combines multiple stores with fallback:

```python
from openllm import ChainSecretStore, KeychainSecretStore, EnvSecretStore

chain = ChainSecretStore([
    KeychainSecretStore(),
    EnvSecretStore()
])

# Returns first match from any store
key = chain.get("openai")

# Store goes to first writable store (keychain)
chain.store("openai", "sk-...")
```

### Listing Available Stores

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

## Configuration

### FileConfigProvider

YAML-based configuration:

```python
from openllm import FileConfigProvider, ProviderConfig, ConfigLevel

# User-level config (~/.openllm/config.yaml)
user_config = FileConfigProvider.user()

# Workspace-level config (.openllm/config.yaml)
workspace_config = FileConfigProvider.workspace("/path/to/project")

# Check if config file exists
print(f"Exists: {user_config.exists()}")
print(f"Path: {user_config.path}")
print(f"Level: {user_config.level}")

# Get all providers
providers = user_config.get_providers()
for p in providers:
    print(f"{p.name}: {'enabled' if p.enabled else 'disabled'}")
    print(f"  Models: {', '.join(p.models)}")

# Add a provider
user_config.add_provider(ProviderConfig(
    name="openai",
    enabled=True,
    api_base=None,
    models=["gpt-4o", "gpt-4o-mini"]
))

# Update a provider
user_config.update_provider("openai", ProviderConfig(
    name="openai",
    enabled=True,
    api_base=None,
    models=["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"]
))

# Remove a provider
user_config.remove_provider("openai")

# Backup config before major changes
backup_path = user_config.backup()
print(f"Backed up to: {backup_path}")

# Reload from disk
user_config.reload()
```

### MemoryConfigProvider

In-memory configuration for testing:

```python
from openllm import MemoryConfigProvider, ProviderConfig

config = MemoryConfigProvider()

# Add a provider
config.add_provider(ProviderConfig(
    name="openai",
    enabled=True,
    models=["gpt-4o"]
))

# Get all providers
providers = config.get_providers()

# Clear all
config.clear()
```

### Import/Export

Convert between JSON and YAML:

```python
# Export to JSON (for VS Code settings migration)
json_str = user_config.export_json()
print(json_str)

# Import from JSON
user_config.import_json('{"providers": [...]}')

# Import provider array directly
user_config.import_providers([
    ProviderConfig("openai", True, None, ["gpt-4o"]),
    ProviderConfig("anthropic", True, None, ["claude-3-5-sonnet-20241022"])
])
```

## Chat Messages

```python
from openllm import ChatMessage, MessageRole

# Create messages using factory methods
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
    input='{"location": "San Francisco"}'
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
full_caps = ModelCapabilities.full()  # All capabilities enabled
```

## Stream Chunks

When streaming, you receive `StreamChunk` objects:

```python
from openllm import StreamChunk

# Chunk types:
# - "text": Text content
# - "tool_call": Complete tool call
# - "tool_call_delta": Partial tool call (streaming)

for chunk in provider.stream_chat(messages, config, options):
    if chunk.chunk_type == "text":
        print(chunk.text, end="")
    elif chunk.chunk_type == "tool_call":
        print(f"Tool: {chunk.tool_name}")
        print(f"  ID: {chunk.tool_id}")
        print(f"  Args: {chunk.tool_arguments}")
    elif chunk.chunk_type == "tool_call_delta":
        # Partial tool call data
        pass
```

## Error Handling

```python
from openllm import LlmProvider, FileConfigProvider

# Provider errors
provider = LlmProvider("openai")
try:
    chunks = provider.stream_chat(messages, config, options)
except RuntimeError as e:
    if "API key" in str(e):
        print("Missing or invalid API key")
    elif "rate limit" in str(e):
        print("Rate limited, try again later")
    else:
        print(f"Provider error: {e}")

# Config errors
config = FileConfigProvider.user()
try:
    config.import_json("invalid json")
except RuntimeError as e:
    print(f"Invalid JSON: {e}")
```

## Complete Example

```python
from openllm import (
    LlmProvider,
    ChatMessage,
    ProviderRequestConfig,
    StreamChatOptions,
    EnvSecretStore,
    FileConfigProvider,
)

def main():
    # Get API key from environment
    secrets = EnvSecretStore()
    api_key = secrets.get("openai")
    
    if not api_key:
        print("Set OPENAI_API_KEY environment variable")
        return
    
    # Create provider
    provider = LlmProvider("openai")
    print(f"Using: {provider.metadata().display_name}")
    
    # Create conversation
    messages = [
        ChatMessage.system("You are a helpful coding assistant."),
        ChatMessage.user("Write a Python function to calculate fibonacci numbers.")
    ]
    
    # Configure request
    config = ProviderRequestConfig(
        model="gpt-4o",
        api_key=api_key
    )
    
    options = StreamChatOptions(
        temperature=0.7,
        max_tokens=500
    )
    
    # Stream response
    print("\nResponse:")
    print("-" * 40)
    
    try:
        chunks = provider.stream_chat(messages, config, options)
        for chunk in chunks:
            if chunk.chunk_type == "text":
                print(chunk.text, end="", flush=True)
        print("\n" + "-" * 40)
    except RuntimeError as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()
```

## Platform Support

The Python bindings are built for:

| Platform | Architecture | 
|----------|--------------|
| Linux | x64, arm64 |
| macOS | x64, arm64 |
| Windows | x64 |

Requires Python 3.9 or later.

## Comparison with NAPI Bindings

The Python and Node.js (NAPI) bindings have feature parity:

| Feature | Python | Node.js |
|---------|--------|---------|
| LlmProvider (unified) | ✅ | ✅ |
| EnvSecretStore | ✅ | ✅ |
| MemorySecretStore | ✅ | ✅ |
| KeychainSecretStore | ✅ | ✅ |
| ChainSecretStore | ✅ | ✅ |
| FileConfigProvider | ✅ | ✅ |
| MemoryConfigProvider | ✅ | ✅ |
| Streaming chat | ✅ | ✅ |
| Mock provider | ✅ | ✅ |
| Tool definitions | ✅ | ✅ |

The main difference is that Python uses synchronous streaming (returns a list of chunks), while Node.js uses callbacks for real-time streaming.
