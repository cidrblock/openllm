//! VS Code Language Model Provider
//!
//! This provider uses MCP to communicate with the VS Code extension,
//! allowing Rust to use vscode.lm models (Copilot, GitHub Models, etc.)
//! as if they were any other provider.
//!
//! The provider calls:
//! - `openllm_llm_list` to discover available models
//! - `openllm_llm_send` to send chat requests

use async_trait::async_trait;
use std::sync::Arc;
use futures::stream;
use parking_lot::RwLock;

use crate::logging::Logger;
use crate::mcp::{McpClient, McpToolResult};
use crate::types::{
    ChatMessage, StreamChunk, CancellationToken, ProviderMetadata,
    DefaultModel, ModelCapabilities, ToolCall,
};
use super::error::{ProviderError, ProviderResult};
use super::traits::{Provider, ProviderModelConfig, StreamChatOptions, StreamResponse};

/// Information about a VS Code language model
#[derive(Debug, Clone, serde::Deserialize)]
pub struct VsCodeModelInfo {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub family: String,
    #[serde(default)]
    pub version: String,
    #[serde(rename = "maxInputTokens", default)]
    pub max_input_tokens: u32,
}

/// Response from openllm_llm_list
#[derive(Debug, serde::Deserialize)]
struct LlmListResponse {
    models: Vec<VsCodeModelInfo>,
    #[serde(default)]
    error: Option<String>,
}

/// A chunk from the LLM response
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum LlmChunk {
    Text {
        text: String,
    },
    ToolCall {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        #[serde(rename = "toolInput")]
        tool_input: serde_json::Value,
    },
}

/// Response from openllm_llm_send
#[derive(Debug, serde::Deserialize)]
struct LlmSendResponse {
    #[serde(default)]
    chunks: Vec<LlmChunk>,
    #[serde(default)]
    error: Option<String>,
}

/// VS Code provider that uses MCP to access vscode.lm models
pub struct VsCodeProvider {
    /// MCP client for communicating with the VS Code extension
    mcp_client: RwLock<Option<Arc<McpClient>>>,
    /// Cached models from last list call
    cached_models: RwLock<Vec<VsCodeModelInfo>>,
    /// Logger
    logger: Arc<dyn Logger>,
}

impl VsCodeProvider {
    /// Create a new VS Code provider
    pub fn new(logger: Arc<dyn Logger>) -> Self {
        Self {
            mcp_client: RwLock::new(None),
            cached_models: RwLock::new(Vec::new()),
            logger,
        }
    }

    /// Create with an existing MCP client
    pub fn with_client(client: Arc<McpClient>, logger: Arc<dyn Logger>) -> Self {
        Self {
            mcp_client: RwLock::new(Some(client)),
            cached_models: RwLock::new(Vec::new()),
            logger,
        }
    }

    /// Set the MCP client
    pub fn set_client(&self, client: Arc<McpClient>) {
        *self.mcp_client.write() = Some(client);
    }

    /// Check if connected to VS Code extension
    pub fn is_connected(&self) -> bool {
        self.mcp_client.read().is_some()
    }

    /// Extract text content from MCP tool result
    fn extract_text_content(result: &McpToolResult) -> String {
        // McpToolResult has a `content` field
        // We serialize each content item and extract text
        result.content.iter()
            .filter_map(|content| {
                // Serialize the content to JSON and extract text
                if let Ok(json) = serde_json::to_value(content) {
                    // Check if it's a text content type
                    if json.get("type").and_then(|t| t.as_str()) == Some("text") {
                        return json.get("text").and_then(|t| t.as_str()).map(|s| s.to_string());
                    }
                }
                None
            })
            .collect::<Vec<_>>()
            .join("")
    }

