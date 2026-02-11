# OpenLLM Python Client

Python client for the OpenLLM daemon.

## Installation

```bash
pip install openllm-client
```

## Quick Start

```python
import asyncio
from openllm_client import OpenLLMClient, Message, Role

async def main():
    async with OpenLLMClient() as client:
        # Simple chat
        async for chunk in client.chat(
            "openai/gpt-4o",
            [Message(Role.USER, "Hello, world!")]
        ):
            if chunk.text:
                print(chunk.text, end="")
        print()
        
        # Create a session for persistent chat
        session = await client.create_session("openai/gpt-4o", topic="My project")
        print(f"Created session: {session['id']}")
        
        # Chat in session
        async for chunk in client.session_chat(session["id"], "Help me with my code"):
            if chunk.text:
                print(chunk.text, end="")
        print()
        
        # List all sessions
        sessions = await client.list_sessions()
        for s in sessions:
            print(f"- {s.id}: {s.topic} ({s.message_count} messages)")

asyncio.run(main())
```

## Session Continuity

Continue a session started in another tool (VS Code, CLI, etc.):

```python
async with OpenLLMClient() as client:
    # List recent sessions
    sessions = await client.list_sessions(limit=5)
    
    # Find the session you want
    for s in sessions:
        print(f"{s.id}: {s.topic} ({s.source})")
    
    # Replay for context (use with a different model)
    replay = await client.replay_session(sessions[0].id, format="condensed")
    print(f"Context: {replay['content'][:500]}...")
    
    # Or fork the session to continue with a different model
    forked = await client.fork_session(
        sessions[0].id,
        new_model="anthropic/claude-3-5-sonnet"
    )
    print(f"Forked to: {forked['id']}")
```

## Sharing Sessions

Export and import sessions between team members:

```python
async with OpenLLMClient() as client:
    # Export a session
    json_data = await client.export_session("sess-abc123")
    
    # Save to file
    with open("debugging-session.json", "w") as f:
        f.write(json_data)
    
    # Import a colleague's session
    with open("shared-session.json") as f:
        imported = await client.import_session(f.read())
    print(f"Imported session: {imported['id']}")
```

## Requirements

- OpenLLM daemon running (`./target/release/openllm daemon`)
- Python 3.9+

## Development

```bash
# Install with dev dependencies
pip install -e ".[dev]"

# Generate proto
python -m grpc_tools.protoc \
    -I ../proto \
    --python_out=./openllm_client/generated \
    --grpc_python_out=./openllm_client/generated \
    ../proto/openllm/v1/service.proto
```
