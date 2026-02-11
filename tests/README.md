# OpenLLM Tests

## Test Structure

This project follows the "hybrid" test layout:

- **Unit tests** live co-located with the source code (`src/**/*.test.ts`)
- **Integration tests** live in a separate `tests/` folder inside each package

```
packages/daemon/
├── src/
│   └── providers/
│       ├── mock.ts
│       └── mock.test.ts              ← Unit test (co-located)
├── tests/
│   └── integration/
│       ├── grpc-streaming.test.ts    ← Integration (real gRPC server/client)
│       ├── web-sse.test.ts           ← Integration (real Express + HTTP)
│       └── helpers/
│           └── mock-daemon.ts        ← Shared mock gRPC server
├── vitest.config.ts
└── package.json
```

## Running Tests

```bash
# Run all daemon tests (unit + integration)
cd packages/daemon
npm test

# Run with verbose output
npx vitest run --reporter verbose

# Run only unit tests
npx vitest run src/

# Run only integration tests
npx vitest run tests/

# Watch mode
npx vitest
```

## Test Layers

### Layer 1: Unit Tests (co-located)

Pure unit tests with no I/O, no network, no processes.

| File | Tests | What it covers |
|------|-------|----------------|
| `src/providers/mock.test.ts` | 24 | Mock provider: echo, fixed, error, empty, slow modes |

### Layer 2: Integration Tests

Tests that start real servers, make real HTTP/gRPC calls.

| File | Tests | What it covers |
|------|-------|----------------|
| `tests/integration/grpc-streaming.test.ts` | 13 | gRPC unary RPCs + streaming + cancellation + concurrency |
| `tests/integration/web-sse.test.ts` | 16 | Web API endpoints + SSE chat streaming + errors + disconnect |

### Mock Provider

The `mock` provider (`mock/echo`, `mock/fixed`, `mock/error`, etc.) is a real provider
registered in the adapter. No API keys or network needed. Use it for end-to-end testing:

```bash
# Chat with the mock provider
curl -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model":"mock/echo","messages":[{"role":"user","content":"Hello!"}]}'
```

## Legacy Tests

The `legacy-rust-napi/` folder contains tests from the original Rust NAPI architecture.
These are preserved for reference but are not runnable against the TypeScript daemon.