    /// Get text from MessageContent
    fn get_message_text(content: &crate::types::MessageContent) -> String {
        match content {
            crate::types::MessageContent::Text(s) => s.clone(),
            crate::types::MessageContent::Parts(parts) => {
                parts.iter()
                    .filter_map(|p| {
                        if let crate::types::ContentPart::Text { text } = p {
                            Some(text.clone())
                        } else {
                            None
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("")
            }
        }
    }

    /// List available VS Code language models
    pub async fn list_models(&self) -> ProviderResult<Vec<VsCodeModelInfo>> {
        let client = self.mcp_client.read().clone();
        let client = client.ok_or_else(|| {
            ProviderError::Other("VS Code MCP client not connected".to_string())
        })?;

        // Call the MCP tool
        let result = client.call_tool("openllm_llm_list", serde_json::json!({}))
            .await
            .map_err(|e| ProviderError::Other(format!("MCP call failed: {}", e)))?;

        // Extract text content from the result
        let content = Self::extract_text_content(&result);

        // Parse the response
        let response: LlmListResponse = serde_json::from_str(&content)
            .map_err(|e| ProviderError::invalid_response("vscode", format!("Failed to parse llm_list response: {}", e)))?;

        if let Some(error) = response.error {
            return Err(ProviderError::api_error("vscode", 0, error));
        }

        // Cache the models
        *self.cached_models.write() = response.models.clone();

        self.logger.info(&format!(
            "[VsCodeProvider] Found {} models from VS Code",
            response.models.len()
        ));

        Ok(response.models)
    }

    /// Send a chat request to a VS Code language model
    async fn send_request(
        &self,
        model_id: &str,
        messages: Vec<ChatMessage>,
        _options: StreamChatOptions,
    ) -> ProviderResult<Vec<StreamChunk>> {
        let client = self.mcp_client.read().clone();
        let client = client.ok_or_else(|| {
            ProviderError::Other("VS Code MCP client not connected".to_string())
        })?;

        // Convert messages to the format expected by the MCP tool
        let mcp_messages: Vec<serde_json::Value> = messages.iter().map(|m| {
            serde_json::json!({
                "role": match m.role {
                    crate::types::MessageRole::System => "system",
                    crate::types::MessageRole::User => "user",
                    crate::types::MessageRole::Assistant => "assistant",
                },
                "content": Self::get_message_text(&m.content),
            })
        }).collect();

        // Call the MCP tool
        let result = client.call_tool("openllm_llm_send", serde_json::json!({
            "modelId": model_id,
            "messages": mcp_messages,
        }))
            .await
            .map_err(|e| ProviderError::Other(format!("MCP call failed: {}", e)))?;

        // Extract text content from the result
        let content = Self::extract_text_content(&result);

        // Parse the response
        let response: LlmSendResponse = serde_json::from_str(&content)
            .map_err(|e| ProviderError::invalid_response("vscode", format!("Failed to parse llm_send response: {}", e)))?;

        if let Some(error) = response.error {
            return Err(ProviderError::api_error("vscode", 0, error));
        }

        // Convert chunks to StreamChunk
        let stream_chunks: Vec<StreamChunk> = response.chunks.into_iter().map(|chunk| {
            match chunk {
                LlmChunk::Text { text } => StreamChunk::text(text),
                LlmChunk::ToolCall { tool_call_id, tool_name, tool_input } => {
                    StreamChunk::tool_call(ToolCall {
                        id: tool_call_id,
                        name: tool_name,
                        input: tool_input,
                    })
                }
            }
        }).collect();

        Ok(stream_chunks)
    }
}

#[async_trait]
impl Provider for VsCodeProvider {
    fn name(&self) -> &str {
        "vscode"
    }

    fn default_api_base(&self) -> &str {
        // MCP socket path would go here, but we don't use HTTP
        "mcp://vscode"
    }

    fn metadata(&self) -> ProviderMetadata {
        // Get cached models for default_models
        let cached = self.cached_models.read();
        let default_models: Vec<DefaultModel> = cached.iter().map(|m| {
            DefaultModel {
                id: m.id.clone(),
                name: m.name.clone(),
                context_length: m.max_input_tokens,
                capabilities: ModelCapabilities {
                    image_input: false, // VS Code API doesn't expose this
                    tool_calling: true, // Most vscode.lm models support tools
                    streaming: true,
                },
            }
        }).collect();

        ProviderMetadata {
            id: "vscode".to_string(),
            display_name: "VS Code Language Models".to_string(),
            default_api_base: self.default_api_base().to_string(),
            requires_api_key: false, // Uses VS Code's auth
            default_models,
        }
    }

    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        model: ProviderModelConfig,
        options: StreamChatOptions,
        _cancel_token: CancellationToken,
    ) -> ProviderResult<StreamResponse> {
        self.logger.info(&format!(
            "[VsCodeProvider] stream_chat for model: {}",
            model.model
        ));

        // Send the request and get all chunks
        // Note: MCP tools are synchronous, so we collect all chunks first
        let chunks = self.send_request(&model.model, messages, options).await?;

        // Add a Done chunk at the end
        let mut all_chunks = chunks;
        all_chunks.push(StreamChunk::done());

        // Convert to a stream
        let chunk_stream = stream::iter(all_chunks.into_iter().map(Ok));
        
        Ok(Box::pin(chunk_stream))
    }

    async fn count_tokens(&self, text: &str) -> ProviderResult<usize> {
        // Rough approximation: ~4 characters per token
        Ok(text.len() / 4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::NoOpLogger;

    #[test]
    fn test_vscode_provider_creation() {
        let logger: Arc<dyn Logger> = Arc::new(NoOpLogger);
        let provider = VsCodeProvider::new(logger);
        
        assert_eq!(provider.name(), "vscode");
        assert!(!provider.is_connected());
    }

    #[test]
    fn test_vscode_provider_metadata() {
        let logger: Arc<dyn Logger> = Arc::new(NoOpLogger);
        let provider = VsCodeProvider::new(logger);
        
        let meta = provider.metadata();
        assert_eq!(meta.id, "vscode");
        assert_eq!(meta.display_name, "VS Code Language Models");
        assert!(!meta.requires_api_key);
    }
}
