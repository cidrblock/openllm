//! MCP (Model Context Protocol) client module
//!
//! Uses the official rmcp SDK to connect to MCP servers.
//! Supports Unix socket and HTTP transports.
//!
//! # Example
//!
//! ```rust,ignore
//! use openllm_core::mcp::McpClient;
//! use std::sync::Arc;
//!
//! let logger: Arc<dyn Logger> = Arc::new(NoOpLogger::new());
//!
//! // Connect via Unix socket
//! let client = McpClient::connect_unix("/tmp/openllm-xxx.sock", logger).await?;
//!
//! // List available tools
//! let tools = client.list_tools().await?;
//!
//! // Filter to user-visible tools only
//! let user_tools = filter_user_tools(tools);
//!
//! // Call a tool
//! let result = client.call_tool("cursor_read_file", json!({
//!     "path": "/path/to/file"
//! })).await?;
//! ```

mod client;

pub use client::{McpClient, McpError, McpResult, is_internal_tool, filter_user_tools};

// Re-export rmcp types that consumers might need
pub use rmcp::model::{Tool as McpTool, CallToolResult as McpToolResult};
