# VS Code Adapters

This directory contains adapter classes that bridge VS Code-specific types to the Rust core library via Node.js bindings.

## Overview

The Rust core (`openllm-core`) is designed to work in any environment via language bindings. The VS Code extension accesses it through NAPI-rs Node.js bindings (`@openllm/native`).

The adapters in this directory bridge VS Code's native types to the core library.

## Architecture

```
VS Code Extension (packages/vscode)
├── extension.ts
├── core/OpenLLMProvider.ts        # Implements vscode.LanguageModelChatProvider
├── registry/ProviderRegistry.ts   # Creates provider instances
└── adapters/                      # Bridge between VS Code and native
    ├── NativeProviderAdapter.ts   # Wraps native providers
    ├── MessageConverter.ts        # Converts VS Code → Core messages
    ├── VSCodeCancellationTokenAdapter.ts
    └── VSCodeLoggerAdapter.ts

@openllm/native (crates/openllm-napi)
└── Rust bindings for providers, secrets, config
```

## Adapters

### MessageConverter

Converts VS Code message format to core message format.

**VS Code Message Parts:**
- `vscode.LanguageModelTextPart` → `ContentPart` with `type: 'text'`
- `vscode.LanguageModelToolCallPart` → `ContentPart` with `type: 'tool_use'`
- `vscode.LanguageModelToolResultPart` → `ContentPart` with `type: 'tool_result'`

**Example:**
```typescript
// VS Code message
{
  role: vscode.LanguageModelChatMessageRole.User,
  content: [
    new vscode.LanguageModelTextPart("Hello"),
    new vscode.LanguageModelToolResultPart(callId, [
      new vscode.LanguageModelTextPart("Result")
    ])
  ]
}

// Converted to core message
{
  role: 'user',
  content: [
    { type: 'text', text: "Hello" },
    { type: 'tool_result', tool_use_id: callId, content: "Result" }
  ]
}
```

### VSCodeCancellationTokenAdapter

Bridges VS Code's cancellation token to core's interface.

**Key differences:**
- VS Code: `token.onCancellationRequested(() => {})` returns `Disposable`
- Core: `token.onCancellationRequested(() => {})` returns `void`

The adapter manages the disposable internally and provides the core interface.

### VSCodeLoggerAdapter

Wraps VS Code's `OutputChannel` to implement core's `ILogger` interface.

**Usage:**
```typescript
const channel = vscode.window.createOutputChannel('My Extension');
const logger = new VSCodeLoggerAdapter(channel);

// Use as ILogger
logger.info('Hello');
logger.error('Error', someObject);
```

## Benefits of Adapter Pattern

1. **Separation of Concerns**: Core library is runtime-agnostic
2. **Reusability**: Rust core works in Python, Node.js, and VS Code
3. **Testability**: Easy to test adapters in isolation
4. **Maintainability**: Changes to VS Code API don't affect core
5. **Performance**: Native Rust performance via bindings
