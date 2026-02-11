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
        
        # List sessions
        sessions = await client.list_sessions()
        for session in sessions:
            print(f"- {session.id}: {session.topic}")
        
        # Create a session
        session = await client.create_session("openai/gpt-4o", topic="My chat")
        print(f"Created session: {session.id}")
        
        # Export session for sharing
        json_data = await client.export_session(session.id)
        print(json_data)

asyncio.run(main())
```

## Features

- **Chat**: Streaming chat with any configured model
- **Sessions**: Create, list, replay, fork, export/import sessions
- **Models**: List available models from all providers
- **Tools**: Execute MCP tools via high-performance gRPC

## Session Continuity

Export a session from one environment, share with a colleague:

```python
# Export from VS Code session
json_data = await client.export_session("sess-abc123")

# Save to file or share via git
with open("debugging-session.json", "w") as f:
    f.write(json_data)
```

Import and continue in Python:

```python
with open("debugging-session.json") as f:
    session = await client.import_session(f.read())

# Continue the conversation
async for chunk in client.session_chat(session.id, "What was the issue?"):
    print(chunk.text, end="")
```

## Requirements

- Python 3.9+
- OpenLLM daemon running (`openllm` command)

## License

MIT
