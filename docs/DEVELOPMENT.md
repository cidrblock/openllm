# Development Guide

## Prerequisites

- **Rust** (stable, 1.75+)
- **Node.js** (20+) - For VS Code extension and proto generation
- **protoc** - Protocol buffer compiler
- **VS Code** (for extension development)

## Repository Structure

```
openllm/
├── Cargo.toml              # Rust workspace root
├── crates/
│   └── openllm/            # Main Rust daemon crate
│       ├── src/
│       │   ├── main.rs     # CLI entrypoint (daemon, web subcommands)
│       │   ├── server/     # gRPC server (tonic)
│       │   ├── providers/  # LLM providers (via genai crate)
│       │   ├── session/    # Session management
│       │   ├── secrets/    # Keychain integration
│       │   ├── resolver/   # Config & secret resolvers
│       │   └── web/        # Web dashboard (axum, embedded assets)
│       └── Cargo.toml
├── proto/
│   └── openllm/v1/
│       └── service.proto   # gRPC service definition
├── packages/
│   ├── grpc-client/        # Generated TypeScript gRPC stubs
│   ├── proto-ts/           # TypeScript proto types
│   ├── python/             # Python gRPC client
│   └── vscode/             # VS Code extension
├── scripts/
│   └── generate-clients.sh # Proto stub generation
└── docs/                   # Documentation
```

## Building

### Rust Daemon

```bash
# Build all Rust code
cargo build --release

# Run tests
cargo test

# Build only the daemon crate
cargo build --release -p openllm

# The binary is at target/release/openllm
```

### Running the Daemon

```bash
# Start the daemon (foreground)
./target/release/openllm daemon

# Start the web server (requires daemon running)
./target/release/openllm web

# Or run from cargo
cargo run --release -- daemon
cargo run --release -- web
```

### Proto Generation

```bash
# Generate TypeScript stubs
./scripts/generate-clients.sh typescript

# The stubs are output to packages/grpc-client/src/generated/
```

### VS Code Extension

```bash
cd packages/vscode

# Install dependencies
npm install

# Build TypeScript
npm run compile

# Package to VSIX
npm run package

# Install in VS Code
code --install-extension open-llm-provider-0.1.0.vsix
```

## Development Workflow

### 1. Making Daemon Changes

```bash
# Edit Rust code in crates/openllm/src/

# Build and test
cargo build --release && cargo test

# Kill any running daemon
pkill -9 openllm

# Remove stale socket
rm -f /run/user/$(id -u)/openllm/daemon.sock

# Restart daemon
./target/release/openllm daemon
```

### 2. Making Proto Changes

```bash
# Edit proto/openllm/v1/service.proto

# Regenerate TypeScript stubs
./scripts/generate-clients.sh typescript

# Copy to packages that need them
cp packages/grpc-client/src/generated/openllm/v1/service.ts packages/vscode/src/proto/openllm/v1/
cp packages/grpc-client/src/generated/openllm/v1/service.ts packages/proto-ts/src/openllm/v1/

# Rebuild the daemon (it generates Rust code from proto)
cargo build --release
```

### 3. VS Code Extension Development

1. Open `packages/vscode` in VS Code
2. Press **F5** to launch Extension Development Host
3. Make changes and reload window to test
4. Check Output panel → "Open LLM Provider" for logs

### 4. Web Dashboard Development

```bash
# Start daemon
./target/release/openllm daemon &

# Start web server
./target/release/openllm web

# Open http://localhost:8787

# Edit crates/openllm/src/web/static/index.html
# Rebuild and restart web server to see changes
cargo build --release
./target/release/openllm web
```

## Adding a New Provider

Providers are implemented using the `genai` crate. To add a new provider:

### 1. Check if genai supports it

The `genai` crate already supports many providers. Check if your provider is available.

### 2. Add to provider registry

Edit `crates/openllm/src/providers/mod.rs`:

