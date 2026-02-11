//! MCP (Model Context Protocol) module
//!
//! Uses the official rmcp SDK to connect to MCP servers.
//! Provides unified access to secrets, config, and tools via MCP protocol.
//!
//! # Architecture
//!
//! The MCP module provides:
//! - `McpClient` - connects to MCP servers (VS Code extension)
//! - `McpSecretStore` - secret storage via MCP internal tools
//! - `McpConfigProvider` - config access via MCP internal tools
//!
//! # Example
//!
//! ```rust,ignore
//! use openllm_core::mcp::{McpClient, McpSecretStore, McpConfigProvider};
//! use std::sync::Arc;
//!
//! let logger: Arc<dyn Logger> = Arc::new(NoOpLogger::new());
//!
//! // Connect via Unix socket
//! let client = Arc::new(McpClient::connect_unix("/tmp/openllm-xxx.sock", logger).await?);
//!
//! // Create secret store and config provider
//! let secrets = McpSecretStore::new("vscode", client.clone());
//! let config = McpConfigProvider::new("vscode", client.clone());
//!
//! // Use them
//! let api_key = secrets.get_async("openai").await;
//! let providers = config.get_providers_async("user").await?;
//!
//! // List available tools for LLM
//! let tools = client.list_tools().await?;
//! let user_tools = filter_user_tools(tools);
//! ```

mod client;
mod secret_store;
mod config_provider;

pub use client::{McpClient, McpError, McpResult, is_internal_tool, filter_user_tools};
pub use secret_store::McpSecretStore;
pub use config_provider::{McpConfigProvider, McpConfigError, ProviderConfig};

// Re-export rmcp types that consumers might need
pub use rmcp::model::{Tool as McpTool, CallToolResult as McpToolResult};
