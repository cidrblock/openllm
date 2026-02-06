//! LLM Provider implementations
//!
//! This module contains provider abstractions and implementations for various LLM APIs.
//!
//! ## Architecture
//!
//! All providers use the `genai` crate, which handles:
//! - Streaming SSE parsing
//! - Provider-specific protocols (OpenAI, Anthropic, Gemini, etc.)
//! - Tool calling
//! - Error handling
//!
//! Providers not natively in genai (Azure, OpenRouter, Mistral, Red Hat AI) are
//! handled via genai's `ServiceTargetResolver` using OpenAI-compatible protocols.
//!
//! Auth flows through our `UnifiedSecretResolver`, not genai's env var lookup.
//!
//! The `MockProvider` is kept for testing purposes.

mod traits;
mod error;
mod genai_adapter;
mod genai_provider;
mod mock;

// Core traits and types
pub use traits::{Provider, ProviderModelConfig, StreamChatOptions, StreamResponse};
pub use error::{ProviderError, ProviderResult};

// The main provider - handles all LLM providers via genai
pub use genai_provider::GenaiProvider;
pub use genai_adapter::{is_genai_native, is_genai_supported, ProviderConfig};

// Mock provider for testing
pub use mock::{MockProvider, MockConfig, MockMode};

// Re-export for convenience
pub use crate::types::{ChatMessage, StreamChunk, Tool, ToolChoice, CancellationToken};

use crate::logging::Logger;
use std::sync::Arc;

/// Create a provider for the given provider ID
///
/// This factory function creates the appropriate provider based on the provider ID.
/// Most providers use the unified `GenaiProvider`, while `mock` uses `MockProvider`.
pub fn create_provider(provider_id: &str, logger: Arc<dyn Logger>) -> Box<dyn Provider> {
    match provider_id.to_lowercase().as_str() {
        "mock" => Box::new(MockProvider::echo(Arc::clone(&logger))),
        _ if GenaiProvider::supports(provider_id) => {
            Box::new(GenaiProvider::new(provider_id, Arc::clone(&logger)))
        }
        _ => {
            // Default to GenaiProvider with OpenAI adapter for unknown providers
            // This allows custom OpenAI-compatible endpoints to work
            Box::new(GenaiProvider::new(provider_id, logger))
        }
    }
}

/// List all supported provider IDs
pub fn supported_providers() -> Vec<&'static str> {
    vec![
        // Native genai providers
        "openai",
        "anthropic",
        "gemini",
        "ollama",
        "groq",
        "xai",
        "deepseek",
        "cohere",
        "fireworks",
        "together",
        "nebius",
        "mimo",
        "zai",
        "bigmodel",
        // OpenAI-compatible providers via resolver
        "azure",
        "openrouter",
        "mistral",
        "redhat",
        // Testing
        "mock",
    ]
}
