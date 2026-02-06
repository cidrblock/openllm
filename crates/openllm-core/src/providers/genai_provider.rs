//! GenaiProvider - Unified provider using the genai crate
//!
//! This provider handles all genai-supported providers (OpenAI, Anthropic, Gemini, etc.)
//! as well as OpenAI-compatible providers (Azure, OpenRouter, Mistral, Red Hat AI) via
//! the ServiceTargetResolver.

use async_trait::async_trait;
use futures::StreamExt;
use std::sync::Arc;

use genai::chat::{ChatRequest, ChatStreamEvent};

use crate::logging::Logger;
use crate::types::{CancellationToken, ChatMessage, ProviderMetadata, DefaultModel, ModelCapabilities};

use super::error::{ProviderError, ProviderResult};
use super::genai_adapter::{
    create_client, from_genai_event, is_genai_supported, to_genai_messages, to_genai_options,
    to_genai_tools, ProviderConfig,
};
use super::traits::{Provider, ProviderModelConfig, StreamChatOptions, StreamResponse};

/// Unified provider using genai for all supported LLM APIs
pub struct GenaiProvider {
    /// Provider identifier
    provider_id: String,
    /// Logger for debug output
    logger: Arc<dyn Logger>,
}

impl GenaiProvider {
    /// Create a new GenaiProvider
    pub fn new(provider_id: impl Into<String>, logger: Arc<dyn Logger>) -> Self {
        Self {
            provider_id: provider_id.into(),
            logger,
        }
    }
    
    /// Create from a boxed logger (converts to Arc)
    pub fn from_boxed(provider_id: impl Into<String>, logger: Box<dyn Logger>) -> Self {
        Self {
            provider_id: provider_id.into(),
            logger: Arc::from(logger),
        }
    }

    /// Check if this provider can handle the given provider ID
    pub fn supports(provider_id: &str) -> bool {
        is_genai_supported(provider_id)
    }

    /// Extract provider ID from a model string (e.g., "openai/gpt-4" -> "openai")
    pub fn extract_provider(model: &str) -> Option<&str> {
        model.split('/').next()
    }

    /// Extract model name from a model string (e.g., "openai/gpt-4" -> "gpt-4")
    pub fn extract_model_name(model: &str) -> &str {
        model.split('/').nth(1).unwrap_or(model)
    }
}

#[async_trait]
impl Provider for GenaiProvider {
    fn name(&self) -> &str {
        &self.provider_id
    }

    fn default_api_base(&self) -> &str {
        match self.provider_id.as_str() {
            "openai" => "https://api.openai.com/v1/",
            "anthropic" => "https://api.anthropic.com/",
            "gemini" => "https://generativelanguage.googleapis.com/",
            "ollama" => "http://localhost:11434/",
            "groq" => "https://api.groq.com/openai/v1/",
            "xai" => "https://api.x.ai/v1/",
            "deepseek" => "https://api.deepseek.com/",
            "cohere" => "https://api.cohere.ai/",
            "fireworks" => "https://api.fireworks.ai/inference/v1/",
            "together" => "https://api.together.xyz/v1/",
            "openrouter" => "https://openrouter.ai/api/v1/",
            "mistral" => "https://api.mistral.ai/v1/",
            "azure" => "https://your-resource.openai.azure.com/",
            _ => "https://api.openai.com/v1/",
        }
    }

