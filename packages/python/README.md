# OpenLLM Python Client

A Python gRPC client for the OpenLLM daemon.

## Installation

```bash
pip install openllm-client
```

## Quick Start

```python
import asyncio
from openllm_grpc import OpenLLMClient

async def main():
    async with OpenLLMClient() as client:
        # Chat with a model
        async for chunk in client.chat("openai/gpt-4o", "Hello!"):
            if chunk.type == "text":
                print(chunk.text, end="")
        print()
        
        # List available models
        models = await client.list_models()
        for model in models:
            print(f"- {model.id} ({model.provider})")
        
        # Health check
        healthy = await client.health_check()
        print(f"Daemon healthy: {healthy}")

asyncio.run(main())
```

## Features

- **Chat**: Streaming chat with any configured model
- **Models**: List available models from all providers
- **Providers**: List and check provider status
- **Tools**: Execute MCP tools via high-performance gRPC
- **Secrets**: Manage API keys
- **Configuration**: Get/update daemon config

## Requirements

- Python 3.9+
- OpenLLM daemon running (`openllm daemon`)

## License

MIT
