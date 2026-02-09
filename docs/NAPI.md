# NAPI Interface Documentation

This document describes the Node.js (NAPI) bindings for OpenLLM. The NAPI layer exposes the Rust core (`openllm-core`) to Node.js applications, including the VS Code extension.

## Installation

```bash
npm install @openllm/native
```

Or link locally during development:

```bash
cd packages/vscode
npm link ../../crates/openllm-napi/npm
```

## Quick Start: Unified Chat API

The simplest way to use OpenLLM is the unified `chat()` function. It handles everything—provider creation, MCP connection (if available), tool orchestration, and streaming:

```typescript
import { chat } from '@openllm/native';

// Simple chat - one function does everything
await chat(
  [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' }
  ],
  {
    provider: 'openai',
    model: 'gpt-4o',
    apiKey: 'sk-...',
    enableTools: true,      // Enable tool calling if MCP is available
    maxToolIterations: 10   // Max tool call rounds
  },
  (chunk) => {
    switch (chunk.type) {
      case 'text':
        process.stdout.write(chunk.text);
        break;
      case 'toolCall':
        console.log('Tool:', chunk.name, chunk.arguments);
        break;
      case 'toolResult':
        console.log('Result:', chunk.content);
        break;
      case 'done':
        console.log('\n--- Complete ---');
        break;
    }
  }
);
```

### Supported Providers

The `provider` field accepts any of these IDs:

| Provider | ID | Notes |
|----------|-----|-------|
| OpenAI | `openai` | Direct HTTP to OpenAI API |
| Anthropic | `anthropic` | Direct HTTP to Anthropic API |
| Google Gemini | `gemini` | Direct HTTP to Google API |
| Mistral | `mistral` | Direct HTTP to Mistral API |
| Ollama | `ollama` | Local models via HTTP |
| Azure OpenAI | `azure` | Requires `apiBase` |
| OpenRouter | `openrouter` | Multi-provider router |
| **VS Code LM** | `vscode` | **MCP to vscode.lm (Copilot, etc.)** |
| Mock | `mock` | Testing (no network) |

### VS Code Provider

The `vscode` provider allows accessing Copilot and other `vscode.lm` models through the same API:

```typescript
await chat(
  [{ role: 'user', content: 'Hello!' }],
  { provider: 'vscode', model: 'copilot/gpt-4o' },
  (chunk) => console.log(chunk)
);
```

This works via MCP (Model Context Protocol)—the Rust core calls the VS Code extension's MCP server, which proxies to `vscode.lm`. See [MCP_TOOLS_ARCHITECTURE.md](./MCP_TOOLS_ARCHITECTURE.md) for details.

---

## Advanced: Provider API

For more control, you can use the `LlmProvider` class directly. There are no provider-specific classes—just pass the provider ID as a string.

### Creating a Provider

```typescript
import { LlmProvider, listProviders, supportedProviders } from '@openllm/native';

// List all supported providers
const providers = supportedProviders();
// Returns: ['openai', 'anthropic', 'gemini', 'ollama', 'mistral', 'azure', 'openrouter', 'mock', ...]

// Create a provider instance
const openai = new LlmProvider('openai');
const anthropic = new LlmProvider('anthropic');
const ollama = new LlmProvider('ollama');
const mock = new LlmProvider('mock');  // For testing

// Get provider metadata
const meta = openai.metadata();
console.log(meta.displayName);     // "OpenAI"
console.log(meta.requiresApiKey);  // true
console.log(meta.defaultModels);   // Array of model definitions
```

### Streaming Chat

```typescript
import { LlmProvider, ChatMessage, StreamChunk } from '@openllm/native';

const provider = new LlmProvider('openai');

const messages: ChatMessage[] = [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello!' }
];

const config = {
    model: 'gpt-4o',
    apiKey: 'sk-...',
    apiBase: undefined  // Use default
};

const options = {
    temperature: 0.7,
    maxTokens: 1000
};

// Stream chat with callback
await provider.streamChat(messages, config, options, (err, chunk) => {
    if (err) {
        console.error('Error:', err);
        return;
    }
    
    if (chunk) {
        switch (chunk.type) {
            case 'text':
                process.stdout.write(chunk.text);
                break;
            case 'toolCall':
                console.log('Tool call:', chunk.id, chunk.name, chunk.arguments);
                break;
            case 'done':
                console.log('\n--- Stream complete ---');
                break;
        }
    }
});
```

### Mock Provider

The mock provider is useful for testing without network calls. Configure its behavior via the model name:

