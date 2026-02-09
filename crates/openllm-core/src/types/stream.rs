//! Streaming response types

use serde::{Deserialize, Serialize};
use super::tool::ToolCall;

/// Option for a user prompt response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptOption {
    /// Unique ID for this option
    pub id: String,
    /// Display label for the option
    pub label: String,
    /// Whether this is the default/recommended option
    #[serde(default)]
    pub is_default: bool,
}

impl PromptOption {
    pub fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            is_default: false,
        }
    }

    pub fn with_default(mut self, is_default: bool) -> Self {
        self.is_default = is_default;
        self
    }
}

/// Streaming chunk from an LLM response or orchestration event
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamChunk {
    // ========================================================================
    // LLM Response Chunks
    // ========================================================================
    
    /// Text content chunk from LLM
    Text {
        text: String,
    },
    
    /// Complete tool call requested by LLM
    ToolCall {
        #[serde(rename = "toolCall")]
        tool_call: ToolCall,
    },
    
    /// Partial tool call (for streaming tool arguments)
    ToolCallDelta {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(rename = "inputDelta", skip_serializing_if = "Option::is_none")]
        input_delta: Option<String>,
    },
    
    // ========================================================================
    // Orchestration Status Chunks
    // ========================================================================
    
    /// Tool is about to be executed
    ToolExecuting {
        /// Tool call ID
        id: String,
        /// Tool name
        name: String,
        /// Tool arguments (JSON string)
        arguments: String,
    },
    
    /// Tool execution completed
    ToolResult {
        /// Tool call ID
        id: String,
        /// Tool name
        name: String,
        /// Result content
        result: String,
        /// Whether the result is an error
        #[serde(default)]
        is_error: bool,
    },
    
    /// Orchestration iteration status
    OrchestrationStatus {
        /// Current iteration number
        iteration: u32,
        /// Maximum iterations allowed
        max_iterations: u32,
        /// Status message
        message: String,
    },
    
    // ========================================================================
    // User Interaction Chunks
    // ========================================================================
    
    /// Request user input/approval before proceeding
    /// The orchestration loop will pause until a response is received
    UserPrompt {
        /// Unique ID for this prompt (used in response)
        prompt_id: String,
        /// Type of prompt (e.g., "tool_approval", "confirmation", "input")
        prompt_type: String,
        /// Title/question to display
        title: String,
        /// Detailed message/description
        message: String,
        /// Available options for the user
        options: Vec<PromptOption>,
        /// Context data (e.g., tool name, arguments) as JSON
        #[serde(skip_serializing_if = "Option::is_none")]
        context: Option<serde_json::Value>,
    },
    
    // ========================================================================
    // Stream Control
    // ========================================================================
    
    /// Stream has completed
    Done {
        /// Optional summary/stats
        #[serde(skip_serializing_if = "Option::is_none")]
        summary: Option<String>,
    },
    
    /// Error occurred during streaming
    Error {
        /// Error message
        message: String,
        /// Whether the stream can continue
        #[serde(default)]
        recoverable: bool,
    },
}

impl StreamChunk {
    // ========================================================================
    // Constructors
    // ========================================================================
    
    /// Create a text chunk
    pub fn text(text: impl Into<String>) -> Self {
        StreamChunk::Text { text: text.into() }
    }

    /// Create a tool call chunk
    pub fn tool_call(tool_call: ToolCall) -> Self {
        StreamChunk::ToolCall { tool_call }
    }

    /// Create a tool call delta chunk
    pub fn tool_call_delta(
        id: impl Into<String>,
        name: Option<String>,
        input_delta: Option<String>,
    ) -> Self {
        StreamChunk::ToolCallDelta {
            id: id.into(),
            name,
            input_delta,
        }
    }
    
    /// Create a tool executing chunk
    pub fn tool_executing(
        id: impl Into<String>,
        name: impl Into<String>,
        arguments: impl Into<String>,
    ) -> Self {
        StreamChunk::ToolExecuting {
            id: id.into(),
            name: name.into(),
            arguments: arguments.into(),
        }
    }
    
