//! JSON-RPC client for communicating with external providers
//!
//! Uses the LSP-style protocol with Content-Length headers over Unix sockets.
//! 
//! Provides both sync and async APIs:
//! - Sync: For CLI and Python (blocking is fine)
//! - Async: For Node.js (must not block the event loop)

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::net::UnixStream;

#[cfg(windows)]
use std::fs::OpenOptions;
#[cfg(windows)]
use std::io::{Read as IoRead};

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader as TokioBufReader};

/// Errors that can occur during RPC operations
#[derive(Error, Debug)]
pub enum RpcError {
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("RPC error {code}: {message}")]
    RpcError { code: i64, message: String },

    #[error("Invalid response: {0}")]
    InvalidResponse(String),

    #[error("Timeout")]
    Timeout,

    #[error("Not connected")]
    NotConnected,
}

pub type RpcResult<T> = Result<T, RpcError>;

/// JSON-RPC client
pub struct RpcClient {
    socket_path: String,
    auth_token: String,
    request_id: AtomicU64,
}

impl RpcClient {
    /// Create a new RPC client
    pub fn new(socket_path: impl Into<String>, auth_token: impl Into<String>) -> Self {
        Self {
            socket_path: socket_path.into(),
            auth_token: auth_token.into(),
            request_id: AtomicU64::new(0),
        }
    }

