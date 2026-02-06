//! OpenLLM Core
//!
//! Runtime-agnostic LLM provider abstractions.
//! This crate provides the core functionality that can be used from any environment
//! (Node.js via napi-rs, Python via PyO3, native CLI, etc.)
//!
//! ## Tool Orchestration
//!
//! The `tools` module provides MCP-compatible tool management:
//! - Discover tools from VS Code or other MCP servers
//! - Filter tools (internal vs user-visible, enabled/disabled)
//! - Execute tools and return results to LLM
//!
//! ```rust,ignore
//! use openllm_core::tools::{ToolRegistry, ToolFilter};
//!
//! let registry = ToolRegistry::new(Some(rpc_client), logger);
//! registry.refresh().await?;
//!
//! // Get tools for LLM
//! let tools = registry.get_llm_tools();
//!
//! // Execute tool calls from LLM response
//! let results = registry.execute_tool_calls(&tool_calls).await;
//! ```

pub mod types;
pub mod secrets;
pub mod logging;
pub mod config;
pub mod providers;
pub mod rpc;
pub mod resolver;
pub mod tools;
pub mod mcp;

// Re-export commonly used types
pub use types::{
    ChatMessage, ContentPart, MessageRole, MessageContent,
    ModelConfig, ModelCapabilities, ProviderConfig, ProviderMetadata,
    Tool, ToolCall, ToolResult, ToolChoice,
    StreamChunk,
    CancellationToken,
};

pub use secrets::{
    SecretStore, SecretInfo, SecretStoreError, SecretStoreResult,
    EnvSecretStore, MemorySecretStore, ChainSecretStore,
    register_secret_store, create_secret_store, list_secret_stores,
};

pub use logging::{Logger, NoOpLogger, ConsoleLogger};

pub use config::{ConfigProvider, MemoryConfigProvider};

pub use rpc::{
    RpcClient, RpcEndpoint, RpcEndpointRegistry,
    RpcSecretStore, RpcConfigProvider,
    register_rpc_endpoint, get_rpc_endpoint,
    // Legacy MCP types (use mcp module for official SDK types)
    McpTool as RpcMcpTool, McpToolResult as RpcMcpToolResult, McpToolContent,
};

pub use resolver::{
    UnifiedSecretResolver, ResolvedSecret,
    UnifiedConfigResolver, ResolvedConfig, ResolvedProvider,
};

pub use tools::{ToolRegistry, ToolFilter, ToolInfo};

// MCP client using official rmcp SDK
pub use mcp::{McpClient, McpError, McpResult, McpTool, McpToolResult, is_internal_tool, filter_user_tools};