    /// Create a tool result chunk
    pub fn tool_result(
        id: impl Into<String>,
        name: impl Into<String>,
        result: impl Into<String>,
        is_error: bool,
    ) -> Self {
        StreamChunk::ToolResult {
            id: id.into(),
            name: name.into(),
            result: result.into(),
            is_error,
        }
    }
    
    /// Create an orchestration status chunk
    pub fn orchestration_status(
        iteration: u32,
        max_iterations: u32,
        message: impl Into<String>,
    ) -> Self {
        StreamChunk::OrchestrationStatus {
            iteration,
            max_iterations,
            message: message.into(),
        }
    }
    
    /// Create a user prompt chunk
    pub fn user_prompt(
        prompt_id: impl Into<String>,
        prompt_type: impl Into<String>,
        title: impl Into<String>,
        message: impl Into<String>,
        options: Vec<PromptOption>,
    ) -> Self {
        StreamChunk::UserPrompt {
            prompt_id: prompt_id.into(),
            prompt_type: prompt_type.into(),
            title: title.into(),
            message: message.into(),
            options,
            context: None,
        }
    }
    
    /// Create a user prompt chunk with context
    pub fn user_prompt_with_context(
        prompt_id: impl Into<String>,
        prompt_type: impl Into<String>,
        title: impl Into<String>,
        message: impl Into<String>,
        options: Vec<PromptOption>,
        context: serde_json::Value,
    ) -> Self {
        StreamChunk::UserPrompt {
            prompt_id: prompt_id.into(),
            prompt_type: prompt_type.into(),
            title: title.into(),
            message: message.into(),
            options,
            context: Some(context),
        }
    }
    
    /// Create a done chunk
    pub fn done() -> Self {
        StreamChunk::Done { summary: None }
    }
    
    /// Create a done chunk with summary
    pub fn done_with_summary(summary: impl Into<String>) -> Self {
        StreamChunk::Done {
            summary: Some(summary.into()),
        }
    }
    
    /// Create an error chunk
    pub fn error(message: impl Into<String>, recoverable: bool) -> Self {
        StreamChunk::Error {
            message: message.into(),
            recoverable,
        }
    }

    // ========================================================================
    // Type Checks
    // ========================================================================
    
    /// Check if this is a text chunk
    pub fn is_text(&self) -> bool {
        matches!(self, StreamChunk::Text { .. })
    }

    /// Check if this is a tool call chunk
    pub fn is_tool_call(&self) -> bool {
        matches!(self, StreamChunk::ToolCall { .. })
    }
    
    /// Check if this is a tool executing chunk
    pub fn is_tool_executing(&self) -> bool {
        matches!(self, StreamChunk::ToolExecuting { .. })
    }
    
    /// Check if this is a tool result chunk
    pub fn is_tool_result(&self) -> bool {
        matches!(self, StreamChunk::ToolResult { .. })
    }
    
    /// Check if this is a user prompt chunk
    pub fn is_user_prompt(&self) -> bool {
        matches!(self, StreamChunk::UserPrompt { .. })
    }
    
    /// Check if this is a done chunk
    pub fn is_done(&self) -> bool {
        matches!(self, StreamChunk::Done { .. })
    }
    
    /// Check if this is an error chunk
    pub fn is_error(&self) -> bool {
        matches!(self, StreamChunk::Error { .. })
    }

    // ========================================================================
    // Accessors
    // ========================================================================
    
    /// Get the text content if this is a text chunk
    pub fn as_text(&self) -> Option<&str> {
        match self {
            StreamChunk::Text { text } => Some(text),
            _ => None,
        }
    }