    /// Make a JSON-RPC request
    pub fn call<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> RpcResult<R> {
        let id = self.request_id.fetch_add(1, Ordering::SeqCst);
        
        // Add auth token to params
        let params_value = serde_json::to_value(params)?;
        let params_with_auth = match params_value {
            Value::Object(mut map) => {
                map.insert("auth".to_string(), json!(self.auth_token));
                Value::Object(map)
            }
            Value::Null => {
                json!({ "auth": self.auth_token })
            }
            _ => {
                // If params is not an object, wrap it
                json!({ "auth": self.auth_token, "data": params_value })
            }
        };

        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params_with_auth,
        });

        let response = self.send_request(&request)?;
        self.parse_response(response)
    }

    /// Send a request and receive a response
    #[cfg(unix)]
    fn send_request(&self, request: &Value) -> RpcResult<Value> {
        use std::time::Duration;
        use crate::logging;
        
        logging::debug("rpc::client", &format!("Connecting to socket: {}", self.socket_path));
        
        let stream = UnixStream::connect(&self.socket_path)
            .map_err(|e| {
                logging::error("rpc::client", &format!("Connection failed: {}", e));
                RpcError::ConnectionFailed(e.to_string())
            })?;
        
        logging::debug("rpc::client", "Connected successfully");
        
        // Set timeouts to prevent blocking the extension host
        // Increased from 500ms to 5000ms to handle slower operations
        let timeout = Some(Duration::from_millis(5000));
        stream.set_read_timeout(timeout).ok();
        stream.set_write_timeout(timeout).ok();
        
        self.do_request(stream, request)
    }

    #[cfg(windows)]
    fn send_request(&self, request: &Value) -> RpcResult<Value> {
        // On Windows, use named pipes
        // Named pipes in Windows can be opened like files
        let mut stream = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&self.socket_path)
            .map_err(|e| RpcError::ConnectionFailed(e.to_string()))?;
        
        self.do_request_windows(&mut stream, request)
    }

    #[cfg(unix)]
    fn do_request(&self, mut stream: UnixStream, request: &Value) -> RpcResult<Value> {
        use crate::logging;
        
        // Write request with Content-Length header
        let content = serde_json::to_string(request)?;
        let message = format!("Content-Length: {}\r\n\r\n{}", content.len(), content);
        
        // Extract method for logging (hide sensitive data like auth tokens)
        let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("unknown");
        logging::debug("rpc::client", &format!("Sending request: method={}, content_length={}", method, content.len()));
        
        stream.write_all(message.as_bytes()).map_err(|e| {
            logging::error("rpc::client", &format!("Write failed: {}", e));
            RpcError::Io(e)
        })?;
        
        stream.flush().map_err(|e| {
            logging::error("rpc::client", &format!("Flush failed: {}", e));
            RpcError::Io(e)
        })?;
        
        logging::debug("rpc::client", "Request sent, waiting for response...");

        // Read response
        let mut reader = BufReader::new(stream);
        let result = self.read_response(&mut reader);
        
        match &result {
            Ok(_) => logging::debug("rpc::client", "Response received successfully"),
            Err(e) => logging::error("rpc::client", &format!("Response read failed: {}", e)),
        }
        
        result
    }

    #[cfg(windows)]
    fn do_request_windows<S: IoRead + Write>(&self, stream: &mut S, request: &Value) -> RpcResult<Value> {
        // Write request with Content-Length header
        let content = serde_json::to_string(request)?;
        let message = format!("Content-Length: {}\r\n\r\n{}", content.len(), content);
        stream.write_all(message.as_bytes())?;
        stream.flush()?;

        // Read response
        let mut reader = BufReader::new(stream);
        self.read_response(&mut reader)
    }

    fn read_response<R: BufRead>(&self, reader: &mut R) -> RpcResult<Value> {
        // Read headers until we find Content-Length
        let mut content_length: Option<usize> = None;
        let mut line = String::new();

        loop {
            line.clear();
            let bytes_read = reader.read_line(&mut line)?;
            if bytes_read == 0 {
                return Err(RpcError::InvalidResponse("Connection closed".to_string()));
            }

            let line = line.trim();
            if line.is_empty() {
                // End of headers
                break;
            }

            if let Some(len_str) = line.strip_prefix("Content-Length:") {
                content_length = Some(
                    len_str
                        .trim()
                        .parse()
                        .map_err(|_| RpcError::InvalidResponse("Invalid Content-Length".to_string()))?,
                );
            }
        }

        let length = content_length
            .ok_or_else(|| RpcError::InvalidResponse("Missing Content-Length header".to_string()))?;

        // Read the content
        let mut content = vec![0u8; length];
        reader.read_exact(&mut content)?;

        let response: Value = serde_json::from_slice(&content)?;
        Ok(response)
    }

    fn parse_response<R: DeserializeOwned>(&self, response: Value) -> RpcResult<R> {
        // Check for error
        if let Some(error) = response.get("error") {
            let code = error.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
            let message = error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("Unknown error")
                .to_string();
            return Err(RpcError::RpcError { code, message });
        }

        // Extract result
        let result = response
            .get("result")
            .ok_or_else(|| RpcError::InvalidResponse("Missing result field".to_string()))?;

        serde_json::from_value(result.clone()).map_err(|e| e.into())
    }

    /// Check if the endpoint is reachable
    pub fn ping(&self) -> RpcResult<bool> {
        // Fast-fail: check if socket file exists first
        if !Path::new(&self.socket_path).exists() {
            return Err(RpcError::ConnectionFailed("Socket does not exist".to_string()));
        }
        
        #[derive(serde::Deserialize)]
        struct PingResult {
            ok: bool,
        }

        // Ping doesn't need auth for basic connectivity check
        let request = json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "lifecycle/ping",
            "params": {}
        });

        let response = self.send_request(&request)?;
        let result: PingResult = self.parse_response(response)?;
        Ok(result.ok)
    }
    
    // ==================== ASYNC API ====================
    // These methods don't block the calling thread, suitable for Node.js
    
    /// Make an async JSON-RPC request (non-blocking)
    pub async fn call_async<P: Serialize, R: DeserializeOwned>(
        &self,
        method: &str,
        params: P,
    ) -> RpcResult<R> {
        let id = self.request_id.fetch_add(1, Ordering::SeqCst);
        
        // Add auth token to params
        let params_value = serde_json::to_value(params)?;
        let params_with_auth = match params_value {
            Value::Object(mut map) => {
                map.insert("auth".to_string(), json!(self.auth_token));
                Value::Object(map)
            }
            Value::Null => {
                json!({ "auth": self.auth_token })
            }
            _ => {
                json!({ "auth": self.auth_token, "data": params_value })
            }
        };

        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params_with_auth,
        });

        let response = self.send_request_async(&request).await?;
        self.parse_response(response)
    }
    
    /// Send a request asynchronously (Unix)
    #[cfg(unix)]
    async fn send_request_async(&self, request: &Value) -> RpcResult<Value> {
        use tokio::net::UnixStream as TokioUnixStream;
        
        let stream = TokioUnixStream::connect(&self.socket_path)
            .await
            .map_err(|e| RpcError::ConnectionFailed(e.to_string()))?;
        
        self.do_request_async(stream, request).await
    }
    
    /// Send a request asynchronously (Windows - placeholder)
    #[cfg(windows)]
    async fn send_request_async(&self, request: &Value) -> RpcResult<Value> {
        // For now, fall back to sync on Windows
        // TODO: Implement async named pipe support
        tokio::task::spawn_blocking({
            let socket_path = self.socket_path.clone();
            let request = request.clone();
            move || {
                let mut stream = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&socket_path)
                    .map_err(|e| RpcError::ConnectionFailed(e.to_string()))?;
                
                let content = serde_json::to_string(&request)?;
                let message = format!("Content-Length: {}\r\n\r\n{}", content.len(), content);
                stream.write_all(message.as_bytes())?;
                stream.flush()?;
                
                let mut reader = BufReader::new(stream);
                // Inline read_response logic here since we can't call self
                let mut content_length: Option<usize> = None;
                let mut line = String::new();
                loop {
                    line.clear();
                    let bytes_read = reader.read_line(&mut line)?;
                    if bytes_read == 0 {
                        return Err(RpcError::InvalidResponse("Connection closed".to_string()));
                    }
                    let trimmed = line.trim();
                    if trimmed.is_empty() { break; }
                    if let Some(len_str) = trimmed.strip_prefix("Content-Length:") {
                        content_length = Some(len_str.trim().parse()
                            .map_err(|_| RpcError::InvalidResponse("Invalid Content-Length".to_string()))?);
                    }
                }
                let length = content_length
                    .ok_or_else(|| RpcError::InvalidResponse("Missing Content-Length".to_string()))?;
                let mut content = vec![0u8; length];
                std::io::Read::read_exact(&mut reader, &mut content)?;
                Ok(serde_json::from_slice(&content)?)
            }
        }).await.map_err(|e| RpcError::Io(std::io::Error::new(std::io::ErrorKind::Other, e)))?
    }
    
    #[cfg(unix)]
    async fn do_request_async(
        &self,
        mut stream: tokio::net::UnixStream,
        request: &Value,
    ) -> RpcResult<Value> {
        // Write request with Content-Length header
        let content = serde_json::to_string(request)?;
        let message = format!("Content-Length: {}\r\n\r\n{}", content.len(), content);
        stream.write_all(message.as_bytes()).await?;
        stream.flush().await?;

        // Read response
        let mut reader = TokioBufReader::new(stream);
        self.read_response_async(&mut reader).await
    }
    
    async fn read_response_async<R: tokio::io::AsyncBufRead + Unpin>(
        &self,
        reader: &mut R,
    ) -> RpcResult<Value> {
        let mut content_length: Option<usize> = None;
        let mut line = String::new();

        loop {
            line.clear();
            let bytes_read = reader.read_line(&mut line).await?;
            if bytes_read == 0 {
                return Err(RpcError::InvalidResponse("Connection closed".to_string()));
            }

            let trimmed = line.trim();
            if trimmed.is_empty() {
                break;
            }

            if let Some(len_str) = trimmed.strip_prefix("Content-Length:") {
                content_length = Some(
                    len_str
                        .trim()
                        .parse()
                        .map_err(|_| RpcError::InvalidResponse("Invalid Content-Length".to_string()))?,
                );
            }
        }

        let length = content_length
            .ok_or_else(|| RpcError::InvalidResponse("Missing Content-Length header".to_string()))?;

        let mut content = vec![0u8; length];
        reader.read_exact(&mut content).await?;

        let response: Value = serde_json::from_slice(&content)?;
        Ok(response)
    }
    
    /// Async ping check
    pub async fn ping_async(&self) -> RpcResult<bool> {
        if !Path::new(&self.socket_path).exists() {
            return Err(RpcError::ConnectionFailed("Socket does not exist".to_string()));
        }
        
        #[derive(serde::Deserialize)]
        struct PingResult {
            ok: bool,
        }

        let request = json!({
            "jsonrpc": "2.0",
            "id": 0,
            "method": "lifecycle/ping",
            "params": {}
        });

        let response = self.send_request_async(&request).await?;
        let result: PingResult = self.parse_response(response)?;
        Ok(result.ok)
    }
}

