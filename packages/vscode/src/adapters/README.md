# VS Code Adapters

This directory contains adapter classes that bridge VS Code-specific types to the gRPC daemon.

## Overview

The OpenLLM daemon provides a gRPC API. The VS Code extension communicates with it via gRPC and exposes models through VS Code's Language Model API. The adapters in this directory handle the conversion between VS Code types and gRPC message formats.

## Architecture

```
VS Code Extension (packages/vscode)
├── extension.ts                    # Entry point
├── daemon/
│   ├── client.ts                   # gRPC client to daemon
│   └── backchannel.ts              # Bidirectional stream for workspace info
├── providers/
│   └── OpenLLMLanguageModelProvider.ts  # Implements vscode.LanguageModelChatProvider
└── adapters/                       # Type conversions
    ├── MessageConverter.ts         # VS Code ↔ gRPC message conversion
    ├── VSCodeCancellationTokenAdapter.ts
    └── VSCodeLoggerAdapter.ts

openllm daemon (TypeScript)
└── gRPC server on Unix socket
```

## Adapters

### MessageConverter

Converts VS Code message format to gRPC proto message format and vice versa.

**VS Code → gRPC:**
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
  ]
}

// Converted to gRPC ChatMessage
{
  role: 'user',
  content: [
    { type: 'text', text: "Hello" }
  ]
}
```

### VSCodeCancellationTokenAdapter

Bridges VS Code's cancellation token to core's interface.

**Key differences:**
- VS Code: `token.onCancellationRequested(() => {})` returns `Disposable`
- Core: `token.onCancellationRequested(() => {})` returns `void`

The adapter manages the disposable internally and provides a consistent interface.

### VSCodeLoggerAdapter

Wraps VS Code's `OutputChannel` to implement a common `ILogger` interface.

**Usage:**
```typescript
const channel = vscode.window.createOutputChannel('Open LLM Provider');
const logger = new VSCodeLoggerAdapter(channel);

// Use as ILogger
logger.info('Connected to daemon');
logger.error('Connection failed', error);
```

## Benefits of Adapter Pattern

1. **Separation of Concerns**: gRPC types stay separate from VS Code types
2. **Testability**: Easy to test adapters in isolation
3. **Maintainability**: Changes to VS Code API don't affect daemon communication
4. **Type Safety**: Clear conversion boundaries between type systems
