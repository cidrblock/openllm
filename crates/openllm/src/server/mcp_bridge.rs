//! MCP Bridge Service - High-performance gRPC transport for MCP tools
//!
//! This implements the "hybrid bridge" pattern:
//! - Keep MCP's semantic layer (tool definitions, JSON schemas for LLM understanding)
//! - Use gRPC's performance layer (HTTP/2 multiplexing, bidirectional streaming)
//!
//! The bridge translates between:
//! - gRPC calls from clients (fast, typed, streaming)
//! - MCP protocol to actual tool servers (JSON-RPC over stdio/SSE)

use std::pin::Pin;
use std::sync::Arc;
use tonic::{Request, Response, Status};
use tokio_stream::Stream;
use tokio::sync::mpsc;

use crate::proto::{
    mcp_bridge_server::McpBridge,
    // Tool calls
    ListMcpToolsRequest, ListMcpToolsResponse, McpTool,
    CallToolRequest, ToolResponseChunk,
    ToolInteractiveRequest, CallToolsBatchRequest,
    // Resources
    ListResourcesRequest, ListResourcesResponse, McpResource,
    ReadResourceRequest, ReadResourceResponse,
    // Prompts
    ListPromptsRequest, ListPromptsResponse, McpPrompt, McpPromptArgument,
    GetPromptRequest, GetPromptResponse, PromptMessage,
    // Response types
    ToolFinalResult, ToolContent, ToolProgress, ToolError,
    tool_response_chunk::Result as ChunkResult,
};
use crate::state::DaemonState;

type ResponseStream<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>;

/// MCP Bridge service - translates gRPC to MCP protocol
pub struct McpBridgeService {
    state: Arc<DaemonState>,
}

impl McpBridgeService {
    pub fn new(state: Arc<DaemonState>) -> Self {
        Self { state }
    }
    
    /// Get tools from all registered MCP servers
    async fn collect_tools(&self, server_filter: Option<&str>) -> Vec<McpTool> {
        let mut tools = Vec::new();
        
        // Iterate through registered MCP servers
        for server in self.state.mcp_servers.iter() {
            if let Some(filter) = server_filter {
                if server.server_id != filter {
                    continue;
                }
            }
            
            // TODO: Actually query the MCP server for its tools
            // For now, return placeholder tools based on server capabilities
            if server.capabilities.contains(&"tools".to_string()) {
                // Would call: mcp_client.list_tools(server.transport)
                tracing::debug!(server_id = %server.server_id, "Would query MCP server for tools");
            }
        }
        
        // Add some built-in tools for demonstration
        tools.push(McpTool {
            name: "openllm_session_list".to_string(),
            description: "List OpenLLM chat sessions available for continuation".to_string(),
            input_schema_json: r#"{
                "type": "object",
                "properties": {
                    "limit": { "type": "integer", "description": "Max sessions to return" },
                    "source_filter": { "type": "string", "description": "Filter by source: vscode, cli, etc" }
                }
            }"#.to_string(),
            server_id: "openllm-daemon".to_string(),
            annotations: vec!["read-only".to_string()],
        });
        