```typescript
const mock = new LlmProvider('mock');

// Echo mode - echoes back the user's message
await mock.streamChat(messages, { model: 'echo' }, options, callback);

// Fixed response - returns a specific message
await mock.streamChat(messages, { model: 'fixed:Hello world!' }, options, callback);

// Error mode - simulates a provider error
await mock.streamChat(messages, { model: 'error:Connection failed' }, options, callback);

// Empty response
await mock.streamChat(messages, { model: 'empty' }, options, callback);
```

## Secret Stores

### EnvSecretStore

Read-only store that checks environment variables:

```typescript
import { EnvSecretStore } from '@openllm/native';

const store = new EnvSecretStore();

// Get API key from environment
const key = await store.get('openai');  // Checks OPENAI_API_KEY

// Check if available (always true for env store)
console.log(store.isAvailable());  // true

// Check if key exists
console.log(await store.has('openai'));  // true/false

// List known keys (only returns keys that exist)
const keys = await store.list();  // ['openai', 'anthropic', ...]
```

### MemorySecretStore

In-memory store for testing:

```typescript
import { MemorySecretStore } from '@openllm/native';

const store = new MemorySecretStore();

// Store a secret
await store.store('openai', 'sk-test-...');

// Retrieve it
const key = await store.get('openai');

// Delete it
await store.delete('openai');

// Clear all
await store.clear();
```

### KeychainSecretStore

System keychain integration:

```typescript
import { KeychainSecretStore } from '@openllm/native';

// Create with default service name ("openllm")
const store = new KeychainSecretStore();

// Or with custom service name
const customStore = new KeychainSecretStore('my-app');

// Check if keychain is available on this system
if (store.isAvailable()) {
    await store.store('openai', 'sk-...');
    const key = await store.get('openai');
}
```

### ChainSecretStore

Combines multiple stores with fallback:

```typescript
import { ChainSecretStore, KeychainSecretStore, EnvSecretStore } from '@openllm/native';

const chain = new ChainSecretStore([
    new KeychainSecretStore(),
    new EnvSecretStore()
]);

// Returns first match from any store
const key = await chain.get('openai');

// Store goes to first writable store
await chain.store('openai', 'sk-...');
```

### Listing Available Stores

```typescript
import { listSecretStores } from '@openllm/native';

const stores = listSecretStores();
// Returns: [
//   { name: 'env', description: 'Environment variables', isPlugin: false },
//   { name: 'memory', description: 'In-memory store', isPlugin: false },
//   { name: 'keychain', description: 'System keychain', isPlugin: false }
// ]
```

## Configuration

### FileConfigProvider

YAML-based configuration:

```typescript
import { FileConfigProvider, ConfigLevel } from '@openllm/native';

// User-level config (~/.openllm/config.yaml)
const userConfig = FileConfigProvider.user();

// Workspace-level config (.openllm/config.yaml)
const workspaceConfig = FileConfigProvider.workspace('/path/to/project');

// Check if config file exists
console.log(userConfig.exists());  // true/false
console.log(userConfig.path);      // Full path to config file

// Get all providers
const providers = await userConfig.getProviders();
for (const p of providers) {
    console.log(`${p.name}: ${p.enabled ? 'enabled' : 'disabled'}`);
    console.log(`  Models: ${p.models.join(', ')}`);
}

// Add a provider
await userConfig.addProvider({
    name: 'openai',
    enabled: true,
    apiBase: undefined,
    models: ['gpt-4o', 'gpt-4o-mini']
});

// Update a provider
await userConfig.updateProvider('openai', {
    name: 'openai',
    enabled: true,
    apiBase: undefined,
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo']
});

// Remove a provider
await userConfig.removeProvider('openai');

// Backup config before major changes
const backupPath = userConfig.backup();

// Reload from disk
userConfig.reload();
```

### MemoryConfigProvider

In-memory configuration for testing:

```typescript
import { MemoryConfigProvider } from '@openllm/native';

const config = new MemoryConfigProvider();

await config.addProvider({
    name: 'openai',
    enabled: true,
    models: ['gpt-4o']
});

const providers = await config.getProviders();
```

### Import/Export

Convert between JSON and YAML:

```typescript
// Export to JSON (for VS Code settings migration)
const json = config.exportJson();

// Import from JSON
config.importJson('{"providers": [...]}');

// Import provider array directly
config.importProviders([
    { name: 'openai', enabled: true, models: ['gpt-4o'] },
    { name: 'anthropic', enabled: true, models: ['claude-3-5-sonnet-20241022'] }
]);
```

## Unified Resolvers

The unified resolvers combine multiple sources with priority-based resolution.

### UnifiedSecretResolver

