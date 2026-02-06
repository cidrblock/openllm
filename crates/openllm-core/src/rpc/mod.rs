//! RPC module for external integrations
//!
//! This module provides JSON-RPC client functionality for communicating with
//! external secret and config providers (like VS Code extensions).
//!
//! The RPC protocol uses:
//! - Unix sockets (or named pipes on Windows)
//! - JSON-RPC 2.0 with Content-Length headers (LSP-style)
//! - Authentication tokens for security
//!
//! ## MCP Tool Support
//!
//! This module also provides MCP (Model Context Protocol) compatible tool
//! functionality via `tools/list` and `tools/call` RPC methods:
//!
//! - **Internal tools** (`openllm_*` prefix): Used by openllm-core for
//!   secrets/config management, hidden from LLM
//! - **User tools**: VS Code tools (vscode.lm.tools) proxied to the LLM
//!
//! ```rust,ignore
//! // List all user-visible tools
//! let tools = client.list_user_tools_async().await?;
//!
//! // Call a tool
//! let result = client.call_tool_async("cursor_read_file", json!({
//!     "path": "/path/to/file"
//! })).await?;
//! ```

mod client;
pub mod endpoint;
mod rpc_secret_store;
mod rpc_config_provider;

pub use client::{RpcClient, RpcError, RpcResult};
pub use client::{McpTool, McpToolResult, McpToolContent, INTERNAL_TOOL_PREFIX};
pub use endpoint::{RpcEndpoint, RpcEndpointRegistry, register_rpc_endpoint, get_rpc_endpoint};
pub use rpc_secret_store::RpcSecretStore;
pub use rpc_config_provider::RpcConfigProvider;