        tools.push(McpTool {
            name: "openllm_session_replay".to_string(),
            description: "Get session history formatted for context injection into a new model".to_string(),
            input_schema_json: r#"{
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session ID to replay" },
                    "format": { "type": "string", "enum": ["full", "condensed", "summary"], "default": "condensed" },
                    "max_messages": { "type": "integer", "description": "Limit messages for condensed format" }
                },
                "required": ["session_id"]
            }"#.to_string(),
            server_id: "openllm-daemon".to_string(),
            annotations: vec!["read-only".to_string()],
        });
        
        tools.push(McpTool {
            name: "openllm_session_export".to_string(),
            description: "Export a session as shareable JSON artifact for team collaboration".to_string(),
            input_schema_json: r#"{
                "type": "object",
                "properties": {
                    "session_id": { "type": "string", "description": "Session to export" }
                },
                "required": ["session_id"]
            }"#.to_string(),
            server_id: "openllm-daemon".to_string(),
            annotations: vec!["read-only".to_string()],
        });
        
        tools
    }
    
    /// Execute a tool and stream results
    async fn execute_tool(
        &self,
        request: CallToolRequest,
        tx: mpsc::Sender<Result<ToolResponseChunk, Status>>,
    ) {
        let request_id = request.request_id.clone().unwrap_or_default();
        
        // Send progress update
        let _ = tx.send(Ok(ToolResponseChunk {
            request_id: request_id.clone(),
            result: Some(ChunkResult::Progress(ToolProgress {
                percentage: 0.0,
                message: format!("Starting tool: {}", request.tool_name),
                eta_seconds: None,
            })),
        })).await;
        
        // Route to appropriate handler based on tool name
        let result = match request.tool_name.as_str() {
            "openllm_session_list" => self.handle_session_list(&request).await,
            "openllm_session_replay" => self.handle_session_replay(&request).await,
            "openllm_session_export" => self.handle_session_export(&request).await,
            _ => {
                // Try to route to registered MCP server
                self.route_to_mcp_server(&request).await
            }
        };
        
        // Send final result
        match result {
            Ok(content) => {
                let _ = tx.send(Ok(ToolResponseChunk {
                    request_id: request_id.clone(),
                    result: Some(ChunkResult::FinalResult(ToolFinalResult {
                        content,
                        is_error: false,
                    })),
                })).await;
            }
            Err(e) => {
                let _ = tx.send(Ok(ToolResponseChunk {
                    request_id,
                    result: Some(ChunkResult::Error(ToolError {
                        code: "TOOL_ERROR".to_string(),
                        message: e,
                        details_json: None,
                    })),
                })).await;
            }
        }
    }
    
    async fn handle_session_list(&self, request: &CallToolRequest) -> Result<Vec<ToolContent>, String> {
        // Parse arguments
        let args: serde_json::Value = serde_json::from_str(&request.arguments_json)
            .unwrap_or(serde_json::json!({}));
        
        let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
        
        let sessions = self.state.sessions.list(Some(limit), None);
        
        let mut output = String::from("# OpenLLM Sessions\n\n");
        
        if sessions.is_empty() {
            output.push_str("No sessions found.\n");
        } else {
            output.push_str("| ID | Model | Topic | Messages | Source | Updated |\n");
            output.push_str("|---|---|---|---|---|---|\n");
            
            for session in sessions {
                output.push_str(&format!(
                    "| {} | {} | {} | {} | {} | {} |\n",
                    &session.id[..8],
                    session.model,
                    session.topic.as_deref().unwrap_or("-"),
                    session.message_count(),
                    session.created_by.client_type,
                    session.updated_at.format("%Y-%m-%d %H:%M"),
                ));
            }
        }
        
        Ok(vec![ToolContent {
            r#type: "text".to_string(),
            text: output,
            mime_type: String::new(),
            data: Vec::new(),
            uri: String::new(),
        }])
    }
    
    async fn handle_session_replay(&self, request: &CallToolRequest) -> Result<Vec<ToolContent>, String> {
        let args: serde_json::Value = serde_json::from_str(&request.arguments_json)
            .map_err(|e| format!("Invalid JSON arguments: {}", e))?;
        
        let session_id = args.get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("session_id is required")?;
        
        let session = self.state.sessions.get(session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;
        
        let format = args.get("format").and_then(|v| v.as_str()).unwrap_or("condensed");
        let max_messages = args.get("max_messages").and_then(|v| v.as_u64()).map(|v| v as usize);
        
        let condensed = format == "condensed" || format == "summary";
        let content = session.format_for_replay(condensed, max_messages);
        
        Ok(vec![ToolContent {
            r#type: "text".to_string(),
            text: content,
            mime_type: String::new(),
            data: Vec::new(),
            uri: String::new(),
        }])
    }
    
    async fn handle_session_export(&self, request: &CallToolRequest) -> Result<Vec<ToolContent>, String> {
        let args: serde_json::Value = serde_json::from_str(&request.arguments_json)
            .map_err(|e| format!("Invalid JSON arguments: {}", e))?;
        
        let session_id = args.get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("session_id is required")?;
        
        let json = self.state.sessions.export(session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;
        
        Ok(vec![ToolContent {
            r#type: "text".to_string(),
            text: json,
            mime_type: "application/json".to_string(),
            data: Vec::new(),
            uri: String::new(),
        }])
    }
    
    async fn route_to_mcp_server(&self, request: &CallToolRequest) -> Result<Vec<ToolContent>, String> {
        // Find which MCP server provides this tool
        // TODO: Maintain a tool -> server mapping
        
        Err(format!("Tool '{}' not found. Available built-in tools: openllm_session_list, openllm_session_replay, openllm_session_export", request.tool_name))
    }
}

#[tonic::async_trait]
impl McpBridge for McpBridgeService {
    async fn list_mcp_tools(
        &self,
        request: Request<ListMcpToolsRequest>,
    ) -> Result<Response<ListMcpToolsResponse>, Status> {
        let req = request.into_inner();
        
        let tools = self.collect_tools(req.server_filter.as_deref()).await;
        
        tracing::info!(tool_count = tools.len(), "Listed MCP tools");
        
        Ok(Response::new(ListMcpToolsResponse { tools }))
    }
    
    type CallToolStream = ResponseStream<ToolResponseChunk>;
    
    async fn call_tool(
        &self,
        request: Request<CallToolRequest>,
    ) -> Result<Response<Self::CallToolStream>, Status> {
        let req = request.into_inner();
        
        tracing::info!(tool = %req.tool_name, "Executing tool via gRPC bridge");
        
        let (tx, rx) = mpsc::channel(100);
        
        let state = self.state.clone();
        let service = McpBridgeService::new(state);
        
        tokio::spawn(async move {
            service.execute_tool(req, tx).await;
        });
        
        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream)))
    }
    
    type CallToolInteractiveStream = ResponseStream<ToolResponseChunk>;
    
    async fn call_tool_interactive(
        &self,
        request: Request<tonic::Streaming<ToolInteractiveRequest>>,
    ) -> Result<Response<Self::CallToolInteractiveStream>, Status> {
        let mut stream = request.into_inner();
        let (tx, rx) = mpsc::channel(100);
        
        let state = self.state.clone();
        
        tokio::spawn(async move {
            while let Ok(Some(req)) = stream.message().await {
                match req.request {
                    Some(crate::proto::tool_interactive_request::Request::Call(call)) => {
                        let service = McpBridgeService::new(state.clone());
                        service.execute_tool(call, tx.clone()).await;
                    }
                    Some(crate::proto::tool_interactive_request::Request::Response(resp)) => {
                        // Handle user's response to a tool prompt
                        tracing::debug!(prompt_id = %resp.prompt_id, "Received prompt response");
                        // TODO: Route response to waiting tool
                    }
                    Some(crate::proto::tool_interactive_request::Request::Cancel(cancel)) => {
                        tracing::info!(request_id = %cancel.request_id, "Tool cancelled");
                        // TODO: Cancel running tool
                        break;
                    }
                    None => {}
                }
            }
        });
        
        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream)))
    }
    
    type CallToolsBatchStream = ResponseStream<ToolResponseChunk>;
    
    async fn call_tools_batch(
        &self,
        request: Request<CallToolsBatchRequest>,
    ) -> Result<Response<Self::CallToolsBatchStream>, Status> {
        let req = request.into_inner();
        
        let (tx, rx) = mpsc::channel(100);
        let state = self.state.clone();
        let stop_on_error = req.stop_on_error;
        
        tokio::spawn(async move {
            for call in req.calls {
                let service = McpBridgeService::new(state.clone());
                let tx_clone = tx.clone();
                
                // Execute in parallel unless stop_on_error
                if stop_on_error {
                    service.execute_tool(call, tx_clone).await;
                } else {
                    let state_clone = state.clone();
                    tokio::spawn(async move {
                        let service = McpBridgeService::new(state_clone);
                        service.execute_tool(call, tx_clone).await;
                    });
                }
            }
        });
        
        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream)))
    }
    
    async fn list_resources(
        &self,
        _request: Request<ListResourcesRequest>,
    ) -> Result<Response<ListResourcesResponse>, Status> {
        // TODO: Query registered MCP servers for resources
        Ok(Response::new(ListResourcesResponse {
            resources: vec![],
        }))
    }
    
    async fn read_resource(
        &self,
        request: Request<ReadResourceRequest>,
    ) -> Result<Response<ReadResourceResponse>, Status> {
        let req = request.into_inner();
        
        // TODO: Route to appropriate MCP server based on URI scheme
        Err(Status::not_found(format!("Resource {} not found", req.uri)))
    }
    
    async fn list_prompts(
        &self,
        _request: Request<ListPromptsRequest>,
    ) -> Result<Response<ListPromptsResponse>, Status> {
        // TODO: Query registered MCP servers for prompts
        Ok(Response::new(ListPromptsResponse {
            prompts: vec![],
        }))
    }
    
    async fn get_prompt(
        &self,
        request: Request<GetPromptRequest>,
    ) -> Result<Response<GetPromptResponse>, Status> {
        let req = request.into_inner();
        
        // TODO: Route to appropriate MCP server
        Err(Status::not_found(format!("Prompt {} not found", req.name)))
    }
}
