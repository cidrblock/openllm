"""
OpenLLM Daemon Client

A Python client for connecting to the OpenLLM daemon via gRPC.
"""

from .client import OpenLLMClient, create_client
from .types import (
    Message,
    ChatChunk,
    ChatOptions,
    SessionSummary,
    DaemonStatus,
)

__version__ = "0.1.0"

__all__ = [
    "OpenLLMClient",
    "create_client",
    "Message",
    "ChatChunk",
    "ChatOptions",
    "SessionSummary",
    "DaemonStatus",
]
