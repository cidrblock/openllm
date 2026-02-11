"""
OpenLLM Daemon Client

Connects to the OpenLLM daemon via gRPC and provides a high-level API.
"""

import os
import sys
from pathlib import Path
from typing import Optional, List, Dict, Any, AsyncGenerator, Union
from datetime import datetime

from .types import (
    Message,
    ChatChunk,
    ChunkType,
    ChatOptions,
    SessionSummary,
    DaemonStatus,
    Model,
    Provider,
    Tool,
    Role,
)


def get_default_socket_path() -> str:
    """Get the default daemon socket path based on platform."""
    if sys.platform == "win32":
        return r"\\.\pipe\openllm-daemon"
    
    # Unix socket
    runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if not runtime_dir:
        runtime_dir = Path.home() / ".local" / "share"
    return str(Path(runtime_dir) / "openllm" / "daemon.sock")


class OpenLLMClient:
    """
    Client for connecting to the OpenLLM daemon.
    
    Example:
        async with OpenLLMClient() as client:
            async for chunk in client.chat("openai/gpt-4o", [Message(Role.USER, "Hello!")]):
                if chunk.type == ChunkType.TEXT:
                    print(chunk.text, end="")
    """
    
    def __init__(self, address: Optional[str] = None):
        """
        Create a new client.
        
        Args:
            address: Daemon address. Defaults to Unix socket on Linux/macOS.
        """
        self.address = address or get_default_socket_path()
        self._client_id: Optional[str] = None
        self._channel = None
    
    async def __aenter__(self) -> "OpenLLMClient":
        await self.connect()
        return self
    
    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.disconnect()
    
    def is_running(self) -> bool:
        """Check if the daemon is running."""
        if sys.platform != "win32" and self.address.startswith("/"):
            return Path(self.address).exists()
        # For TCP, would need to try connecting
        return False
    
    async def connect(self, client_type: str = "python") -> str:
        """
        Connect to the daemon and register as a client.
        
        Returns:
            The assigned client ID.
        """
        # TODO: Create actual gRPC connection using generated client
        self._client_id = f"client-{datetime.now().timestamp()}"
        print(f"Connected to daemon at {self.address}")
        return self._client_id
    
    async def disconnect(self) -> None:
        """Disconnect from the daemon."""
        if self._client_id:
            # TODO: Call Unregister RPC
            self._client_id = None
        if self._channel:
            self._channel.close()
            self._channel = None
    
    async def health_check(self) -> Dict[str, Any]:
        """
        Check daemon health.
        
        Returns:
            Dict with 'healthy' bool and 'version' string.
        """
        # TODO: Call HealthCheck RPC
        return {"healthy": True, "version": "0.1.0"}
    
    async def get_status(self) -> DaemonStatus:
        """Get daemon status."""
        # TODO: Call GetStatus RPC
        raise NotImplementedError("Waiting for proto generation")
    
    async def chat(
        self,
        model: str,
        messages: List[Message],
        options: Optional[ChatOptions] = None,
    ) -> AsyncGenerator[ChatChunk, None]:
        """
        Chat with a model (stateless).
        
        Args:
            model: Model ID (e.g., "openai/gpt-4o")
            messages: List of messages
            options: Optional chat options
            
        Yields:
            ChatChunk objects with response data.
        """
        # TODO: Call Chat RPC with streaming
        yield ChatChunk(
            type=ChunkType.TEXT,
            text=f"[Placeholder] Would chat with {model}",
        )
        yield ChatChunk(
            type=ChunkType.DONE,
            finish_reason="stop",
        )
    
    async def create_session(
        self,
        model: str,
        topic: Optional[str] = None,
    ) -> Dict[str, str]:
        """
        Create a new chat session.
        
        Returns:
            Dict with 'id', 'model', and 'topic'.
        """
        # TODO: Call CreateSession RPC
        return {
            "id": f"session-{datetime.now().timestamp()}",
            "model": model,
            "topic": topic or "",
        }
    
    async def list_sessions(
        self,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> List[SessionSummary]:
        """List all sessions."""
        # TODO: Call ListSessions RPC
        return []
    
    async def get_session(self, session_id: str) -> Dict[str, Any]:
        """Get a session by ID."""
        # TODO: Call GetSession RPC
        raise NotImplementedError("Waiting for proto generation")
    
    async def delete_session(self, session_id: str) -> None:
        """Delete a session."""
        # TODO: Call DeleteSession RPC
        pass
    
    async def session_chat(
        self,
        session_id: str,
        message: str,
        options: Optional[ChatOptions] = None,
    ) -> AsyncGenerator[ChatChunk, None]:
        """
        Chat within a session.
        
        Args:
            session_id: Session ID
            message: User message
            options: Optional chat options
            
        Yields:
            ChatChunk objects with response data.
        """
        # TODO: Call SessionChat RPC with streaming
        yield ChatChunk(
            type=ChunkType.TEXT,
            text=f"[Placeholder] Would chat in session {session_id}",
        )
        yield ChatChunk(
            type=ChunkType.DONE,
            finish_reason="stop",
        )
    
    async def replay_session(
        self,
        session_id: str,
        format: str = "condensed",
        max_messages: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Replay a session for context injection.
        
        Returns:
            Dict with 'content', 'message_count', and 'token_estimate'.
        """
        # TODO: Call ReplaySession RPC
        raise NotImplementedError("Waiting for proto generation")
    
    async def summarize_session(self, session_id: str) -> Dict[str, Any]:
        """
        Get AI-generated summary of a session.
        
        Returns:
            Dict with 'summary' and 'from_cache'.
        """
        # TODO: Call SummarizeSession RPC
        raise NotImplementedError("Waiting for proto generation")
    
    async def fork_session(
        self,
        session_id: str,
        new_model: Optional[str] = None,
        fork_point: Optional[int] = None,
    ) -> Dict[str, str]:
        """
        Fork a session.
        
        Returns:
            Dict with 'id' and 'forked_from'.
        """
        # TODO: Call ForkSession RPC
        raise NotImplementedError("Waiting for proto generation")
    
    async def export_session(self, session_id: str) -> str:
        """Export a session as JSON."""
        # TODO: Call ExportSession RPC
        raise NotImplementedError("Waiting for proto generation")
    
    async def import_session(
        self,
        json_content: str,
        generate_new_id: bool = False,
    ) -> Dict[str, str]:
        """
        Import a session from JSON.
        
        Returns:
            Dict with 'id'.
        """
        # TODO: Call ImportSession RPC
        raise NotImplementedError("Waiting for proto generation")
    
    async def list_models(
        self,
        provider_filter: Optional[str] = None,
    ) -> List[Model]:
        """List available models."""
        # TODO: Call ListModels RPC
        return []
    
    async def list_providers(self) -> List[Provider]:
        """List configured providers."""
        # TODO: Call ListProviders RPC
        return []
    
    async def list_tools(
        self,
        server_filter: Optional[str] = None,
    ) -> List[Tool]:
        """List available tools."""
        # TODO: Call ListTools RPC
        return []
    
    async def execute_tool(
        self,
        name: str,
        arguments: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Execute a tool.
        
        Returns:
            Dict with 'content' and 'is_error'.
        """
        # TODO: Call ExecuteTool RPC
        raise NotImplementedError("Waiting for proto generation")
    
    async def get_secret(self, key: str) -> Optional[str]:
        """Get a secret."""
        # TODO: Call GetSecret RPC
        return None
    
    async def set_secret(
        self,
        key: str,
        value: str,
        store: str = "keychain",
    ) -> None:
        """Set a secret."""
        # TODO: Call SetSecret RPC
        pass


async def create_client(address: Optional[str] = None) -> OpenLLMClient:
    """
    Create a client connected to the daemon.
    
    Example:
        client = await create_client()
        # Use client...
        await client.disconnect()
    """
    client = OpenLLMClient(address)
    await client.connect()
    return client
