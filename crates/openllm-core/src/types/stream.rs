//! Streaming response types

use serde::{Deserialize, Serialize};
use super::tool::ToolCall;

/// Streaming chunk from an LLM response
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamChunk {
    /// Text content chunk
    Text {
        text: String,
    },
    /// Complete tool call
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
}

impl StreamChunk {
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

    /// Check if this is a text chunk
    pub fn is_text(&self) -> bool {
        matches!(self, StreamChunk::Text { .. })
    }

    /// Check if this is a tool call chunk
    pub fn is_tool_call(&self) -> bool {
        matches!(self, StreamChunk::ToolCall { .. })
    }

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
}
