//! Provider error types

use thiserror::Error;

/// Errors that can occur during provider operations
#[derive(Error, Debug)]
pub enum ProviderError {
    /// Missing API key
    #[error("API key is required for {provider}")]
    MissingApiKey { provider: String },

    /// API request failed
    #[error("{provider} API error ({status}): {message}")]
    ApiError {
        provider: String,
        status: u16,
        message: String,
    },

    /// Network/HTTP error
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON parsing error
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// Request was cancelled
    #[error("Request cancelled")]
    Cancelled,

    /// Stream ended unexpectedly
    #[error("Stream ended unexpectedly")]
    StreamEnded,

    /// Invalid response from provider
    #[error("Invalid response from {provider}: {message}")]
    InvalidResponse { provider: String, message: String },

    /// Rate limited
    #[error("{provider} rate limited: {message}")]
    RateLimited { provider: String, message: String },

    /// Other error
    #[error("{0}")]
    Other(String),
}

impl ProviderError {
    /// Create an API error
    pub fn api_error(provider: impl Into<String>, status: u16, message: impl Into<String>) -> Self {
        Self::ApiError {
            provider: provider.into(),
            status,
            message: message.into(),
        }
    }

    /// Create a missing API key error
    pub fn missing_api_key(provider: impl Into<String>) -> Self {
        Self::MissingApiKey {
            provider: provider.into(),
        }
    }

    /// Create an invalid response error
    pub fn invalid_response(provider: impl Into<String>, message: impl Into<String>) -> Self {
        Self::InvalidResponse {
            provider: provider.into(),
            message: message.into(),
        }
    }

    /// Create a rate limited error
    pub fn rate_limited(provider: impl Into<String>, message: impl Into<String>) -> Self {
        Self::RateLimited {
            provider: provider.into(),
            message: message.into(),
        }
    }
}

pub type ProviderResult<T> = Result<T, ProviderError>;
