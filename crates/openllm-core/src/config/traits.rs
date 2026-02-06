//! Configuration provider trait

use async_trait::async_trait;
use crate::types::ProviderConfig;

/// Configuration provider abstraction
///
/// Implementations:
/// - `MemoryConfigProvider`: In-memory for testing
/// - VS Code adapter: Reads from vscode.workspace.getConfiguration()
/// - File-based: Reads from YAML file (~/.config/openllm/config.yaml)
#[async_trait]
pub trait ConfigProvider: Send + Sync {
    /// Get all configured providers
    async fn get_providers(&self) -> Vec<ProviderConfig>;

    /// Update a provider's configuration
    async fn update_provider(&self, name: &str, config: ProviderConfig) -> Result<(), ConfigError>;

    /// Add a new provider
    async fn add_provider(&self, config: ProviderConfig) -> Result<(), ConfigError>;

    /// Remove a provider
    async fn remove_provider(&self, name: &str) -> Result<(), ConfigError>;
}

/// Errors that can occur during configuration operations
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("Provider not found: {0}")]
    ProviderNotFound(String),

    #[error("Provider already exists: {0}")]
    ProviderExists(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Configuration error: {0}")]
    Other(String),
}

pub type ConfigResult<T> = Result<T, ConfigError>;
