//! Core types for LLM interactions
//!
//! This module contains all the shared types used across providers.

mod message;
mod model;
mod tool;
mod stream;
mod cancellation;

pub use message::{ChatMessage, ContentPart, MessageRole, MessageContent};
pub use model::{ModelConfig, ModelCapabilities, ProviderConfig, ProviderMetadata, DefaultModel, ConfigSource};
pub use tool::{Tool, ToolCall, ToolResult, ToolChoice};
pub use stream::StreamChunk;
pub use cancellation::CancellationToken;
