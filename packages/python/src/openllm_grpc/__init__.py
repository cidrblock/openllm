"""OpenLLM gRPC Client for Python.

This module provides a Python client for communicating with the OpenLLM daemon
via gRPC over Unix Domain Sockets.

Daemon paths:
    Socket: ~/.openllm/openllm.sock
    PID file: ~/.openllm/openllm.pid

Example usage:

    from openllm_grpc import OpenLLMClient

    # Check if daemon is running
    if not OpenLLMClient.is_daemon_running():
        print("Start the daemon: openllm daemon start")
    
    async with OpenLLMClient() as client:
        # Chat with a model
        async for chunk in client.chat("openai/gpt-4o", "Hello!"):
            print(chunk.text, end="")
        
        # Create a session
        session = await client.create_session("openai/gpt-4o")
        
        # List sessions
        sessions = await client.list_sessions()
        for s in sessions:
            print(f"{s.id}: {s.topic}")
"""

from .client import (
    OpenLLMClient,
    OpenLLMError,
    ConnectionError,
    NotFoundError,
    ChatChunk,
    Session,
    Model,
)

__all__ = [
    "OpenLLMClient",
    "OpenLLMError",
    "ConnectionError",
    "NotFoundError",
    "ChatChunk",
    "Session",
    "Model",
]
__version__ = "0.1.0"
