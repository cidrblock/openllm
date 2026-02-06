//! Provider trait definition

use async_trait::async_trait;
use futures::Stream;
use std::pin::Pin;

use crate::types::{
    ChatMessage, StreamChunk, Tool, ToolChoice, CancellationToken, ProviderMetadata,
};
use super::error::ProviderResult;

/// Model configuration for provider requests
#[derive(Debug, Clone)]
pub struct ProviderModelConfig {
    /// Model identifier as used by the provider's API
    pub model: String,
    /// API key for authentication
    pub api_key: Option<String>,
    /// Custom API base URL
    pub api_base: Option<String>,
}

impl ProviderModelConfig {
    /// Create a new model config
    pub fn new(model: impl Into<String>) -> Self {
        Self {
            model: model.into(),
            api_key: None,
            api_base: None,
        }
    }

    /// Set the API key
    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        self.api_key = Some(key.into());
        self
    }

    /// Set the API base URL
    pub fn with_api_base(mut self, base: impl Into<String>) -> Self {
        self.api_base = Some(base.into());
        self
    }
}

/// Options for streaming chat requests
#[derive(Debug, Clone, Default)]
pub struct StreamChatOptions {
    /// Temperature for response generation (0.0 - 2.0)
    pub temperature: Option<f32>,
    /// Maximum tokens to generate
    pub max_tokens: Option<u32>,
    /// Stop sequences
    pub stop: Option<Vec<String>>,
    /// Tools available for the model to use
    pub tools: Option<Vec<Tool>>,
    /// Tool choice behavior
    pub tool_choice: Option<ToolChoice>,
}

impl StreamChatOptions {
    /// Create new options with defaults
    pub fn new() -> Self {
        Self::default()
    }

    /// Set temperature
    pub fn with_temperature(mut self, temp: f32) -> Self {
        self.temperature = Some(temp);
        self
    }

    /// Set max tokens
    pub fn with_max_tokens(mut self, tokens: u32) -> Self {
        self.max_tokens = Some(tokens);
        self
    }

    /// Set stop sequences
    pub fn with_stop(mut self, stop: Vec<String>) -> Self {
        self.stop = Some(stop);
        self
    }

    /// Set tools
    pub fn with_tools(mut self, tools: Vec<Tool>) -> Self {
        self.tools = Some(tools);
        self
    }

    /// Set tool choice
    pub fn with_tool_choice(mut self, choice: ToolChoice) -> Self {
        self.tool_choice = Some(choice);
        self
    }
}

/// Type alias for the streaming response
pub type StreamResponse = Pin<Box<dyn Stream<Item = ProviderResult<StreamChunk>> + Send>>;

/// Provider trait for LLM implementations
///
/// Each provider (OpenAI, Anthropic, etc.) implements this trait.
#[async_trait]
pub trait Provider: Send + Sync {
    /// Get the provider name (e.g., "openai", "anthropic")
    fn name(&self) -> &str;

    /// Get the default API base URL
    fn default_api_base(&self) -> &str;

    /// Get provider metadata
    fn metadata(&self) -> ProviderMetadata;

    /// Stream a chat completion
    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        model: ProviderModelConfig,
        options: StreamChatOptions,
        cancel_token: CancellationToken,
    ) -> ProviderResult<StreamResponse>;

    /// Count tokens for text (approximate)
    async fn count_tokens(&self, text: &str) -> ProviderResult<usize>;

    /// Get the API base URL, using custom if provided
    fn get_api_base(&self, model: &ProviderModelConfig) -> String {
        model.api_base.clone().unwrap_or_else(|| self.default_api_base().to_string())
    }
}
