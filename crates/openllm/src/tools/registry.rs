//! Tool registry for managing LLM tool calling
//!
//! The ToolRegistry is the central component for:
//! - Discovering available tools from MCP servers
//! - Filtering tools based on user preferences
//! - Converting tools to LLM provider formats
//! - Executing tools and returning results

use std::collections::HashSet;
use std::sync::Arc;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::mcp::{McpClient, McpTool, is_internal_tool};
use crate::logging::Logger;
use crate::types::{Tool, ToolCall, ToolResult};

/// Information about a tool with its source
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    /// Tool name
    pub name: String,
    /// Tool description
    pub description: String,
    /// JSON Schema for tool parameters
    pub input_schema: Value,
    /// Whether this tool is enabled
    pub enabled: bool,
    /// Source of this tool (e.g., "vscode", "mcp:server-name")
    pub source: String,
    /// Whether this is an internal tool (hidden from LLM)
    pub internal: bool,
}

impl From<McpTool> for ToolInfo {
    fn from(tool: McpTool) -> Self {
        let name = tool.name.to_string();
        let internal = is_internal_tool(&name);
        Self {
            name,
            description: tool.description.map(|s| s.to_string()).unwrap_or_default(),
            // input_schema is Arc<JsonObject>, convert to Value
            input_schema: serde_json::to_value(tool.input_schema.as_ref()).unwrap_or_default(),
            enabled: true,
            source: "vscode".to_string(),
            internal,
        }
    }
}

impl From<&ToolInfo> for Tool {
    fn from(info: &ToolInfo) -> Self {
        Tool {
            name: info.name.clone(),
            description: info.description.clone(),
            input_schema: Some(info.input_schema.clone()),
        }
    }
}

/// Filter for tool discovery
#[derive(Debug, Clone, Default)]
pub struct ToolFilter {
    /// If set, only include tools with these names
    pub include: Option<HashSet<String>>,
    /// Exclude tools with these names
    pub exclude: HashSet<String>,
    /// Include internal tools (default: false)
    pub include_internal: bool,
    /// Only include enabled tools (default: true)
    pub only_enabled: bool,
}

impl ToolFilter {
    pub fn new() -> Self {
        Self {
            include: None,
            exclude: HashSet::new(),
            include_internal: false,
            only_enabled: true,
        }
    }
    
    /// Include all tools
    pub fn all() -> Self {
        Self {
            include: None,
            exclude: HashSet::new(),
            include_internal: true,
            only_enabled: false,
        }
    }
    
    /// Include only specific tools
    pub fn with_include(mut self, names: impl IntoIterator<Item = String>) -> Self {
        self.include = Some(names.into_iter().collect());
        self
    }
    
    /// Exclude specific tools
    pub fn with_exclude(mut self, names: impl IntoIterator<Item = String>) -> Self {
        self.exclude = names.into_iter().collect();
        self
    }
    
    /// Include internal tools
    pub fn with_internal(mut self) -> Self {
        self.include_internal = true;
        self
    }
    
    /// Check if a tool matches this filter
    pub fn matches(&self, tool: &ToolInfo) -> bool {
        // Check internal filter
        if !self.include_internal && tool.internal {
            return false;
        }
        
        // Check enabled filter
        if self.only_enabled && !tool.enabled {
            return false;
        }
        
        // Check exclude list
        if self.exclude.contains(&tool.name) {
            return false;
        }
        
        // Check include list (if specified)
        if let Some(ref include) = self.include {
            if !include.contains(&tool.name) {
                return false;
            }
        }
        
        true
    }
}

/// Tool registry for managing available tools
pub struct ToolRegistry {
    /// MCP client for tool discovery and execution (using official rmcp SDK)
    mcp_client: RwLock<Option<Arc<McpClient>>>,
    /// Cached tools from last refresh
    tools: RwLock<Vec<ToolInfo>>,
    /// User-configured enabled/disabled state
    tool_states: RwLock<std::collections::HashMap<String, bool>>,
    /// Logger
    logger: Arc<dyn Logger>,
}

impl ToolRegistry {
    /// Create a new tool registry
    pub fn new(logger: Arc<dyn Logger>) -> Self {
        Self {
            mcp_client: RwLock::new(None),
            tools: RwLock::new(Vec::new()),
            tool_states: RwLock::new(std::collections::HashMap::new()),
            logger,
        }
    }
    
    /// Create a new tool registry with an MCP client
    pub fn with_client(mcp_client: Arc<McpClient>, logger: Arc<dyn Logger>) -> Self {
        Self {
            mcp_client: RwLock::new(Some(mcp_client)),
            tools: RwLock::new(Vec::new()),
            tool_states: RwLock::new(std::collections::HashMap::new()),
            logger,
        }
    }
    
    /// Set the MCP client (for lazy initialization)
    pub fn set_client(&self, client: Arc<McpClient>) {
        *self.mcp_client.write() = Some(client);
    }
    
    /// Refresh the tool list from all sources
    pub async fn refresh(&self) -> Result<(), String> {
        let mut new_tools = Vec::new();
        
        // Fetch tools from MCP server
        let client = self.mcp_client.read().clone();
        if let Some(ref client) = client {
            match client.list_tools().await {
                Ok(mcp_tools) => {
                    self.logger.info(&format!(
                        "[ToolRegistry] Discovered {} tools from MCP server",
                        mcp_tools.len()
                    ));
                    
                    for tool in mcp_tools {
                        let mut info: ToolInfo = tool.into();
                        info.source = "vscode".to_string();
                        
                        // Apply user-configured state
                        let states = self.tool_states.read();
                        if let Some(&enabled) = states.get(&info.name) {
                            info.enabled = enabled;
                        }
                        
                        new_tools.push(info);
                    }
                }
                Err(e) => {
                    self.logger.error(&format!(
                        "[ToolRegistry] Failed to fetch tools: {}",
                        e
                    ));
                    return Err(format!("Failed to fetch tools: {}", e));
                }
            }
        } else {
            self.logger.warn("[ToolRegistry] No MCP client configured, skipping tool refresh");
        }
        
        // Update cache
        *self.tools.write() = new_tools;
        
        Ok(())
    }
    
