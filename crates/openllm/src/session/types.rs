//! Session types

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::proto::{ClientType, Timestamp as ProtoTimestamp};

/// A chat session that can be persisted and shared
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    /// Unique session ID
    pub id: String,
    
    /// Model used for this session
    pub model: String,
    
    /// Topic/title (auto-generated or user-set)
    pub topic: Option<String>,
    
    /// All messages in the session
    pub messages: Vec<SessionMessage>,
    
    /// Client that created this session
    pub created_by: ClientInfo,
    
    /// Creation timestamp
    pub created_at: DateTime<Utc>,
    
    /// Last update timestamp
    pub updated_at: DateTime<Utc>,
    
    /// Session metadata (workspace, branch, etc.)
    pub metadata: HashMap<String, String>,
    
    /// If forked, the parent session ID
    pub forked_from: Option<String>,
    
    /// If forked, the message index where fork occurred
    pub fork_point: Option<usize>,
    
    /// Cached AI-generated summary
    pub cached_summary: Option<String>,
}

/// A message in a session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMessage {
    pub role: MessageRole,
    pub content: String,
    pub tool_calls: Option<Vec<ToolCall>>,
    pub tool_call_id: Option<String>,
    pub name: Option<String>,
    pub timestamp: DateTime<Utc>,
}

/// Message role
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageRole {
    System,
    User,
    Assistant,
    Tool,
}

/// Tool call in a message
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// Client information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub client_type: String,
    pub client_id: String,
    pub user: Option<String>,
}

