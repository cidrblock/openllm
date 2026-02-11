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
use super::traits::{Provider, ProviderModelConfig, StreamChatOptions, StreamResponse, DynamicModelInfo};

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
            display_name: get_display_name(&self.provider_id),
            default_api_base: self.default_api_base().to_string(),
            requires_api_key: !matches!(self.provider_id.as_str(), "ollama"),
            // Empty - models are fetched dynamically via list_models()
            default_models: vec![],
        }
    }

    async fn list_models(&self, api_key: Option<&str>) -> ProviderResult<Option<Vec<DynamicModelInfo>>> {
        // Build the models endpoint URL based on provider
        let models_url = match self.provider_id.as_str() {
            "openai" => "https://api.openai.com/v1/models",
            "openrouter" => "https://openrouter.ai/api/v1/models",
            "groq" => "https://api.groq.com/openai/v1/models",
            "together" => "https://api.together.xyz/v1/models",
            "fireworks" => "https://api.fireworks.ai/inference/v1/models",
            "mistral" => "https://api.mistral.ai/v1/models",
            "deepseek" => "https://api.deepseek.com/models",
            "xai" => "https://api.x.ai/v1/models",
            "ollama" => "http://localhost:11434/api/tags",
            // These don't have standard /models endpoints - return hardcoded
            "anthropic" => return Ok(Some(get_anthropic_models())),
            "gemini" => return Ok(Some(get_gemini_models())),
            "cohere" => return Ok(Some(get_cohere_models())),
            "azure" => return Ok(None), // Azure requires deployment-specific config
            _ => return Ok(None),
        };

        self.logger.info(&format!(
            "[GenaiProvider] Fetching models from {} for provider {}",
            models_url, self.provider_id
        ));

        let client = reqwest::Client::new();
        let mut request = client.get(models_url);

        // Add auth header if we have an API key
        if let Some(key) = api_key {
            request = request.header("Authorization", format!("Bearer {}", key));
        }

        let response = match request.send().await {
            Ok(r) => r,
            Err(e) => {
                self.logger.warn(&format!(
                    "[GenaiProvider] Failed to fetch models for {}: {}",
                    self.provider_id, e
                ));
                return Ok(None);
            }
        };

        if !response.status().is_success() {
            self.logger.warn(&format!(
                "[GenaiProvider] Models endpoint returned {} for {}",
                response.status(),
                self.provider_id
            ));
            return Ok(None);
        }

        let body = match response.text().await {
            Ok(b) => b,
            Err(e) => {
                self.logger.warn(&format!(
                    "[GenaiProvider] Failed to read models response for {}: {}",
                    self.provider_id, e
                ));
                return Ok(None);
            }
        };

        // Parse based on provider format
        let models = parse_models_response(&self.provider_id, &body);

        self.logger.info(&format!(
            "[GenaiProvider] Found {} models for {}",
            models.len(),
            self.provider_id
        ));

        Ok(Some(models))
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

/// Get display name for a provider
fn get_display_name(provider_id: &str) -> String {
    match provider_id {
        "openai" => "OpenAI".to_string(),
        "anthropic" => "Anthropic".to_string(),
        "gemini" => "Google Gemini".to_string(),
        "ollama" => "Ollama (Local)".to_string(),
        "groq" => "Groq".to_string(),
        "xai" => "xAI (Grok)".to_string(),
        "deepseek" => "DeepSeek".to_string(),
        "cohere" => "Cohere".to_string(),
        "fireworks" => "Fireworks AI".to_string(),
        "together" => "Together AI".to_string(),
        "openrouter" => "OpenRouter".to_string(),
        "mistral" => "Mistral AI".to_string(),
        "azure" => "Azure OpenAI".to_string(),
        "redhat" => "Red Hat AI".to_string(),
        "nebius" => "Nebius AI".to_string(),
        "bigmodel" => "BigModel (ZhipuAI)".to_string(),
        "mimo" => "Mimo AI".to_string(),
        _ => provider_id.to_string(),
    }
}

/// Parse models response based on provider format
fn parse_models_response(provider_id: &str, body: &str) -> Vec<DynamicModelInfo> {
    let json: serde_json::Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    match provider_id {
        // Ollama has a different format
        "ollama" => {
            json["models"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| {
                            let name = m["name"].as_str()?;
                            Some(DynamicModelInfo {
                                id: name.to_string(),
                                name: name.to_string(),
                                context_length: m["details"]["parameter_size"]
                                    .as_str()
                                    .and_then(|s| s.trim_end_matches('B').parse().ok())
                                    .unwrap_or(4096),
                                supports_streaming: true,
                                supports_tools: true,
                                supports_vision: name.contains("vision") || name.contains("llava"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        // OpenRouter has rich metadata
        "openrouter" => {
            json["data"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| {
                            let id = m["id"].as_str()?;
                            Some(DynamicModelInfo {
                                id: id.to_string(),
                                name: m["name"].as_str().unwrap_or(id).to_string(),
                                context_length: m["context_length"].as_u64().unwrap_or(4096) as u32,
                                supports_streaming: true,
                                supports_tools: m["supported_parameters"]
                                    .as_array()
                                    .map(|p| p.iter().any(|v| v.as_str() == Some("tools")))
                                    .unwrap_or(false),
                                supports_vision: m["architecture"]["modality"]
                                    .as_str()
                                    .map(|s| s.contains("image"))
                                    .unwrap_or(false),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
        // Standard OpenAI-compatible format
        _ => {
            json["data"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| {
                            let id = m["id"].as_str()?;
                            // Filter out embedding/audio/etc models for chat providers
                            if id.contains("embedding") || id.contains("whisper") 
                                || id.contains("tts") || id.contains("dall-e") {
                                return None;
                            }
                            Some(DynamicModelInfo {
                                id: id.to_string(),
                                name: id.to_string(),
                                context_length: m["context_window"].as_u64()
                                    .or_else(|| m["context_length"].as_u64())
                                    .unwrap_or(4096) as u32,
                                supports_streaming: true,
                                supports_tools: id.contains("gpt-4") || id.contains("gpt-3.5")
                                    || id.contains("claude") || id.contains("llama"),
                                supports_vision: id.contains("vision") || id.contains("4o")
                                    || id.contains("gpt-4-turbo"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default()
        }
    }
}

/// Anthropic models (no public API for listing)
fn get_anthropic_models() -> Vec<DynamicModelInfo> {
    vec![
        DynamicModelInfo {
            id: "claude-sonnet-4-20250514".to_string(),
            name: "Claude Sonnet 4".to_string(),
            context_length: 200000,
            supports_streaming: true,
            supports_tools: true,
            supports_vision: true,
        },
        DynamicModelInfo {
            id: "claude-3-5-sonnet-20241022".to_string(),
            name: "Claude 3.5 Sonnet".to_string(),
            context_length: 200000,
            supports_streaming: true,
            supports_tools: true,
            supports_vision: true,
        },
        DynamicModelInfo {
            id: "claude-3-5-haiku-20241022".to_string(),
            name: "Claude 3.5 Haiku".to_string(),
            context_length: 200000,
            supports_streaming: true,
            supports_tools: true,
            supports_vision: true,
        },
        DynamicModelInfo {
            id: "claude-3-opus-20240229".to_string(),
            name: "Claude 3 Opus".to_string(),
            context_length: 200000,
            supports_streaming: true,
            supports_tools: true,
            supports_vision: true,
        },
    ]
}

/// Gemini models (no public API for listing)
fn get_gemini_models() -> Vec<DynamicModelInfo> {
    vec![
        DynamicModelInfo {
            id: "gemini-2.0-flash".to_string(),
            name: "Gemini 2.0 Flash".to_string(),
            context_length: 1000000,
            supports_streaming: true,
            supports_tools: true,
            supports_vision: true,
        },
        DynamicModelInfo {
            id: "gemini-1.5-pro".to_string(),
            name: "Gemini 1.5 Pro".to_string(),
            context_length: 2000000,
            supports_streaming: true,
            supports_tools: true,
            supports_vision: true,
        },
        DynamicModelInfo {
            id: "gemini-1.5-flash".to_string(),
            name: "Gemini 1.5 Flash".to_string(),
            context_length: 1000000,
            supports_streaming: true,
            supports_tools: true,
            supports_vision: true,
        },
    ]
}

/// Cohere models (no public API for listing)
fn get_cohere_models() -> Vec<DynamicModelInfo> {
    vec![
        DynamicModelInfo {
            id: "command-r-plus".to_string(),
            name: "Command R+".to_string(),
            context_length: 128000,
            supports_streaming: true,
            supports_tools: true,
            supports_vision: false,
        },
        DynamicModelInfo {
            id: "command-r".to_string(),
            name: "Command R".to_string(),
            context_length: 128000,
            supports_streaming: true,
            supports_tools: true,
            supports_vision: false,
        },
    ]
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
        // Models are now fetched dynamically, so default_models is empty
    }

    #[test]
    fn test_display_name() {
        assert_eq!(get_display_name("openai"), "OpenAI");
        assert_eq!(get_display_name("openrouter"), "OpenRouter");
        assert_eq!(get_display_name("unknown"), "unknown");
    }
}
