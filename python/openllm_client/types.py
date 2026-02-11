"""
OpenLLM Client Types

These types will be replaced by generated protobuf types once the proto is compiled.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional, List, Dict, Any, Literal
from enum import Enum


class Role(str, Enum):
    """Message role"""
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


@dataclass
class ToolCall:
    """A tool call in a message"""
    id: str
    name: str
    arguments: str


@dataclass
class Message:
    """A chat message"""
    role: Role
    content: str
    tool_calls: Optional[List[ToolCall]] = None
    tool_call_id: Optional[str] = None
    name: Optional[str] = None


@dataclass
class ChatOptions:
    """Options for chat requests"""
    temperature: Optional[float] = None
    max_tokens: Optional[int] = None
    top_p: Optional[float] = None
    stop: Optional[List[str]] = None
    enable_tools: bool = False
    max_tool_iterations: int = 10
    tool_filter: Optional[List[str]] = None


class ChunkType(str, Enum):
    """Type of chat chunk"""
    TEXT = "text"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    PROMPT = "prompt"
    USAGE = "usage"
    ERROR = "error"
    DONE = "done"


@dataclass
class ChatChunk:
    """A chunk of streaming chat response"""
    type: ChunkType
    text: Optional[str] = None
    tool_call: Optional[ToolCall] = None
    tool_result: Optional[Dict[str, Any]] = None
    prompt: Optional[Dict[str, Any]] = None
    usage: Optional[Dict[str, int]] = None
    error: Optional[Dict[str, str]] = None
    finish_reason: Optional[str] = None


@dataclass
class SessionSummary:
    """Summary of a chat session"""
    id: str
    model: str
    topic: str
    message_count: int
    source: str
    created_at: datetime
    updated_at: datetime


@dataclass
class ConnectedClient:
    """Information about a connected client"""
    client_id: str
    client_type: str
    connected_at: datetime
    is_spawner: bool


@dataclass
class DaemonStatus:
    """Status of the OpenLLM daemon"""
    version: str
    started_at: datetime
    connected_clients: int
    active_sessions: int
    clients: List[ConnectedClient] = field(default_factory=list)
    registered_mcp_servers: List[str] = field(default_factory=list)


@dataclass
class Model:
    """An available model"""
    id: str
    provider: str
    name: str
    display_name: str
    supports_streaming: bool
    supports_tools: bool
    supports_vision: bool
    context_window: Optional[int] = None
    source: Literal["direct", "vscode_lm"] = "direct"


@dataclass
class Provider:
    """A configured provider"""
    id: str
    display_name: str
    configured: bool
    healthy: bool
    provider_type: Literal["http", "mcp", "local"]


@dataclass
class Tool:
    """An available tool"""
    name: str
    description: str
    input_schema: str
    server: str