impl Session {
    /// Create a new session
    pub fn new(model: String, created_by: ClientInfo) -> Self {
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            model,
            topic: None,
            messages: Vec::new(),
            created_by,
            created_at: now,
            updated_at: now,
            metadata: HashMap::new(),
            forked_from: None,
            fork_point: None,
            cached_summary: None,
        }
    }
    
    /// Create a new session with a specific ID
    pub fn with_id(id: String, model: String, created_by: ClientInfo) -> Self {
        let now = Utc::now();
        Self {
            id,
            model,
            topic: None,
            messages: Vec::new(),
            created_by,
            created_at: now,
            updated_at: now,
            metadata: HashMap::new(),
            forked_from: None,
            fork_point: None,
            cached_summary: None,
        }
    }
    
    /// Add a message to the session
    pub fn add_message(&mut self, message: SessionMessage) {
        self.messages.push(message);
        self.updated_at = Utc::now();
        // Invalidate cached summary when messages change
        self.cached_summary = None;
    }
    
    /// Get message count
    pub fn message_count(&self) -> usize {
        self.messages.len()
    }
    
    /// Fork this session at a specific point
    pub fn fork(&self, fork_point: Option<usize>, new_model: Option<String>) -> Self {
        let fork_idx = fork_point.unwrap_or(self.messages.len());
        let messages = self.messages[..fork_idx.min(self.messages.len())].to_vec();
        
        let now = Utc::now();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            model: new_model.unwrap_or_else(|| self.model.clone()),
            topic: self.topic.clone().map(|t| format!("{} (fork)", t)),
            messages,
            created_by: self.created_by.clone(),
            created_at: now,
            updated_at: now,
            metadata: self.metadata.clone(),
            forked_from: Some(self.id.clone()),
            fork_point: Some(fork_idx),
            cached_summary: None,
        }
    }
    
    /// Format session for context injection (replay)
    pub fn format_for_replay(&self, condensed: bool, max_messages: Option<usize>) -> String {
        let mut output = String::new();
        
        output.push_str(&format!("=== OpenLLM Session: {} ===\n", self.id));
        output.push_str(&format!("Model: {}\n", self.model));
        output.push_str(&format!("Created: {}\n", self.created_at.format("%Y-%m-%d %H:%M")));
        
        if let Some(topic) = &self.topic {
            output.push_str(&format!("Topic: {}\n", topic));
        }
        
        output.push_str("\n--- Conversation ---\n\n");
        
        let messages: Vec<_> = if let Some(max) = max_messages {
            if condensed && self.messages.len() > max {
                // Take first few and last few
                let take = max / 2;
                let skip = self.messages.len() - take;
                let mut msgs: Vec<_> = self.messages.iter().take(take).collect();
                msgs.push(&self.messages[0]); // placeholder for "..."
                msgs.extend(self.messages.iter().skip(skip));
                msgs
            } else {
                self.messages.iter().collect()
            }
        } else {
            self.messages.iter().collect()
        };
        
        for msg in &messages {
            let role = match msg.role {
                MessageRole::System => "[System]",
                MessageRole::User => "[User]",
                MessageRole::Assistant => "[Assistant]",
                MessageRole::Tool => "[Tool]",
            };
            
            if condensed {
                // Truncate long messages
                let content = if msg.content.len() > 500 {
                    format!("{}...", &msg.content[..500])
                } else {
                    msg.content.clone()
                };
                output.push_str(&format!("{}: {}\n\n", role, content));
            } else {
                output.push_str(&format!("{}: {}\n\n", role, msg.content));
            }
        }
        
        output.push_str("=== End Session ===\n");
        output
    }
    
    /// Convert to proto Session
    pub fn to_proto(&self) -> crate::proto::Session {
        use crate::proto;
        
        proto::Session {
            id: self.id.clone(),
            model: self.model.clone(),
            topic: self.topic.clone().unwrap_or_default(),
            messages: self.messages.iter().map(|m| {
                proto::Message {
                    role: match m.role {
                        MessageRole::System => proto::Role::System.into(),
                        MessageRole::User => proto::Role::User.into(),
                        MessageRole::Assistant => proto::Role::Assistant.into(),
                        MessageRole::Tool => proto::Role::Tool.into(),
                    },
                    content: m.content.clone(),
                    tool_calls: m.tool_calls.as_ref().map(|tcs| {
                        tcs.iter().map(|tc| proto::ToolCall {
                            id: tc.id.clone(),
                            name: tc.name.clone(),
                            arguments: tc.arguments.clone(),
                        }).collect()
                    }).unwrap_or_default(),
                    tool_call_id: m.tool_call_id.clone().unwrap_or_default(),
                    name: m.name.clone().unwrap_or_default(),
                }
            }).collect(),
            created_by: Some(proto::ClientInfo {
                client_type: match self.created_by.client_type.as_str() {
                    "vscode" => proto::ClientType::Vscode.into(),
                    "cli" => proto::ClientType::Cli.into(),
                    "python" => proto::ClientType::Python.into(),
                    "nodejs" => proto::ClientType::Nodejs.into(),
                    "mcp" => proto::ClientType::Mcp.into(),
                    _ => proto::ClientType::Unspecified.into(),
                },
                client_id: self.created_by.client_id.clone(),
                user: self.created_by.user.clone().unwrap_or_default(),
            }),
            created_at: Some(ProtoTimestamp {
                seconds: self.created_at.timestamp(),
                nanos: self.created_at.timestamp_subsec_nanos() as i32,
            }),
            updated_at: Some(ProtoTimestamp {
                seconds: self.updated_at.timestamp(),
                nanos: self.updated_at.timestamp_subsec_nanos() as i32,
            }),
            metadata: self.metadata.clone(),
            forked_from: self.forked_from.clone(),
            fork_point: self.fork_point.map(|p| p as i32),
            cached_summary: self.cached_summary.clone(),
        }
    }
}

impl From<ClientType> for String {
    fn from(ct: ClientType) -> String {
        match ct {
            ClientType::Vscode => "vscode".to_string(),
            ClientType::Cli => "cli".to_string(),
            ClientType::Python => "python".to_string(),
            ClientType::Nodejs => "nodejs".to_string(),
            ClientType::Mcp => "mcp".to_string(),
            ClientType::Unspecified => "unknown".to_string(),
        }
    }
}
