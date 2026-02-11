#!/bin/bash
# Generate gRPC clients from proto definitions

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PROTO_DIR="$ROOT_DIR/proto"

echo "=== OpenLLM Client Generator ==="
echo "Proto dir: $PROTO_DIR"

# Check for protoc
if ! command -v protoc &> /dev/null; then
    echo "Error: protoc not found. Install protobuf-compiler."
    exit 1
fi

echo "protoc version: $(protoc --version)"

# Generate TypeScript client
generate_typescript() {
    echo ""
    echo "=== Generating TypeScript client ==="
    
    local OUT_DIR="$ROOT_DIR/packages/grpc-client/src/generated"
    mkdir -p "$OUT_DIR"
    
    # Check for ts-proto
    if [ -f "$ROOT_DIR/node_modules/.bin/protoc-gen-ts_proto" ]; then
        protoc \
            --plugin="protoc-gen-ts_proto=$ROOT_DIR/node_modules/.bin/protoc-gen-ts_proto" \
            --ts_proto_out="$OUT_DIR" \
            --ts_proto_opt=outputServices=nice-grpc,outputServices=generic-definitions,useExactTypes=false,esModuleInterop=true \
            -I "$PROTO_DIR" \
            "$PROTO_DIR/openllm/v1/service.proto"
        echo "TypeScript client generated at: $OUT_DIR"
    else
        echo "ts-proto not found. Install with: npm install ts-proto"
        echo "Skipping TypeScript generation."
    fi
}

# Generate Python client
generate_python() {
    echo ""
    echo "=== Generating Python client ==="
    
    local OUT_DIR="$ROOT_DIR/python/openllm_client/generated"
    mkdir -p "$OUT_DIR"
    touch "$OUT_DIR/__init__.py"
    
    # Check for grpcio-tools
    if python3 -c "import grpc_tools" 2>/dev/null; then
        python3 -m grpc_tools.protoc \
            -I "$PROTO_DIR" \
            --python_out="$OUT_DIR" \
            --pyi_out="$OUT_DIR" \
            --grpc_python_out="$OUT_DIR" \
            "$PROTO_DIR/openllm/v1/service.proto"
        
        # Fix imports in generated files
        sed -i 's/^import openllm/from . import openllm/' "$OUT_DIR"/*.py 2>/dev/null || true
        
        echo "Python client generated at: $OUT_DIR"
    else
        echo "grpcio-tools not found. Install with: pip install grpcio-tools"
        echo "Skipping Python generation."
    fi
}

# Parse arguments
case "${1:-all}" in
    typescript|ts)
        generate_typescript
        ;;
    python|py)
        generate_python
        ;;
    all)
        generate_typescript
        generate_python
        ;;
    *)
        echo "Usage: $0 [typescript|python|all]"
        exit 1
        ;;
esac

echo ""
echo "=== Done ==="
