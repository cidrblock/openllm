#!/bin/bash
# Run all OpenLLM integration tests

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "═══════════════════════════════════════════════════════════════"
echo " OpenLLM Integration Tests"
echo "═══════════════════════════════════════════════════════════════"

# Track results
NODE_RESULT=0
PYTHON_RESULT=0

# -----------------------------------------------------------------------------
# Node.js Tests
# -----------------------------------------------------------------------------
echo ""
echo "┌─────────────────────────────────────────────────────────────┐"
echo "│ Node.js Tests                                               │"
echo "└─────────────────────────────────────────────────────────────┘"

cd "$SCRIPT_DIR/node"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing Node.js dependencies..."
    npm install --silent
fi

# Run tests
if npm test; then
    echo ""
    echo "✓ Node.js tests passed"
else
    NODE_RESULT=1
    echo ""
    echo "✗ Node.js tests failed"
fi

# -----------------------------------------------------------------------------
# Python Tests
# -----------------------------------------------------------------------------
echo ""
echo "┌─────────────────────────────────────────────────────────────┐"
echo "│ Python Tests                                                │"
echo "└─────────────────────────────────────────────────────────────┘"

cd "$SCRIPT_DIR/python"

# Run tests
if python test_secret_stores.py; then
    echo ""
    echo "✓ Python tests passed"
else
    PYTHON_RESULT=1
    echo ""
    echo "✗ Python tests failed"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Summary"
echo "═══════════════════════════════════════════════════════════════"

if [ $NODE_RESULT -eq 0 ] && [ $PYTHON_RESULT -eq 0 ]; then
    echo " ✓ All tests passed!"
    exit 0
else
    [ $NODE_RESULT -ne 0 ] && echo " ✗ Node.js tests failed"
    [ $PYTHON_RESULT -ne 0 ] && echo " ✗ Python tests failed"
    exit 1
fi
