//! MCP Client using the official rmcp SDK
//!
//! Connects to MCP servers over Unix socket or HTTP.

use std::path::Path;
use std::sync::Arc;

use rmcp::{
    ServiceExt,
    model::{CallToolRequestParams, CallToolResult, ClientCapabilities, ClientInfo, Implementation, Tool},
    service::RunningService,
    RoleClient,
};
use serde_json::Value;
use thiserror::Error;

#[cfg(unix)]
use tokio::net::UnixStream;

use crate::logging::Logger;

/// MCP client errors
#[derive(Error, Debug)]
pub enum McpError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("Initialization failed: {0}")]
    InitializationFailed(String),

    #[error("Tool call failed: {0}")]
    ToolCallFailed(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Protocol error: {0}")]
    Protocol(String),
}

pub type McpResult<T> = Result<T, McpError>;

/// MCP client for connecting to VS Code extension or other MCP servers
pub struct McpClient {
    /// The underlying rmcp running service
    client: RunningService<RoleClient, ClientInfo>,
    /// Logger
    logger: Arc<dyn Logger>,
}

impl McpClient {
    /// Connect to an MCP server over a Unix socket
    #[cfg(unix)]
    pub async fn connect_unix<P: AsRef<Path>>(
        socket_path: P,
        logger: Arc<dyn Logger>,
    ) -> McpResult<Self> {
        let path = socket_path.as_ref();
        logger.info(&format!("[McpClient] Connecting to Unix socket: {:?}", path));

        let stream = UnixStream::connect(path)
            .await
            .map_err(|e| McpError::ConnectionFailed(e.to_string()))?;

        let client_info = ClientInfo {
            meta: None,
            protocol_version: Default::default(),
            capabilities: ClientCapabilities::default(),
            client_info: Implementation {
                name: "openllm-core".to_string(),
                title: Some("OpenLLM Core".to_string()),
                version: env!("CARGO_PKG_VERSION").to_string(),
                website_url: None,
                icons: None,
            },
        };

        let client = client_info
            .serve(stream)
            .await
            .map_err(|e| McpError::InitializationFailed(e.to_string()))?;

        logger.info("[McpClient] Connected and initialized successfully");

        Ok(Self { client, logger })
    }

    /// Connect to an MCP server over HTTP (Streamable HTTP transport)
    pub async fn connect_http(
        url: &str,
        logger: Arc<dyn Logger>,
    ) -> McpResult<Self> {
        use rmcp::transport::StreamableHttpClientTransport;

        logger.info(&format!("[McpClient] Connecting to HTTP: {}", url));

        let transport = StreamableHttpClientTransport::from_uri(url);

        let client_info = ClientInfo {
            meta: None,
            protocol_version: Default::default(),
            capabilities: ClientCapabilities::default(),
            client_info: Implementation {
                name: "openllm-core".to_string(),
                title: Some("OpenLLM Core".to_string()),
                version: env!("CARGO_PKG_VERSION").to_string(),
                website_url: None,
                icons: None,
            },
        };

        let client = client_info
            .serve(transport)
            .await
            .map_err(|e| McpError::InitializationFailed(e.to_string()))?;

        logger.info("[McpClient] Connected and initialized successfully");

        Ok(Self { client, logger })
    }

    /// List all available tools
    pub async fn list_tools(&self) -> McpResult<Vec<Tool>> {
        let result = self
            .client
            .list_tools(Default::default())
            .await
            .map_err(|e| McpError::Protocol(e.to_string()))?;

        self.logger.info(&format!(
            "[McpClient] Listed {} tools",
            result.tools.len()
        ));

        Ok(result.tools)
    }

    /// Call a tool by name
    pub async fn call_tool(&self, name: &str, arguments: Value) -> McpResult<CallToolResult> {
        self.logger.info(&format!("[McpClient] Calling tool: {}", name));

        let params = CallToolRequestParams {
            meta: None,
            name: name.to_owned().into(),
            arguments: arguments.as_object().cloned(),
            task: None,
        };

        let result = self
            .client
            .call_tool(params)
            .await
            .map_err(|e| McpError::ToolCallFailed(e.to_string()))?;

        Ok(result)
    }

    /// Get server info
    pub fn server_info(&self) -> Option<&Implementation> {
        self.client.peer_info().map(|info| &info.server_info)
    }

    /// Close the connection
    pub async fn close(self) -> McpResult<()> {
        self.logger.info("[McpClient] Closing connection");
        self.client
            .cancel()
            .await
            .map_err(|e| McpError::Protocol(e.to_string()))?;
        Ok(())
    }
}

/// Check if a tool name is internal (hidden from LLM)
pub fn is_internal_tool(name: &str) -> bool {
    name.starts_with("openllm_")
}

/// Filter tools to only user-visible ones
pub fn filter_user_tools(tools: Vec<Tool>) -> Vec<Tool> {
    tools.into_iter().filter(|t| !is_internal_tool(&t.name)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_internal_tool() {
        assert!(is_internal_tool("openllm_secrets_get"));
        assert!(is_internal_tool("openllm_config_set"));
        assert!(!is_internal_tool("cursor_read_file"));
        assert!(!is_internal_tool("some_tool"));
    }
}