// ==================== MCP TOOL TYPES ====================

/// MCP tool definition
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
    /// If true, this tool is internal and should not be sent to the LLM
    #[serde(default, rename = "_internal")]
    pub internal: bool,
}

/// MCP tool call result
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct McpToolResult {
    pub content: Vec<McpToolContent>,
    #[serde(default, rename = "isError")]
    pub is_error: bool,
}

/// MCP tool content part
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type")]
pub enum McpToolContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "error")]
    Error { text: String },
}

impl McpToolResult {
    /// Extract text content as a string
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|c| match c {
                McpToolContent::Text { text } => Some(text.as_str()),
                McpToolContent::Error { text } => Some(text.as_str()),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    
    /// Parse text content as JSON
    pub fn parse_json<T: DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_str(&self.text())
    }
}

/// Prefix for internal tools (hidden from LLM)
pub const INTERNAL_TOOL_PREFIX: &str = "openllm_";

impl RpcClient {
    // ==================== MCP TOOL API ====================
    
    /// List all available tools (MCP tools/list)
    ///
    /// # Arguments
    /// * `include_internal` - If true, include internal openllm_* tools
    pub fn list_tools(&self, include_internal: bool) -> RpcResult<Vec<McpTool>> {
        #[derive(serde::Serialize)]
        struct Params {
            #[serde(rename = "includeInternal")]
            include_internal: bool,
        }
        
        #[derive(serde::Deserialize)]
        struct Response {
            tools: Vec<McpTool>,
        }
        
        let result: Response = self.call("tools/list", Params { include_internal })?;
        Ok(result.tools)
    }
    