```typescript
import { UnifiedSecretResolver } from '@openllm/native';

const resolver = new UnifiedSecretResolver();

// Resolve API key from any available source
const result = await resolver.resolve('openai');
if (result) {
    console.log(`Found key from: ${result.source}`);
    console.log(`Key: ${result.value}`);
}

// Store with auto-routing
const destination = await resolver.store('openai', 'sk-...', 'auto');
console.log(`Stored to: ${destination}`);  // 'vscode', 'keychain', etc.

// Store to specific destination
await resolver.store('anthropic', 'sk-ant-...', 'keychain');
```

### UnifiedConfigResolver

```typescript
import { UnifiedConfigResolver } from '@openllm/native';

const resolver = new UnifiedConfigResolver();

// Get all providers from all sources
const providers = await resolver.getAllProviders();

// Get providers at a specific scope
const userProviders = await resolver.getProvidersAtScope('user');
const workspaceProviders = await resolver.getProvidersAtScope('workspace');

// Save a provider
await resolver.saveProvider({
    name: 'openai',
    enabled: true,
    models: ['gpt-4o']
}, 'user');  // or 'workspace'

// Remove a provider
await resolver.removeProvider('openai', 'user');
```

## Types

### ChatMessage

```typescript
interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | ContentPart[];
    name?: string;           // For tool messages
    toolCallId?: string;     // For tool result messages
    toolCalls?: ToolCall[];  // For assistant messages with tool calls
}

interface ContentPart {
    type: 'text' | 'image';
    text?: string;
    imageUrl?: string;
}
```

### StreamChunk

```typescript
type StreamChunk = 
    | { type: 'text'; text: string }
    | { type: 'toolCall'; id: string; name: string; arguments: string }
    | { type: 'done' };
```

### ProviderMetadata

```typescript
interface ProviderMetadata {
    id: string;
    displayName: string;
    defaultApiBase: string;
    requiresApiKey: boolean;
    defaultModels: DefaultModel[];
}

interface DefaultModel {
    id: string;
    name: string;
    contextLength: number;
    capabilities: ModelCapabilities;
}

interface ModelCapabilities {
    imageInput: boolean;
    toolCalling: boolean;
    streaming: boolean;
}
```

### ProviderConfig

```typescript
interface ProviderConfig {
    name: string;
    enabled: boolean;
    apiBase?: string;
    models: string[];
}
```

### ResolvedProviderConfig

```typescript
interface ResolvedProviderConfig {
    name: string;
    enabled: boolean;
    apiBase?: string;
    models: string[];
    source: string;      // 'user', 'workspace', 'vscode'
    hasApiKey: boolean;  // Whether API key was found
}
```

## Error Handling

All async operations can throw errors. Handle them appropriately:

```typescript
try {
    await provider.streamChat(messages, config, options, callback);
} catch (error) {
    if (error.message.includes('API key')) {
        console.error('Missing or invalid API key');
    } else if (error.message.includes('rate limit')) {
        console.error('Rate limited, try again later');
    } else {
        console.error('Provider error:', error.message);
    }
}
```

## Best Practices

### 1. Use Unified Resolvers in Applications

For applications that need to work with multiple secret/config sources:

```typescript
// Good - uses unified resolution
const resolver = new UnifiedSecretResolver();
const key = await resolver.resolve('openai');

// Less flexible - hardcodes a single source
const env = new EnvSecretStore();
const key = await env.get('openai');
```

### 2. Prefer Provider ID Over Direct Instantiation

```typescript
// Good - provider ID is a string, easy to configure
const providerId = config.get('defaultProvider') || 'openai';
const provider = new LlmProvider(providerId);

// Also good - list supported providers for UI
const supported = supportedProviders();
```

### 3. Handle Streaming Errors in Callback

```typescript
await provider.streamChat(messages, config, options, (err, chunk) => {
    if (err) {
        // Handle error - don't throw from callback
        console.error('Stream error:', err);
        return;
    }
    // Process chunk...
});
```

### 4. Use Mock Provider for Tests

```typescript
// In tests, use mock provider instead of real providers
const provider = new LlmProvider('mock');

// Configure expected behavior via model name
await provider.streamChat(
    messages,
    { model: 'fixed:Expected response' },
    options,
    callback
);
```

## Platform Support

The NAPI bindings are built for:

| Platform | Architecture | Binary |
|----------|--------------|--------|
| Linux | x64 | `openllm.linux-x64-gnu.node` |
| Linux | arm64 | `openllm.linux-arm64-gnu.node` |
| macOS | x64 | `openllm.darwin-x64.node` |
| macOS | arm64 | `openllm.darwin-arm64.node` |
| Windows | x64 | `openllm.win32-x64-msvc.node` |

The appropriate binary is selected automatically at runtime based on the platform.
