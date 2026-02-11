# Development Guide

## Prerequisites

- **Node.js** (20+)
- **npm**
- **protoc** - Protocol buffer compiler (for client generation)
- **VS Code** (for extension development)

## Repository Structure

```
openllm/
├── packages/
│   ├── daemon/              # TypeScript daemon
│   │   ├── src/             # Source code
│   │   ├── static/          # Web dashboard HTML
│   │   ├── tests/           # Integration tests
│   │   └── vitest.config.ts
│   ├── python/              # Python gRPC client
│   └── vscode/              # VS Code extension
├── proto/                   # gRPC service definition
├── tests/                   # Test docs
└── docs/
```

## Building

```bash
cd packages/daemon
npm install
npm run build   # TypeScript compilation
npm test        # vitest (53 tests)
```

## Running

```bash
node dist/index.js daemon         # Start daemon
node dist/index.js web            # Start web dashboard
node dist/index.js status         # Check status
node dist/index.js stop           # Stop daemon
```

## Development Workflow

### 1. Making Daemon Changes

Edit `src/`, rebuild, restart:

```bash
cd packages/daemon
npm run build
# Kill any running daemon
pkill -f "node dist/index.js daemon"
# Restart
node dist/index.js daemon
```

### 2. Making Proto Changes

1. Edit `proto/openllm/v1/service.proto`
2. Regenerate TypeScript stubs for VS Code:
   ```bash
   cd proto
   ./generate.sh
   # Or manually with protoc (see proto/README.md)
   ```
3. The daemon uses `@grpc/proto-loader` for dynamic loading and does not need stub regeneration

### 3. VS Code Extension

1. Open `packages/vscode` in VS Code
2. Press **F5** to launch Extension Development Host
3. Check Output panel → "Open LLM Provider" for logs

### 4. Web Dashboard

1. Edit `packages/daemon/static/index.html`
2. Restart the web server to see changes
3. Start daemon + web: `node dist/index.js web` (or start daemon first, then web)

## Adding a New Provider

Edit `packages/daemon/src/providers/adapter.ts`:

- Add to **PROVIDER_ENGINE_MAP** – maps OpenLLM provider ID to multi-llm-ts engine name
- Add to **PROVIDER_DISPLAY_NAMES** – human-readable name
- Add to **NO_KEY_PROVIDERS** (as a `Set`) if the provider does not require an API key
- Add to **DEFAULT_ENV_VARS** – default environment variable name for the API key

Example:

```typescript
const PROVIDER_ENGINE_MAP: Record<string, string> = {
  // ... existing
  newprovider: 'newprovider',
};

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  // ... existing
  newprovider: 'New Provider',
};

const NO_KEY_PROVIDERS = new Set(['mock', 'ollama', 'lmstudio']);  // add if no key needed

const DEFAULT_ENV_VARS: Record<string, string> = {
  // ... existing
  newprovider: 'NEWPROVIDER_API_KEY',
};
```

## Adding a New gRPC RPC

1. **Define in proto** – Edit `proto/openllm/v1/service.proto`:
   ```protobuf
   rpc NewMethod(NewMethodRequest) returns (NewMethodResponse);
   message NewMethodRequest { string field = 1; }
   message NewMethodResponse { string result = 1; }
   ```

2. **Regenerate stubs** – Run `proto/generate.sh` (or equivalent) for the VS Code extension

3. **Implement handler** – Edit `packages/daemon/src/server/openllm-service.ts`:
   ```typescript
   NewMethod(
     call: grpc.ServerUnaryCall<any, any>,
     callback: grpc.sendUnaryData<any>
   ): void {
     const req = call.request;
     callback(null, { result: 'done' });
   }
   ```

## Testing

- **Unit tests** – vitest, co-located with source (`src/**/*.test.ts`)
- **Integration tests** – `tests/integration/*.test.ts`
- **Mock provider** – Use `mock/echo`, `mock/fixed`, `mock/error` for testing without network or API keys

```bash
cd packages/daemon
npm test                    # All tests
npx vitest run src/         # Unit tests only
npx vitest run tests/       # Integration tests only
```

## Debugging

- **Daemon logs** – Console output from the daemon process
- **Socket check** – `ls -la /run/user/$(id -u)/openllm/`
- **VS Code logs** – Output panel → "Open LLM Provider"

## Common Issues

### Socket Permission Denied

```bash
ls -la /run/user/$(id -u)/openllm/daemon.sock
# Should be owned by your user with appropriate permissions
```

### Daemon Won't Start

```bash
# Kill any stale processes
pkill -f "node dist/index.js daemon"

# Remove stale socket
rm -f /run/user/$(id -u)/openllm/daemon.sock

# Check for port conflicts
lsof -i :8787

# Restart
node dist/index.js daemon
```

### Proto Mismatch

If TypeScript clients and daemon disagree on proto format:

```bash
# Regenerate VS Code stubs
cd proto && ./generate.sh

# Rebuild daemon (uses dynamic loading, no regeneration needed)
cd packages/daemon && npm run build
```

### Extension Not Connecting

1. Ensure daemon is running: `node dist/index.js status`
2. Check Output panel for connection errors
3. Reload VS Code window
4. Verify socket path matches expected location