    /// List tools asynchronously
    pub async fn list_tools_async(&self, include_internal: bool) -> RpcResult<Vec<McpTool>> {
        #[derive(serde::Serialize)]
        struct Params {
            #[serde(rename = "includeInternal")]
            include_internal: bool,
        }
        
        #[derive(serde::Deserialize)]
        struct Response {
            tools: Vec<McpTool>,
        }
        
        let result: Response = self.call_async("tools/list", Params { include_internal }).await?;
        Ok(result.tools)
    }
    
    /// Call a tool (MCP tools/call)
    ///
    /// # Arguments
    /// * `name` - Tool name
    /// * `arguments` - Tool arguments as JSON
    pub fn call_tool(&self, name: &str, arguments: serde_json::Value) -> RpcResult<McpToolResult> {
        #[derive(serde::Serialize)]
        struct Params {
            name: String,
            arguments: serde_json::Value,
        }
        
        self.call("tools/call", Params { 
            name: name.to_string(), 
            arguments 
        })
    }
    
    /// Call a tool asynchronously
    pub async fn call_tool_async(&self, name: &str, arguments: serde_json::Value) -> RpcResult<McpToolResult> {
        #[derive(serde::Serialize)]
        struct Params {
            name: String,
            arguments: serde_json::Value,
        }
        
        self.call_async("tools/call", Params { 
            name: name.to_string(), 
            arguments 
        }).await
    }
    
    /// Get user-visible tools only (for sending to LLM)
    pub fn list_user_tools(&self) -> RpcResult<Vec<McpTool>> {
        let all_tools = self.list_tools(false)?;
        Ok(all_tools.into_iter().filter(|t| !t.internal).collect())
    }
    
    /// Get user-visible tools asynchronously
    pub async fn list_user_tools_async(&self) -> RpcResult<Vec<McpTool>> {
        let all_tools = self.list_tools_async(false).await?;
        Ok(all_tools.into_iter().filter(|t| !t.internal).collect())
    }
    
    /// Check if a tool is internal
    pub fn is_internal_tool(name: &str) -> bool {
        name.starts_with(INTERNAL_TOOL_PREFIX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation() {
        let client = RpcClient::new("/tmp/test.sock", "token123");
        assert_eq!(client.socket_path, "/tmp/test.sock");
        assert_eq!(client.auth_token, "token123");
    }
    
    #[test]
    fn test_is_internal_tool() {
        assert!(RpcClient::is_internal_tool("openllm_secrets_get"));
        assert!(RpcClient::is_internal_tool("openllm_config_set"));
        assert!(!RpcClient::is_internal_tool("cursor_read_file"));
        assert!(!RpcClient::is_internal_tool("some_other_tool"));
    }
    
    #[test]
    fn test_mcp_tool_result_text() {
        let result = McpToolResult {
            content: vec![
                McpToolContent::Text { text: "Hello ".to_string() },
                McpToolContent::Text { text: "World".to_string() },
            ],
            is_error: false,
        };
        assert_eq!(result.text(), "Hello \nWorld");
    }
    
    #[test]
    fn test_mcp_tool_result_parse_json() {
        let result = McpToolResult {
            content: vec![
                McpToolContent::Text { text: r#"{"success": true}"#.to_string() },
            ],
            is_error: false,
        };
        
        #[derive(serde::Deserialize)]
        struct Data { success: bool }
        
        let data: Data = result.parse_json().unwrap();
        assert!(data.success);
    }
}
