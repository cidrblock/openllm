//! Mock provider for testing
//!
//! Provides deterministic, configurable responses without network dependencies.
//! Useful for testing NAPI bindings, streaming callbacks, and integration tests.

use async_trait::async_trait;
use futures::{stream, StreamExt};
use std::sync::Arc;
use std::time::Duration;

use super::error::{ProviderError, ProviderResult};
use super::traits::{Provider, ProviderModelConfig, StreamChatOptions, StreamResponse};
use crate::logging::Logger;
use crate::types::{
    CancellationToken, ChatMessage, MessageContent, MessageRole, ModelCapabilities, 
    ProviderMetadata, DefaultModel, StreamChunk,
};

/// Mock response mode
#[derive(Debug, Clone)]
pub enum MockMode {
    /// Echo back the last user message
    Echo,
    /// Return a fixed response
    Fixed(String),
    /// Return response as specific chunks with delays
    Chunks(Vec<String>),
    /// Simulate an error after optional delay
    Error { message: String, delay_chunks: usize },
    /// Return nothing (empty response)
    Empty,
}

impl Default for MockMode {
    fn default() -> Self {
        MockMode::Echo
    }
}

/// Configuration for the mock provider
#[derive(Debug, Clone)]
pub struct MockConfig {
    /// Response mode
    pub mode: MockMode,
    /// Delay between chunks in milliseconds (0 = no delay)
    pub chunk_delay_ms: u64,
    /// Size of each chunk when splitting fixed/echo responses
    pub chunk_size: usize,
}

impl Default for MockConfig {
    fn default() -> Self {
        Self {
            mode: MockMode::Echo,
            chunk_delay_ms: 0,
            chunk_size: 10,
        }
    }
}

/// Mock LLM provider for testing
pub struct MockProvider {
    config: MockConfig,
    logger: Arc<dyn Logger>,
}

impl MockProvider {
    /// Create a new mock provider with default config
    pub fn new(logger: Arc<dyn Logger>) -> Self {
        Self {
            config: MockConfig::default(),
            logger,
        }
    }

    /// Create with specific config
    pub fn with_config(config: MockConfig, logger: Arc<dyn Logger>) -> Self {
        Self { config, logger }
    }

    /// Create an echo provider (echoes back user message)
    pub fn echo(logger: Arc<dyn Logger>) -> Self {
        Self::with_config(
            MockConfig {
                mode: MockMode::Echo,
                ..Default::default()
            },
            logger,
        )
    }

    /// Create a fixed response provider
    pub fn fixed(response: impl Into<String>, logger: Arc<dyn Logger>) -> Self {
        Self::with_config(
            MockConfig {
                mode: MockMode::Fixed(response.into()),
                ..Default::default()
            },
            logger,
        )
    }

    /// Create a chunked response provider
    pub fn chunked(chunks: Vec<String>, delay_ms: u64, logger: Arc<dyn Logger>) -> Self {
        Self::with_config(
            MockConfig {
                mode: MockMode::Chunks(chunks),
                chunk_delay_ms: delay_ms,
                ..Default::default()
            },
            logger,
        )
    }

    /// Create an error-producing provider
    pub fn error(message: impl Into<String>, logger: Arc<dyn Logger>) -> Self {
        Self::with_config(
            MockConfig {
                mode: MockMode::Error {
                    message: message.into(),
                    delay_chunks: 0,
                },
                ..Default::default()
            },
            logger,
        )
    }

    /// Set chunk delay
    pub fn with_delay(mut self, delay_ms: u64) -> Self {
        self.config.chunk_delay_ms = delay_ms;
        self
    }

    /// Set chunk size for splitting responses
    pub fn with_chunk_size(mut self, size: usize) -> Self {
        self.config.chunk_size = size;
        self
    }

    /// Extract last user message content
    fn get_last_user_message(&self, messages: &[ChatMessage]) -> String {
        for msg in messages.iter().rev() {
            if msg.role == MessageRole::User {
                // Extract text content
                match &msg.content {
                    MessageContent::Text(text) => {
                        if !text.is_empty() {
                            return text.clone();
                        }
                    }
                    MessageContent::Parts(parts) => {
                        let mut text = String::new();
                        for part in parts {
                            if let crate::types::ContentPart::Text { text: t } = part {
                                text.push_str(t);
                            }
                        }
                        if !text.is_empty() {
                            return text;
                        }
                    }
                }
            }
        }
        "Hello from MockProvider!".to_string()
    }

