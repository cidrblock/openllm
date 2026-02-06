# Development Guide

## Prerequisites

- **Rust** (stable, 1.70+)
- **Node.js** (20+)
- **Python** (3.9+) with virtual environment
- **VS Code** (for extension development)

## Repository Structure

```
openllm/
├── Cargo.toml              # Rust workspace root
├── crates/
│   ├── openllm-core/       # Rust core library
│   ├── openllm-napi/       # Node.js bindings (NAPI-rs)
│   └── openllm-python/     # Python bindings (PyO3)
├── packages/
│   ├── core/               # TypeScript types (legacy, being deprecated)
│   └── vscode/             # VS Code extension
├── tests/
│   ├── node/               # Node.js integration tests
│   └── python/             # Python integration tests
└── docs/                   # Documentation
```

## Building

### Rust Core

```bash
# Build all Rust crates
cargo build --release

# Run Rust tests
cargo test

# Build with all warnings
cargo build --release 2>&1 | head -50
```

### Node.js Bindings

```bash
# Build NAPI bindings
cargo build --release -p openllm-napi

# Copy to npm package
cp target/release/libopenllm_napi.so crates/openllm-napi/npm/openllm.linux-x64-gnu.node

# Test from Node.js
cd tests/node && node test_secret_stores.js
```

### Python Bindings

```bash
# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install maturin (build tool for PyO3)
pip install maturin

# Build and install Python package
cd crates/openllm-python
maturin develop --release

# Test from Python
cd ../../tests/python
pytest test_secret_stores.py -v
```

### VS Code Extension

```bash
cd packages/vscode

# Install dependencies
npm install

# Build TypeScript
npm run compile

# Package to VSIX (requires Node 20+)
npx vsce package --allow-missing-repository
```

## Development Workflow

### 1. Making Rust Changes

```bash
# Edit Rust code in crates/openllm-core/src/

# Build and test
cargo build --release && cargo test

# Rebuild bindings
cargo build --release -p openllm-napi -p openllm-python

# Copy Node.js binary
cp target/release/libopenllm_napi.so crates/openllm-napi/npm/openllm.linux-x64-gnu.node

# Rebuild Python
source .venv/bin/activate
cd crates/openllm-python && maturin develop --release
```

### 2. Testing Node.js

```bash
cd tests/node
node test_secret_stores.js
```

### 3. Testing Python

```bash
source .venv/bin/activate
cd tests/python
pytest -v
```

### 4. VS Code Extension Development

1. Open `packages/vscode` in VS Code
2. Press **F5** to launch Extension Development Host
3. Make changes and reload window to test

## Adding a New Provider

### 1. Implement in Rust Core

Create `crates/openllm-core/src/providers/newprovider.rs`:

```rust
use super::traits::{Provider, ProviderMetadata};
use crate::types::*;

pub struct NewProvider {
    logger: Arc<dyn Logger>,
}

impl NewProvider {
    pub fn new(logger: Arc<dyn Logger>) -> Self {
        Self { logger }
    }
}

impl Provider for NewProvider {
    fn metadata(&self) -> ProviderMetadata {
        ProviderMetadata {
            id: "newprovider".to_string(),
            display_name: "New Provider".to_string(),
            default_api_base: "https://api.newprovider.com".to_string(),
            requires_api_key: true,
        }
    }

    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderModelConfig,
        options: StreamOptions,
        token: Arc<dyn CancellationToken>,
    ) -> Result<BoxStream<'static, StreamChunk>, ProviderError> {
        // Implementation
    }
}
```

### 2. Export from mod.rs

```rust
// crates/openllm-core/src/providers/mod.rs
mod newprovider;
pub use newprovider::NewProvider;
```

### 3. Add to Node.js Bindings

```rust
// crates/openllm-napi/src/lib.rs
use openllm_core::providers::NewProvider as CoreNewProvider;

#[napi]
pub struct NewProvider { /* ... */ }
```

### 4. Add to Python Bindings

```rust
// crates/openllm-python/src/lib.rs
use openllm_core::providers::NewProvider as CoreNewProvider;

#[pyclass]
pub struct NewProvider { /* ... */ }
```

### 5. Update VS Code Extension

Add to `packages/vscode/src/registry/ProviderRegistry.ts`.

## Adding a New Secret Store

### 1. Implement in Rust

Create `crates/openllm-core/src/secrets/newstore.rs`:

```rust
use super::traits::{SecretStore, SecretInfo};

pub struct NewSecretStore {
    // fields
}

impl SecretStore for NewSecretStore {
    fn name(&self) -> &str { "newstore" }
    fn is_available(&self) -> bool { true }
    fn get(&self, key: &str) -> Option<String> { /* ... */ }
    fn store(&self, key: &str, value: &str) -> Result<(), Box<dyn Error>> { /* ... */ }
    fn delete(&self, key: &str) -> Result<(), Box<dyn Error>> { /* ... */ }
    fn has(&self, key: &str) -> bool { /* ... */ }
    fn get_info(&self, key: &str) -> SecretInfo { /* ... */ }
}
```

### 2. Register in Registry

```rust
// crates/openllm-core/src/secrets/registry.rs
registry.insert("newstore", ("Description", false));
```

### 3. Add to Bindings

Follow same pattern as providers.

## Testing

### Running All Tests

```bash
# Rust tests
cargo test

# Node.js tests
cd tests/node && node test_secret_stores.js

# Python tests
source .venv/bin/activate
pytest tests/python/ -v
```

### VS Code Extension Tests

Tests are in `packages/vscode/src/adapters/__tests__/`:
- `MessageConverter.test.ts`
- `VSCodeCancellationTokenAdapter.test.ts`
- `VSCodeProviderAdapter.test.ts`
- `ProviderIntegration.test.ts`

## Debugging

### Rust

```bash
# With debug symbols
cargo build

# Run with RUST_BACKTRACE
RUST_BACKTRACE=1 cargo test
```

### Node.js Bindings

```bash
# Check if binding loads
node -e "console.log(require('@openllm/native'))"
```

### Python Bindings

```bash
source .venv/bin/activate
python -c "import openllm; print(dir(openllm))"
```

### VS Code Extension

1. Open Output panel → "Open LLM Provider"
2. Set `openLLM.logLevel` to `"debug"` in settings
3. Check Developer Tools Console (Help → Toggle Developer Tools)

## Common Issues

### NAPI Build Fails

```bash
# Ensure you have the right target
rustup target add x86_64-unknown-linux-gnu

# Clean and rebuild
cargo clean
cargo build --release -p openllm-napi
```

### Python Import Error

```bash
# Ensure you're in the right venv
which python  # Should be .venv/bin/python

# Rebuild
cd crates/openllm-python
maturin develop --release
```

### VS Code Extension Not Loading

1. Check that `@openllm/native` resolves:
   ```bash
   cd packages/vscode
   node -e "console.log(require.resolve('@openllm/native'))"
   ```

2. Ensure the `.node` binary exists and matches your platform

### Keychain Store Not Working

The keychain store requires:
- macOS: Keychain Access
- Linux: `libsecret` (Secret Service API)
- Windows: Credential Manager

On Linux, install:
```bash
sudo apt install libsecret-1-dev
```

## Release Process

1. Update version in:
   - `Cargo.toml` (workspace version)
   - `packages/vscode/package.json`
   - `crates/openllm-napi/npm/package.json`

2. Build all bindings for target platforms

3. Test all bindings

4. Package VS Code extension:
   ```bash
   cd packages/vscode
   npx vsce package
   ```

5. Publish Python package:
   ```bash
   cd crates/openllm-python
   maturin publish
   ```
