# OpenLLM Protocol Buffers

This directory contains the gRPC service definition for the OpenLLM daemon.

## Structure

```
proto/
└── openllm/
    └── v1/
        └── service.proto    # Main service definition
```

## Generating Clients

### Rust (automatic)

The Rust server/client code is generated automatically by `tonic-build` when building the `openllm` crate:

```bash
cargo build -p openllm
```

Generated code is placed in `target/` and included via `tonic::include_proto!`.

### Python

Install grpcio-tools:

```bash
pip install grpcio-tools
```

Generate Python client:

```bash
python -m grpc_tools.protoc \
  -I proto \
  --python_out=packages/python/src/openllm \
  --grpc_python_out=packages/python/src/openllm \
  proto/openllm/v1/service.proto
```

Or use the generation script:

```bash
./proto/generate.sh python
```

### TypeScript/Node.js

Install ts-proto:

```bash
npm install -g ts-proto
```

Generate TypeScript client:

```bash
protoc \
  --plugin=./node_modules/.bin/protoc-gen-ts_proto \
  --ts_proto_out=packages/node/src/proto \
  --ts_proto_opt=outputServices=nice-grpc,outputServices=generic-definitions,useExactTypes=false \
  -I proto \
  proto/openllm/v1/service.proto
```

Or use the generation script:

```bash
./proto/generate.sh typescript
```

## Service Overview

The `OpenLLM` service provides:

- **Chat**: Stateless and session-based chat with LLM providers
- **Sessions**: Create, list, replay, fork, export/import sessions
- **Models & Providers**: List available models and provider status
- **Tools**: List and execute MCP tools
- **Configuration**: Get/update daemon configuration
- **Secrets**: Manage API keys and secrets
- **Lifecycle**: Register/unregister clients, shutdown daemon

See `service.proto` for the full API definition.