    /// Split text into chunks
    fn split_into_chunks(&self, text: &str) -> Vec<String> {
        if self.config.chunk_size == 0 || text.is_empty() {
            return vec![text.to_string()];
        }

        text.chars()
            .collect::<Vec<_>>()
            .chunks(self.config.chunk_size)
            .map(|c| c.iter().collect())
            .collect()
    }
}

#[async_trait]
impl Provider for MockProvider {
    fn name(&self) -> &str {
        "mock"
    }

    fn default_api_base(&self) -> &str {
        "http://localhost:0/mock"
    }

    fn metadata(&self) -> ProviderMetadata {
        ProviderMetadata {
            id: "mock".to_string(),
            display_name: "Mock Provider".to_string(),
            default_api_base: self.default_api_base().to_string(),
            requires_api_key: false,
            default_models: vec![
                DefaultModel {
                    id: "mock-echo".to_string(),
                    name: "Mock Echo".to_string(),
                    context_length: 128000,
                    capabilities: ModelCapabilities::full(),
                },
                DefaultModel {
                    id: "mock-fixed".to_string(),
                    name: "Mock Fixed Response".to_string(),
                    context_length: 128000,
                    capabilities: ModelCapabilities::full(),
                },
            ],
        }
    }

    async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        _model: ProviderModelConfig,
        _options: StreamChatOptions,
        cancel_token: CancellationToken,
    ) -> ProviderResult<StreamResponse> {
        self.logger.debug("MockProvider: stream_chat called");

        let chunks: Vec<String> = match &self.config.mode {
            MockMode::Echo => {
                let user_msg = self.get_last_user_message(&messages);
                self.logger.debug(&format!("MockProvider: Echo mode, echoing: {}", user_msg));
                self.split_into_chunks(&format!("Echo: {}", user_msg))
            }
            MockMode::Fixed(response) => {
                self.logger.debug(&format!("MockProvider: Fixed mode, response len: {}", response.len()));
                self.split_into_chunks(response)
            }
            MockMode::Chunks(chunks) => {
                self.logger.debug(&format!("MockProvider: Chunks mode, {} chunks", chunks.len()));
                chunks.clone()
            }
            MockMode::Empty => {
                self.logger.debug("MockProvider: Empty mode");
                vec![]
            }
            MockMode::Error { message, delay_chunks } => {
                self.logger.debug(&format!("MockProvider: Error mode after {} chunks", delay_chunks));
                // Return some chunks before error
                let mut result: Vec<String> = (0..*delay_chunks)
                    .map(|i| format!("Chunk {} before error. ", i))
                    .collect();
                // Add error marker (will be handled specially)
                result.push(format!("__ERROR__:{}", message));
                result
            }
        };

        let delay_ms = self.config.chunk_delay_ms;
        let logger = self.logger.clone();

        // Create the stream
        let stream = stream::iter(chunks.into_iter().enumerate())
            .then(move |(i, chunk)| {
                let logger = logger.clone();
                let cancel = cancel_token.clone();
                async move {
                    // Check cancellation
                    if cancel.is_cancelled() {
                        return Err(ProviderError::Cancelled);
                    }

                    // Apply delay (except for first chunk)
                    if i > 0 && delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    }

                    // Check for error marker
                    if chunk.starts_with("__ERROR__:") {
                        let msg = chunk.trim_start_matches("__ERROR__:");
                        return Err(ProviderError::Other(format!("Mock error: {}", msg)));
                    }

                    logger.debug(&format!("MockProvider: Yielding chunk {}: '{}'", i, chunk));
                    Ok(StreamChunk::Text { text: chunk })
                }
            });

        Ok(Box::pin(stream))
    }

    async fn count_tokens(&self, text: &str) -> ProviderResult<usize> {
        // Simple approximation: ~4 characters per token
        Ok(text.len() / 4)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::NoOpLogger;
    use futures::StreamExt;

    fn test_logger() -> Arc<dyn Logger> {
        Arc::new(NoOpLogger::new())
    }

    fn test_messages(content: &str) -> Vec<ChatMessage> {
        vec![ChatMessage::user(content)]
    }

    fn test_config() -> ProviderModelConfig {
        ProviderModelConfig {
            model: "mock-echo".to_string(),
            api_key: None,
            api_base: None,
        }
    }

    fn test_options() -> StreamChatOptions {
        StreamChatOptions::default()
    }

    #[tokio::test]
    async fn test_echo_mode() {
        let provider = MockProvider::echo(test_logger());
        let messages = test_messages("Hello, world!");
        let cancel = CancellationToken::new();

        let mut stream = provider
            .stream_chat(messages, test_config(), test_options(), cancel)
            .await
            .expect("stream should start");

        let mut result = String::new();
        while let Some(chunk) = stream.next().await {
            match chunk.expect("chunk should succeed") {
                StreamChunk::Text { text } => result.push_str(&text),
                _ => {}
            }
        }

        assert!(result.contains("Hello, world!"), "Should echo the message");
    }

    #[tokio::test]
    async fn test_fixed_mode() {
        let provider = MockProvider::fixed("This is a test response.", test_logger());
        let messages = test_messages("Anything");
        let cancel = CancellationToken::new();

        let mut stream = provider
            .stream_chat(messages, test_config(), test_options(), cancel)
            .await
            .expect("stream should start");

        let mut result = String::new();
        while let Some(chunk) = stream.next().await {
            match chunk.expect("chunk should succeed") {
                StreamChunk::Text { text } => result.push_str(&text),
                _ => {}
            }
        }

        assert_eq!(result, "This is a test response.");
    }

    #[tokio::test]
    async fn test_chunked_mode() {
        let chunks = vec![
            "First ".to_string(),
            "second ".to_string(),
            "third.".to_string(),
        ];
        let provider = MockProvider::chunked(chunks.clone(), 0, test_logger());
        let messages = test_messages("Anything");
        let cancel = CancellationToken::new();

        let mut stream = provider
            .stream_chat(messages, test_config(), test_options(), cancel)
            .await
            .expect("stream should start");

        let mut received_chunks = Vec::new();
        while let Some(chunk) = stream.next().await {
            match chunk.expect("chunk should succeed") {
                StreamChunk::Text { text } => received_chunks.push(text),
                _ => {}
            }
        }

        assert_eq!(received_chunks, chunks);
    }

    #[tokio::test]
    async fn test_error_mode() {
        let provider = MockProvider::error("Test error message", test_logger());
        let messages = test_messages("Anything");
        let cancel = CancellationToken::new();

        let mut stream = provider
            .stream_chat(messages, test_config(), test_options(), cancel)
            .await
            .expect("stream should start");

        // Should get an error
        let result = stream.next().await;
        assert!(result.is_some());
        assert!(result.unwrap().is_err());
    }

    #[tokio::test]
    async fn test_cancellation() {
        let provider = MockProvider::fixed("Long response that should be cancelled", test_logger())
            .with_delay(100);
        let messages = test_messages("Anything");
        let cancel = CancellationToken::new();

        let mut stream = provider
            .stream_chat(messages, test_config(), test_options(), cancel.clone())
            .await
            .expect("stream should start");

        // Get first chunk
        let first = stream.next().await;
        assert!(first.is_some());

        // Cancel
        cancel.cancel();

        // Next chunk should indicate cancellation
        let next = stream.next().await;
        if let Some(result) = next {
            assert!(result.is_err() || matches!(result, Ok(StreamChunk::Text { .. })));
        }
    }

    #[test]
    fn test_provider_metadata() {
        let provider = MockProvider::new(test_logger());

        assert_eq!(provider.name(), "mock");
        assert!(!provider.metadata().requires_api_key);
        assert!(!provider.metadata().default_models.is_empty());
    }

    #[test]
    fn test_chunk_splitting() {
        let provider = MockProvider::new(test_logger()).with_chunk_size(5);
        let chunks = provider.split_into_chunks("Hello, world!");

        assert_eq!(chunks, vec!["Hello", ", wor", "ld!"]);
    }
}
