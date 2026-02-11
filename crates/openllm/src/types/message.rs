//! Chat message types

use serde::{Deserialize, Serialize};

/// Message role in a conversation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
}

impl std::fmt::Display for MessageRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MessageRole::System => write!(f, "system"),
            MessageRole::User => write!(f, "user"),
            MessageRole::Assistant => write!(f, "assistant"),
        }
    }
}

/// A chat message for LLM requests
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    /// The role of the message sender
    pub role: MessageRole,
    /// The content of the message (string or structured parts)
    pub content: MessageContent,
}

impl ChatMessage {
    /// Create a system message
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::System,
            content: MessageContent::Text(content.into()),
        }
    }

    /// Create a user message
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::User,
            content: MessageContent::Text(content.into()),
        }
    }

    /// Create an assistant message
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::Assistant,
            content: MessageContent::Text(content.into()),
        }
    }

    /// Create a message with structured content parts
    pub fn with_parts(role: MessageRole, parts: Vec<ContentPart>) -> Self {
        Self {
            role,
            content: MessageContent::Parts(parts),
        }
    }

    /// Get the text content if this is a simple text message
    pub fn text(&self) -> Option<&str> {
        match &self.content {
            MessageContent::Text(s) => Some(s),
            MessageContent::Parts(_) => None,
        }
    }
}

/// Message content - either simple text or structured parts
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MessageContent {
    /// Simple text content
    Text(String),
    /// Structured content with multiple parts
    Parts(Vec<ContentPart>),
}

impl From<String> for MessageContent {
    fn from(s: String) -> Self {
        MessageContent::Text(s)
    }
}

impl From<&str> for MessageContent {
    fn from(s: &str) -> Self {
        MessageContent::Text(s.to_string())
    }
}

impl From<Vec<ContentPart>> for MessageContent {
    fn from(parts: Vec<ContentPart>) -> Self {
        MessageContent::Parts(parts)
    }
}

/// Content part for multi-modal and tool messages
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentPart {
    /// Text content
    Text {
        text: String,
    },
    /// Image content (URL or base64)
    Image {
        #[serde(rename = "imageUrl")]
        image_url: String,
    },
    /// Tool use (assistant calling a tool)
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// Tool result (returning tool output)
    ToolResult {
        #[serde(rename = "tool_use_id")]
        tool_use_id: String,
        content: String,
    },
}

impl ContentPart {
    /// Create a text content part
    pub fn text(text: impl Into<String>) -> Self {
        ContentPart::Text { text: text.into() }
    }

    /// Create an image content part
    pub fn image(url: impl Into<String>) -> Self {
        ContentPart::Image {
            image_url: url.into(),
        }
    }

    /// Create a tool use content part
    pub fn tool_use(id: impl Into<String>, name: impl Into<String>, input: serde_json::Value) -> Self {
        ContentPart::ToolUse {
            id: id.into(),
            name: name.into(),
            input,
        }
    }

    /// Create a tool result content part
    pub fn tool_result(tool_use_id: impl Into<String>, content: impl Into<String>) -> Self {
        ContentPart::ToolResult {
            tool_use_id: tool_use_id.into(),
            content: content.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_chat_message_creation() {
        let sys = ChatMessage::system("You are helpful");
        assert_eq!(sys.role, MessageRole::System);
        assert_eq!(sys.text(), Some("You are helpful"));

        let user = ChatMessage::user("Hello");
        assert_eq!(user.role, MessageRole::User);

        let asst = ChatMessage::assistant("Hi there!");
        assert_eq!(asst.role, MessageRole::Assistant);
    }

    #[test]
    fn test_message_serialization() {
        let msg = ChatMessage::user("Hello");
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"role\":\"user\""));
        assert!(json.contains("\"content\":\"Hello\""));
    }

    #[test]
    fn test_content_part_serialization() {
        let part = ContentPart::text("Hello");
        let json = serde_json::to_string(&part).unwrap();
        assert!(json.contains("\"type\":\"text\""));
    }
}