    /// Get the tool call if this is a tool call chunk
    pub fn as_tool_call(&self) -> Option<&ToolCall> {
        match self {
            StreamChunk::ToolCall { tool_call } => Some(tool_call),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_text_chunk() {
        let chunk = StreamChunk::text("Hello");
        assert!(chunk.is_text());
        assert!(!chunk.is_tool_call());
        assert_eq!(chunk.as_text(), Some("Hello"));
    }

    #[test]
    fn test_tool_call_chunk() {
        let tool_call = ToolCall::new("id1", "get_weather", json!({"location": "NYC"}));
        let chunk = StreamChunk::tool_call(tool_call);
        assert!(chunk.is_tool_call());
        assert!(!chunk.is_text());
        assert!(chunk.as_tool_call().is_some());
    }

    #[test]
    fn test_chunk_serialization() {
        let chunk = StreamChunk::text("Hello world");
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(json.contains("\"type\":\"text\""));
        assert!(json.contains("\"text\":\"Hello world\""));
    }
    
    #[test]
    fn test_tool_executing_chunk() {
        let chunk = StreamChunk::tool_executing("call-1", "get_weather", r#"{"city":"NYC"}"#);
        assert!(chunk.is_tool_executing());
        
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(json.contains("\"type\":\"tool_executing\""));
        assert!(json.contains("\"name\":\"get_weather\""));
    }
    
    #[test]
    fn test_tool_result_chunk() {
        let chunk = StreamChunk::tool_result("call-1", "get_weather", "Sunny, 72°F", false);
        assert!(chunk.is_tool_result());
        
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(json.contains("\"type\":\"tool_result\""));
        assert!(json.contains("\"is_error\":false"));
    }
    
    #[test]
    fn test_tool_result_error() {
        let chunk = StreamChunk::tool_result("call-1", "get_weather", "API rate limit exceeded", true);
        assert!(chunk.is_tool_result());
        
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(json.contains("\"is_error\":true"));
    }
    
    #[test]
    fn test_orchestration_status_chunk() {
        let chunk = StreamChunk::orchestration_status(2, 10, "Executing tool calls...");
        
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(json.contains("\"type\":\"orchestration_status\""));
        assert!(json.contains("\"iteration\":2"));
        assert!(json.contains("\"max_iterations\":10"));
    }
    
    #[test]
    fn test_user_prompt_chunk() {
        let options = vec![
            PromptOption::new("allow", "Allow").with_default(true),
            PromptOption::new("deny", "Deny"),
            PromptOption::new("always", "Always Allow"),
        ];
        let chunk = StreamChunk::user_prompt(
            "prompt-123",
            "tool_approval",
            "Tool Approval Required",
            "The assistant wants to run 'read_file'",
            options,
        );
        assert!(chunk.is_user_prompt());
        
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(json.contains("\"type\":\"user_prompt\""));
        assert!(json.contains("\"prompt_type\":\"tool_approval\""));
        assert!(json.contains("\"is_default\":true"));
    }
    
    #[test]
    fn test_user_prompt_with_context() {
        let options = vec![
            PromptOption::new("yes", "Yes"),
            PromptOption::new("no", "No"),
        ];
        let context = json!({
            "tool_name": "execute_command",
            "arguments": {"command": "rm -rf /tmp/test"}
        });
        let chunk = StreamChunk::user_prompt_with_context(
            "prompt-456",
            "dangerous_action",
            "Confirm Action",
            "This tool will delete files. Continue?",
            options,
            context,
        );
        
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(json.contains("\"context\""));
        assert!(json.contains("\"tool_name\":\"execute_command\""));
    }
    
    #[test]
    fn test_done_chunk() {
        let chunk = StreamChunk::done();
        assert!(chunk.is_done());
        
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(json.contains("\"type\":\"done\""));
    }
    
    #[test]
    fn test_done_with_summary() {
        let chunk = StreamChunk::done_with_summary("3 tools executed, 2 iterations");
        assert!(chunk.is_done());
        
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(json.contains("\"summary\""));
    }
    
    #[test]
    fn test_error_chunk() {
        let chunk = StreamChunk::error("Connection timeout", true);
        assert!(chunk.is_error());
        
        let json = serde_json::to_string(&chunk).unwrap();
        assert!(json.contains("\"type\":\"error\""));
        assert!(json.contains("\"recoverable\":true"));
    }
    
    #[test]
    fn test_prompt_option_builder() {
        let option = PromptOption::new("opt1", "Option 1")
            .with_default(true);
        
        assert_eq!(option.id, "opt1");
        assert_eq!(option.label, "Option 1");
        assert!(option.is_default);
    }
}
