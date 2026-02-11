//! Tool/function calling types

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Tool definition for function calling
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    /// Tool name (function name)
    pub name: String,
    /// Description of what the tool does
    pub description: String,
    /// JSON Schema for the input parameters
    #[serde(rename = "inputSchema", skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<Value>,
}

impl Tool {
    /// Create a new tool definition
    pub fn new(name: impl Into<String>, description: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema: None,
        }
    }

    /// Set the input schema
    pub fn with_schema(mut self, schema: Value) -> Self {
        self.input_schema = Some(schema);
        self
    }

    /// Create a tool with a typed schema
    pub fn with_parameters<T: Serialize>(mut self, params: &T) -> Self {
        self.input_schema = Some(serde_json::to_value(params).unwrap_or(Value::Object(Default::default())));
        self
    }
}

/// Tool call from the LLM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    /// Unique identifier for this tool call
    pub id: String,
    /// Name of the tool being called
    pub name: String,
    /// Input arguments for the tool
    pub input: Value,
}

impl ToolCall {
    /// Create a new tool call
    pub fn new(id: impl Into<String>, name: impl Into<String>, input: Value) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            input,
        }
    }

    /// Get an input argument by key
    pub fn get_arg(&self, key: &str) -> Option<&Value> {
        self.input.get(key)
    }

    /// Get an input argument as a string
    pub fn get_arg_str(&self, key: &str) -> Option<&str> {
        self.input.get(key).and_then(|v| v.as_str())
    }

    /// Get an input argument as an i64
    pub fn get_arg_i64(&self, key: &str) -> Option<i64> {
        self.input.get(key).and_then(|v| v.as_i64())
    }

    /// Get an input argument as a bool
    pub fn get_arg_bool(&self, key: &str) -> Option<bool> {
        self.input.get(key).and_then(|v| v.as_bool())
    }
}

/// Tool result to send back to LLM
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    /// ID of the tool call this is responding to
    #[serde(rename = "callId")]
    pub call_id: String,
    /// The result content
    pub content: String,
    /// Whether this result represents an error
    #[serde(rename = "isError", default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
}

impl ToolResult {
    /// Create a successful tool result
    pub fn success(call_id: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(),
            content: content.into(),
            is_error: false,
        }
    }

    /// Create an error tool result
    pub fn error(call_id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            call_id: call_id.into(),
            content: error.into(),
            is_error: true,
        }
    }
}

/// Tool choice option for requests
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolChoice {
    /// Let the model decide whether to use tools
    Auto,
    /// Don't use tools
    None,
    /// Force tool use
    Required,
}

impl Default for ToolChoice {
    fn default() -> Self {
        ToolChoice::Auto
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_tool_creation() {
        let tool = Tool::new("get_weather", "Get the current weather")
            .with_schema(json!({
                "type": "object",
                "properties": {
                    "location": { "type": "string" }
                },
                "required": ["location"]
            }));

        assert_eq!(tool.name, "get_weather");
        assert!(tool.input_schema.is_some());
    }

    #[test]
    fn test_tool_call_args() {
        let call = ToolCall::new(
            "call_123",
            "get_weather",
            json!({
                "location": "San Francisco",
                "units": "celsius"
            }),
        );

        assert_eq!(call.get_arg_str("location"), Some("San Francisco"));
        assert_eq!(call.get_arg_str("units"), Some("celsius"));
        assert_eq!(call.get_arg_str("nonexistent"), None);
    }

    #[test]
    fn test_tool_result() {
        let success = ToolResult::success("call_123", "72°F, sunny");
        assert!(!success.is_error);

        let error = ToolResult::error("call_456", "Location not found");
        assert!(error.is_error);
    }
}