    /// Get tools matching a filter
    pub fn get_tools(&self, filter: &ToolFilter) -> Vec<ToolInfo> {
        self.tools
            .read()
            .iter()
            .filter(|t| filter.matches(t))
            .cloned()
            .collect()
    }
    
    /// Get tools for sending to LLM (user-visible, enabled only)
    pub fn get_llm_tools(&self) -> Vec<Tool> {
        self.get_tools(&ToolFilter::new())
            .iter()
            .map(Tool::from)
            .collect()
    }
    
    /// Enable or disable a tool
    pub fn set_tool_enabled(&self, name: &str, enabled: bool) {
        // Update state map
        self.tool_states.write().insert(name.to_string(), enabled);
        
        // Update cached tools
        let mut tools = self.tools.write();
        if let Some(tool) = tools.iter_mut().find(|t| t.name == name) {
            tool.enabled = enabled;
        }
    }
    
    /// Call a tool by name
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<crate::mcp::McpToolResult, String> {
        let client = self.mcp_client.read().clone();
        let client = client.as_ref()
            .ok_or("No MCP client configured")?;
        
        self.logger.info(&format!("[ToolRegistry] Calling tool: {}", name));
        
        client.call_tool(name, arguments)
            .await
            .map_err(|e| format!("Tool call failed: {}", e))
    }
    
    /// Execute a tool call from an LLM response
    pub async fn execute_tool_call(&self, tool_call: &ToolCall) -> ToolResult {
        use rmcp::model::RawContent;
        
        match self.call_tool(&tool_call.name, tool_call.input.clone()).await {
            Ok(result) => {
                // Extract text content from MCP result
                // Content is Annotated<RawContent>, we access .raw to get RawContent
                let text = result.content.iter()
                    .filter_map(|c| {
                        match &c.raw {
                            RawContent::Text(t) => Some(t.text.clone()),
                            _ => None,
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                
                ToolResult {
                    call_id: tool_call.id.clone(),
                    content: text,
                    is_error: result.is_error.unwrap_or(false),
                }
            }
            Err(e) => {
                ToolResult {
                    call_id: tool_call.id.clone(),
                    content: format!("Error: {}", e),
                    is_error: true,
                }
            }
        }
    }
    
    /// Execute multiple tool calls (in parallel where safe)
    pub async fn execute_tool_calls(&self, tool_calls: &[ToolCall]) -> Vec<ToolResult> {
        // For now, execute sequentially to avoid potential ordering issues
        // TODO: Consider parallel execution for independent tools
        let mut results = Vec::new();
        
        for call in tool_calls {
            let result = self.execute_tool_call(call).await;
            results.push(result);
        }
        
        results
    }
    
    /// Get count of available tools
    pub fn tool_count(&self) -> usize {
        self.tools.read().len()
    }
    
    /// Get count of enabled, user-visible tools
    pub fn enabled_tool_count(&self) -> usize {
        self.get_tools(&ToolFilter::new()).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tool_filter_default() {
        let filter = ToolFilter::new();
        
        let user_tool = ToolInfo {
            name: "cursor_read_file".to_string(),
            description: "Read a file".to_string(),
            input_schema: serde_json::json!({}),
            enabled: true,
            source: "vscode".to_string(),
            internal: false,
        };
        
        let internal_tool = ToolInfo {
            name: "openllm_secrets_get".to_string(),
            description: "Get secret".to_string(),
            input_schema: serde_json::json!({}),
            enabled: true,
            source: "vscode".to_string(),
            internal: true,
        };
        
        let disabled_tool = ToolInfo {
            name: "some_tool".to_string(),
            description: "A tool".to_string(),
            input_schema: serde_json::json!({}),
            enabled: false,
            source: "vscode".to_string(),
            internal: false,
        };
        
        assert!(filter.matches(&user_tool));
        assert!(!filter.matches(&internal_tool));
        assert!(!filter.matches(&disabled_tool));
    }
    
    #[test]
    fn test_tool_filter_with_internal() {
        let filter = ToolFilter::new().with_internal();
        
        let internal_tool = ToolInfo {
            name: "openllm_secrets_get".to_string(),
            description: "Get secret".to_string(),
            input_schema: serde_json::json!({}),
            enabled: true,
            source: "vscode".to_string(),
            internal: true,
        };
        
        assert!(filter.matches(&internal_tool));
    }
    
    #[test]
    fn test_tool_filter_exclude() {
        let filter = ToolFilter::new()
            .with_exclude(["cursor_edit_file".to_string()]);
        
        let included = ToolInfo {
            name: "cursor_read_file".to_string(),
            description: "Read a file".to_string(),
            input_schema: serde_json::json!({}),
            enabled: true,
            source: "vscode".to_string(),
            internal: false,
        };
        
        let excluded = ToolInfo {
            name: "cursor_edit_file".to_string(),
            description: "Edit a file".to_string(),
            input_schema: serde_json::json!({}),
            enabled: true,
            source: "vscode".to_string(),
            internal: false,
        };
        
        assert!(filter.matches(&included));
        assert!(!filter.matches(&excluded));
    }
}
