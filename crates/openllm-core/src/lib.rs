//! OpenLLM Core
//!
//! Runtime-agnostic LLM provider abstractions.
//! This crate provides the core functionality that can be used from any environment
//! (Node.js via napi-rs, Python via PyO3, native CLI, etc.)
//!
//! ## MCP Integration
//!
//! Communication with VS Code (and other hosts) uses the Model Context Protocol (MCP):
//! - `McpClient` - connects to MCP servers
//! - `McpSecretStore` - secret storage via MCP
//! - `McpConfigProvider` - config access via MCP
//!
//! ## Tool Orchestration
//!
//! The `tools` module provides MCP-based tool management:
//! - Discover tools from VS Code or other MCP servers
//! - Filter tools (internal vs user-visible, enabled/disabled)
//! - Execute tools and return results to LLM
//!
//! ```rust,ignore
//! use openllm_core::{McpClient, McpSecretStore, McpConfigProvider, ToolRegistry};
//! use std::sync::Arc;
//!
//! // Connect to MCP server
//! let client = Arc::new(McpClient::connect_unix("/tmp/socket.sock", logger).await?);
//!
//! // Create secret store and config provider
//! let secrets = McpSecretStore::new("vscode", client.clone());
//! let config = McpConfigProvider::new("vscode", client.clone());
//!
//! // Tool registry for LLM tool calling
//! let registry = ToolRegistry::with_client(client.clone(), logger);
//! registry.refresh().await?;
//! let tools = registry.get_llm_tools();
//! ```

pub mod types;
pub mod secrets;
pub mod logging;
pub mod config;
pub mod providers;
pub mod resolver;
pub mod tools;
pub mod mcp;

// Re-export commonly used types
pub use types::{
    ChatMessage, ContentPart, MessageRole, MessageContent,
    ModelConfig, ModelCapabilities, ProviderConfig, ProviderMetadata, DefaultModel, ConfigSource,
    Tool, ToolCall, ToolResult, ToolChoice,
    StreamChunk, PromptOption,
    CancellationToken,
};

pub use secrets::{
    SecretStore, SecretInfo, SecretStoreError, SecretStoreResult,
    EnvSecretStore, MemorySecretStore, ChainSecretStore,
    register_secret_store, create_secret_store, list_secret_stores,
};

pub use logging::{Logger, NoOpLogger, ConsoleLogger};

pub use config::{ConfigProvider, MemoryConfigProvider};

pub use resolver::{
    UnifiedSecretResolver, ResolvedSecret,
    UnifiedConfigResolver, ResolvedConfig, ResolvedProvider,
};

pub use tools::{
    ToolRegistry, ToolFilter, ToolInfo,
    ChatOrchestrator, OrchestratorConfig,
    UserPromptResponse, PromptResponseReceiver, PromptResponseSender,
};

// MCP - Model Context Protocol (official rmcp SDK)
pub use mcp::{
    McpClient, McpError, McpResult,
    McpSecretStore, McpConfigProvider, McpConfigError,
    McpTool, McpToolResult,
    is_internal_tool, filter_user_tools,
    ProviderConfig as McpProviderConfig,
};
