//! In-memory configuration provider

use std::sync::RwLock;
use async_trait::async_trait;
use crate::types::ProviderConfig;
use super::traits::{ConfigProvider, ConfigError};

/// In-memory configuration provider for testing
#[derive(Debug, Default)]
pub struct MemoryConfigProvider {
    providers: RwLock<Vec<ProviderConfig>>,
}

impl MemoryConfigProvider {
    /// Create a new empty memory config provider
    pub fn new() -> Self {
        Self {
            providers: RwLock::new(Vec::new()),
        }
    }

    /// Create a memory config provider with initial providers
    pub fn with_providers(providers: Vec<ProviderConfig>) -> Self {
        Self {
            providers: RwLock::new(providers),
        }
    }

    /// Set providers directly (useful for testing)
    pub fn set_providers(&self, providers: Vec<ProviderConfig>) {
        let mut guard = self.providers.write().unwrap();
        *guard = providers;
    }

    /// Clear all providers
    pub fn clear(&self) {
        let mut guard = self.providers.write().unwrap();
        guard.clear();
    }
}

#[async_trait]
impl ConfigProvider for MemoryConfigProvider {
    async fn get_providers(&self) -> Vec<ProviderConfig> {
        let guard = self.providers.read().unwrap();
        guard.clone()
    }

    async fn update_provider(&self, name: &str, config: ProviderConfig) -> Result<(), ConfigError> {
        let mut guard = self.providers.write().unwrap();
        let name_lower = name.to_lowercase();
        
        if let Some(pos) = guard.iter().position(|p| p.name.to_lowercase() == name_lower) {
            guard[pos] = config;
            Ok(())
        } else {
            Err(ConfigError::ProviderNotFound(name.to_string()))
        }
    }

    async fn add_provider(&self, config: ProviderConfig) -> Result<(), ConfigError> {
        let mut guard = self.providers.write().unwrap();
        let name_lower = config.name.to_lowercase();
        
        if guard.iter().any(|p| p.name.to_lowercase() == name_lower) {
            return Err(ConfigError::ProviderExists(config.name.clone()));
        }
        
        guard.push(config);
        Ok(())
    }

    async fn remove_provider(&self, name: &str) -> Result<(), ConfigError> {
        let mut guard = self.providers.write().unwrap();
        let name_lower = name.to_lowercase();
        
        let original_len = guard.len();
        guard.retain(|p| p.name.to_lowercase() != name_lower);
        
        if guard.len() == original_len {
            Err(ConfigError::ProviderNotFound(name.to_string()))
        } else {
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_memory_config_provider() {
        let config = MemoryConfigProvider::new();
        
        // Initially empty
        assert!(config.get_providers().await.is_empty());
        
        // Add a provider
        let openai = ProviderConfig::new("openai")
            .with_models(vec!["gpt-4".to_string()]);
        config.add_provider(openai).await.unwrap();
        
        assert_eq!(config.get_providers().await.len(), 1);
        
        // Can't add duplicate
        let duplicate = ProviderConfig::new("OpenAI"); // case insensitive
        assert!(matches!(
            config.add_provider(duplicate).await,
            Err(ConfigError::ProviderExists(_))
        ));
        
        // Update provider
        let updated = ProviderConfig::new("openai")
            .with_models(vec!["gpt-4".to_string(), "gpt-4-turbo".to_string()]);
        config.update_provider("openai", updated).await.unwrap();
        
        let providers = config.get_providers().await;
        assert_eq!(providers[0].models.len(), 2);
        
        // Remove provider
        config.remove_provider("openai").await.unwrap();
        assert!(config.get_providers().await.is_empty());
        
        // Can't remove non-existent
        assert!(matches!(
            config.remove_provider("openai").await,
            Err(ConfigError::ProviderNotFound(_))
        ));
    }
}
