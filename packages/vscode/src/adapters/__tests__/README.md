# Adapter Tests

Unit tests for the VS Code adapter layer that bridges VS Code types to core types.

## Test Files

- **`MessageConverter.test.ts`** - Tests message conversion from VS Code to core format
  - Simple text messages
  - Tool calls and results
  - Structured content
  - Multiple messages

- **`VSCodeCancellationTokenAdapter.test.ts`** - Tests cancellation token bridging
  - Cancellation propagation
  - Multiple listeners
  - Already-cancelled tokens
  - State management

- **`VSCodeProviderAdapter.test.ts`** - Tests the main provider adapter
  - Message conversion integration
  - Model config simplification
  - Options pass-through
  - Stream delegation

- **`ProviderIntegration.test.ts`** - Integration tests for all providers
  - Verifies all 7 providers can be wrapped
  - Ensures consistent interface
  - Tests provider instantiation

## Running Tests

### From VS Code
1. Open `packages/vscode` in VS Code
2. Press F5 to launch Extension Development Host
3. Run tests from the test view or command palette

### From Command Line
```bash
cd packages/vscode
npm test
```

### Watch Mode
```bash
cd packages/vscode
npm run watch
```

## Test Coverage

The tests verify:

✅ **Message Conversion**
- Text-only messages
- Messages with tool calls
- Messages with tool results
- Mixed content (text + tools)
- Empty content handling

✅ **Cancellation Tokens**
- Status propagation
- Listener registration
- Multiple listeners
- Pre-cancelled tokens

✅ **Provider Adapter**
- End-to-end message flow
- Type conversions
- Options forwarding
- Stream pass-through

✅ **Provider Integration**
- All 7 providers wrap correctly
- Consistent interface
- Proper inheritance

## Adding New Tests

When adding new adapter functionality:

1. Add test cases to existing test file if related
2. Create new test file for new adapters
3. Follow existing naming pattern: `*.test.ts`
4. Use `describe` and `it` blocks
5. Include both success and edge cases

## Mock Objects

Tests use mock implementations to avoid dependencies:
- `MockVSCodeToken` - Simulates `vscode.CancellationToken`
- `MockCoreProvider` - Simulates core provider behavior

These mocks allow testing adapter logic in isolation without requiring actual VS Code or LLM API calls.

## Future Tests

Potential additions:
- [ ] VSCodeLoggerAdapter tests
- [ ] Error handling tests
- [ ] Performance tests
- [ ] Real API integration tests (with mocked responses)
- [ ] Tool calling round-trip tests
