# OpenLLM Integration Tests

Integration tests for the OpenLLM Rust core library with Node.js and Python bindings.

## Prerequisites

### Build the native modules first

```bash
# From repository root

# Build Rust crates
cargo build --release

# Copy Node.js native module
cp target/release/libopenllm_napi.so crates/openllm-napi/npm/openllm.linux-x64-gnu.node

# Build and install Python module
python3 -m venv .venv
source .venv/bin/activate
pip install maturin
cd crates/openllm-python && maturin develop --release
```

## Running Tests

### All Tests

```bash
./tests/run_all.sh
```

### Node.js Tests

```bash
cd tests/node
npm install
node test_secret_stores.js
node test_mock_provider.js
```

### Python Tests

```bash
source .venv/bin/activate

# With pytest (recommended)
pytest tests/python/test_secret_stores.py -v

# Or run directly
python tests/python/test_secret_stores.py
```

## Test Coverage

### Secret Stores

- **EnvSecretStore**: Environment variable reading
- **MemorySecretStore**: In-memory CRUD operations
- **KeychainSecretStore**: System keychain (skipped if unavailable)
- **ChainSecretStore**: Fallback chain behavior

### Configuration

- **FileConfigProvider**: YAML file reading/writing
- **ProviderConfig**: Provider configuration management
- **Import/Export**: JSON ↔ YAML conversion

### Providers

- **Provider Metadata**: Listing and provider info
- **Message Types**: ChatMessage, Tool, ToolCall, ToolResult
- **MockProvider**: Testing streaming without network calls
  - Echo mode: Echoes back user messages
  - Fixed mode: Returns predetermined responses
  - Chunked mode: Returns specific chunks with delays
  - Error mode: Simulates API errors

### Chat Types

- **ChatMessage**: System, user, assistant messages
- **MessageRole**: Role enum behavior
- **ModelConfig**: Model configuration

## Test Files

```
tests/
├── node/
│   ├── package.json
│   ├── test_secret_stores.js    # 45 tests
│   └── test_mock_provider.js    # 5 tests (MockProvider streaming)
├── python/
│   └── test_secret_stores.py    # 41 tests
├── run_all.sh
└── README.md
```

## Adding New Tests

### Node.js

```javascript
await test('my new test', async () => {
    const result = await someFunction();
    assertEqual(result, expected);
});
```

### Python

```python
class TestMyFeature:
    def test_something(self):
        result = some_function()
        assert result == expected
```