    fn metadata(&self) -> ProviderMetadata {
        ProviderMetadata {
            id: self.provider_id.clone(),
            display_name: self.provider_id.clone(),
            default_api_base: self.default_api_base().to_string(),
            requires_api_key: !matches!(self.provider_id.as_str(), "ollama"),
            default_models: vec![DefaultModel {
                id: "default".to_string(),
                name: "Default Model".to_string(),
                context_length: 128000,
                capabilities: ModelCapabilities {
                    streaming: true,
                    tool_calling: true,
                    image_input: false,
                },
            }],
        }
    }

    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        model_config: ProviderModelConfig,
        options: StreamChatOptions,
        cancel_token: CancellationToken,
    ) -> ProviderResult<StreamResponse> {
        self.logger.info(&format!(
            "[GenaiProvider] stream_chat called: provider={}, model={}",
            self.provider_id, model_config.model
        ));

        // Build provider config for the client
        let config = ProviderConfig {
            provider: self.provider_id.clone(),
            api_key: model_config.api_key.clone(),
            api_base: model_config.api_base.clone(),
        };

        // Create genai client with our resolver
        let client = create_client(&config);

        // Convert messages to genai format
        let genai_messages = to_genai_messages(messages);

        // Build the chat request
        let mut chat_req = ChatRequest::new(genai_messages);

        // Add tools if provided
        if let Some(tools) = &options.tools {
            let genai_tools = to_genai_tools(tools.clone());
            chat_req = chat_req.with_tools(genai_tools);
        }

        // Convert options
        let genai_options = to_genai_options(&options);

        // Extract model name (remove provider prefix if present)
        let model_name = Self::extract_model_name(&model_config.model);

        self.logger.info(&format!(
            "[GenaiProvider] Starting stream for model: {}",
            model_name
        ));

        // Execute streaming chat
        let chat_stream = client
            .exec_chat_stream(model_name, chat_req, Some(&genai_options))
            .await
            .map_err(|e| ProviderError::ApiError {
                status: 500,
                message: e.to_string(),
                provider: self.provider_id.clone(),
            })?;

        self.logger.info("[GenaiProvider] Stream started successfully");

        // Create a stream that converts genai events to our StreamChunk
        let cancel = cancel_token.clone();
        let logger = Arc::clone(&self.logger);
        let provider_id = self.provider_id.clone();

        let stream = chat_stream.stream.filter_map(move |result| {
            let cancel = cancel.clone();
            let logger = Arc::clone(&logger);
            let provider_id = provider_id.clone();

            async move {
                // Check for cancellation
                if cancel.is_cancelled() {
                    logger.info("[GenaiProvider] Stream cancelled");
                    return Some(Err(ProviderError::Cancelled));
                }

                match result {
                    Ok(event) => {
                        // Log the event type for debugging
                        match &event {
                            ChatStreamEvent::Start => {
                                logger.debug("[GenaiProvider] Stream event: Start");
                            }
                            ChatStreamEvent::Chunk(c) => {
                                logger.debug(&format!(
                                    "[GenaiProvider] Stream event: Chunk ({} chars)",
                                    c.content.len()
                                ));
                            }
                            ChatStreamEvent::ToolCallChunk(_) => {
                                logger.debug("[GenaiProvider] Stream event: ToolCallChunk");
                            }
                            ChatStreamEvent::End(_) => {
                                logger.info("[GenaiProvider] Stream event: End");
                            }
                            _ => {}
                        }

                        // Convert to our chunk type
                        from_genai_event(event)
                    }
                    Err(e) => {
                        logger.error(&format!("[GenaiProvider] Stream error: {}", e));
                        Some(Err(ProviderError::ApiError {
                            status: 500,
                            message: e.to_string(),
                            provider: provider_id,
                        }))
                    }
                }
            }
        });

        Ok(Box::pin(stream))
    }

    async fn count_tokens(&self, text: &str) -> ProviderResult<usize> {
        // Approximate token count (4 chars per token is a rough estimate)
        Ok(text.len() / 4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::NoOpLogger;

    #[test]
    fn test_extract_provider() {
        assert_eq!(GenaiProvider::extract_provider("openai/gpt-4"), Some("openai"));
        assert_eq!(
            GenaiProvider::extract_provider("anthropic/claude-3"),
            Some("anthropic")
        );
        assert_eq!(GenaiProvider::extract_provider("gpt-4"), Some("gpt-4"));
    }

    #[test]
    fn test_extract_model_name() {
        assert_eq!(GenaiProvider::extract_model_name("openai/gpt-4"), "gpt-4");
        assert_eq!(
            GenaiProvider::extract_model_name("anthropic/claude-3-opus"),
            "claude-3-opus"
        );
        assert_eq!(GenaiProvider::extract_model_name("gpt-4"), "gpt-4");
    }

    #[test]
    fn test_supports() {
        assert!(GenaiProvider::supports("openai"));
        assert!(GenaiProvider::supports("anthropic"));
        assert!(GenaiProvider::supports("azure"));
        assert!(GenaiProvider::supports("openrouter"));
        assert!(!GenaiProvider::supports("unknown_provider"));
    }

    #[test]
    fn test_metadata() {
        let provider = GenaiProvider::new("openai", Arc::new(NoOpLogger));
        let meta = provider.metadata();
        assert_eq!(meta.id, "openai");
        assert!(!meta.default_models.is_empty());
    }
}