```rust
// Add to BUILTIN_PROVIDERS list
static BUILTIN_PROVIDERS: &[BuiltinProvider] = &[
    // ... existing providers
    BuiltinProvider {
        id: "newprovider",
        display_name: "New Provider",
        default_api_base: "https://api.newprovider.com/v1",
        requires_api_key: true,
        default_key_env: "NEWPROVIDER_API_KEY",
    },
];
```

### 3. Add genai adapter type

If the provider needs a specific genai `AdapterKind`:

```rust
// In create_provider_client function
match provider_id {
    // ... existing cases
    "newprovider" => AdapterKind::NewProvider,  // if genai has it
    _ => AdapterKind::OpenAI,  // or use OpenAI-compatible if it works
}
```

### 4. Update web UI

Add any provider-specific hints or UI in `crates/openllm/src/web/static/index.html`.

## Adding a New gRPC RPC

### 1. Define in proto

Edit `proto/openllm/v1/service.proto`:

```protobuf
service OpenLLM {
    // ... existing RPCs
    
    rpc NewMethod(NewMethodRequest) returns (NewMethodResponse);
}

message NewMethodRequest {
    string field = 1;
}

message NewMethodResponse {
    string result = 1;
}
```

### 2. Regenerate stubs

```bash
./scripts/generate-clients.sh typescript
cargo build --release  # Regenerates Rust code
```

### 3. Implement in Rust

Edit `crates/openllm/src/server/grpc.rs`:

```rust
async fn new_method(
    &self,
    request: Request<NewMethodRequest>,
) -> Result<Response<NewMethodResponse>, Status> {
    let req = request.into_inner();
    
    // Implementation
    
    Ok(Response::new(NewMethodResponse {
        result: "done".to_string(),
    }))
}
```

## Testing

### Rust Tests

```bash
# All tests
cargo test

# Specific test
cargo test test_name

# With output
cargo test -- --nocapture
```

### VS Code Extension

Use F5 to launch the extension in development mode. Check:
- Output panel → "Open LLM Provider"
- Developer Tools Console (Help → Toggle Developer Tools)

### Web Dashboard

Open browser dev tools to check:
- Network tab for API calls
- Console for Alpine.js errors

## Debugging

### Daemon Logs

The daemon uses `tracing` for logging:

```bash
# Set log level
RUST_LOG=debug ./target/release/openllm daemon

# Or more specific
RUST_LOG=openllm=debug,tonic=info ./target/release/openllm daemon
```

### Check Daemon Socket

```bash
# See if socket exists
ls -la /run/user/$(id -u)/openllm/

# Check if daemon is listening
ss -xl | grep openllm
```

### VS Code Extension Logs

1. Open Output panel (View → Output)
2. Select "Open LLM Provider" from dropdown
3. Set `openLLM.logLevel` to `debug` in settings

### Web Server Issues

```bash
# Check if port is in use
lsof -i :8787

# Check daemon is running
pgrep -f "openllm daemon"
```

## Common Issues

### Socket Permission Denied

```bash
# Check socket permissions
ls -la /run/user/$(id -u)/openllm/daemon.sock

# Should be owned by your user with 0600 permissions
```

### Proto Mismatch

If TypeScript and Rust disagree on proto format:

```bash
# Clean and regenerate everything
rm -rf packages/grpc-client/src/generated/*
./scripts/generate-clients.sh typescript
cargo clean
cargo build --release
```

### Daemon Won't Start

```bash
# Kill any stale processes
pkill -9 openllm

# Remove stale socket
rm -f /run/user/$(id -u)/openllm/daemon.sock

# Check for port conflicts
lsof -i :8787

# Restart
./target/release/openllm daemon
```

### Extension Not Connecting

1. Ensure daemon is running
2. Check Output panel for connection errors
3. Reload VS Code window
4. Check socket path matches expected location

## Release Process

1. Update version in:
   - `crates/openllm/Cargo.toml`
   - `packages/vscode/package.json`

2. Build release binary:
   ```bash
   cargo build --release
   ```

3. Package VS Code extension:
   ```bash
   cd packages/vscode
   npm run package
   ```

4. Test the release:
   - Install VSIX
   - Start daemon
   - Verify all features work
