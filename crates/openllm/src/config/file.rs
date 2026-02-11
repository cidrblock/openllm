//! File-based configuration provider (YAML)
//!
//! Supports user-level (~/.config/openllm/config.yaml) and workspace-level (.config/openllm/config.yaml) config.

use std::path::{Path, PathBuf};
use std::fs;
use std::sync::RwLock;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::types::ProviderConfig;
use super::traits::{ConfigProvider, ConfigError, ConfigResult};

/// Configuration file structure
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ConfigFile {
    /// Configured providers
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    
    /// Default settings
    #[serde(default)]
    pub defaults: Option<DefaultSettings>,
}

/// Default settings for the config
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DefaultSettings {
    /// Default provider name
    pub provider: Option<String>,
    /// Default model name
    pub model: Option<String>,
}

/// Config level (user or workspace)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfigLevel {
    /// User-level config (~/.config/openllm/config.yaml)
    User,
    /// Workspace-level config (.config/openllm/config.yaml in workspace root)
    Workspace,
}

impl ConfigLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConfigLevel::User => "user",
            ConfigLevel::Workspace => "workspace",
        }
    }
}

/// File-based configuration provider
///
/// Reads and writes configuration from YAML files.
/// 
/// # Example
///
/// ```no_run
/// use openllm_core::config::FileConfigProvider;
///
/// // User-level config
/// let user_config = FileConfigProvider::user();
///
/// // Workspace-level config
/// let workspace_config = FileConfigProvider::workspace("/path/to/workspace");
/// ```
pub struct FileConfigProvider {
    path: PathBuf,
    level: ConfigLevel,
    cache: RwLock<Option<ConfigFile>>,
}

impl FileConfigProvider {
    /// Create a new file config provider for a specific path
    pub fn new(path: impl Into<PathBuf>, level: ConfigLevel) -> Self {
        Self {
            path: path.into(),
            level,
            cache: RwLock::new(None),
        }
    }

    /// Create a user-level config provider (~/.config/openllm/config.yaml)
    pub fn user() -> Self {
        // Use XDG config directory (~/.config on Linux, ~/Library/Application Support on macOS)
        let config_dir = dirs::config_dir()
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".config"));
        let path = config_dir.join("openllm").join("config.yaml");
        Self::new(path, ConfigLevel::User)
    }

    /// Create a workspace-level config provider (.config/openllm/config.yaml)
    pub fn workspace(workspace_root: impl AsRef<Path>) -> Self {
        let path = workspace_root.as_ref().join(".config").join("openllm").join("config.yaml");
        Self::new(path, ConfigLevel::Workspace)
    }

    /// Get the config file path
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Get the config level
    pub fn level(&self) -> ConfigLevel {
        self.level
    }

    /// Check if the config file exists
    pub fn exists(&self) -> bool {
        self.path.exists()
    }

    /// Load config from file
    fn load(&self) -> ConfigResult<ConfigFile> {
        if !self.path.exists() {
            return Ok(ConfigFile::default());
        }

        let content = fs::read_to_string(&self.path)?;
        let config: ConfigFile = serde_yaml::from_str(&content)
            .map_err(|e| ConfigError::Other(format!("Failed to parse YAML: {}", e)))?;
        
        Ok(config)
    }

    /// Save config to file
    fn save(&self, config: &ConfigFile) -> ConfigResult<()> {
        // Ensure parent directory exists
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }

        let content = serde_yaml::to_string(config)
            .map_err(|e| ConfigError::Other(format!("Failed to serialize YAML: {}", e)))?;
        
        fs::write(&self.path, content)?;
        
        // Update cache
        let mut cache = self.cache.write().unwrap();
        *cache = Some(config.clone());
        
        Ok(())
    }

    /// Get cached or load config
    fn get_config(&self) -> ConfigResult<ConfigFile> {
        let cache = self.cache.read().unwrap();
        if let Some(config) = cache.as_ref() {
            return Ok(config.clone());
        }
        drop(cache);
        
        let config = self.load()?;
        let mut cache = self.cache.write().unwrap();
        *cache = Some(config.clone());
        Ok(config)
    }

    /// Reload config from disk (invalidate cache)
    pub fn reload(&self) -> ConfigResult<ConfigFile> {
        let config = self.load()?;
        let mut cache = self.cache.write().unwrap();
        *cache = Some(config.clone());
        Ok(config)
    }

    /// Get default settings
    pub fn get_defaults(&self) -> ConfigResult<Option<DefaultSettings>> {
        let config = self.get_config()?;
        Ok(config.defaults)
    }

    /// Set default settings
    pub fn set_defaults(&self, defaults: DefaultSettings) -> ConfigResult<()> {
        let mut config = self.get_config()?;
        config.defaults = Some(defaults);
        self.save(&config)
    }

    /// Create a backup of the current config file
    pub fn backup(&self) -> ConfigResult<Option<PathBuf>> {
        if !self.exists() {
            return Ok(None);
        }

        let backup_path = self.path.with_extension("yaml.backup");
        fs::copy(&self.path, &backup_path)?;
        Ok(Some(backup_path))
    }

    /// Export config to a different format (for migration)
    pub fn export_json(&self) -> ConfigResult<String> {
        let config = self.get_config()?;
        serde_json::to_string_pretty(&config)
            .map_err(|e| ConfigError::Other(format!("Failed to serialize JSON: {}", e)))
    }

    /// Import config from JSON (for migration from VS Code)
    pub fn import_json(&self, json: &str) -> ConfigResult<()> {
        let config: ConfigFile = serde_json::from_str(json)
            .map_err(|e| ConfigError::Other(format!("Failed to parse JSON: {}", e)))?;
        self.save(&config)
    }

    /// Import providers from a list (for migration)
    pub fn import_providers(&self, providers: Vec<ProviderConfig>) -> ConfigResult<()> {
        let mut config = self.get_config()?;
        config.providers = providers;
        self.save(&config)
    }
}

impl std::fmt::Debug for FileConfigProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileConfigProvider")
            .field("path", &self.path)
            .field("level", &self.level)
            .field("exists", &self.exists())
            .finish()
    }
}

use crate::types::ConfigSource;

#[async_trait]
impl ConfigProvider for FileConfigProvider {
    async fn get_providers(&self) -> Vec<ProviderConfig> {
        let source = match self.level {
            ConfigLevel::User => ConfigSource::NativeUser,
            ConfigLevel::Workspace => ConfigSource::NativeWorkspace,
        };
        
        self.get_config()
            .map(|c| {
                c.providers.into_iter()
                    .map(|mut p| {
                        p.source = source.clone();
                        p
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    async fn update_provider(&self, name: &str, config: ProviderConfig) -> ConfigResult<()> {
        let mut file_config = self.get_config()?;
        let name_lower = name.to_lowercase();
        
        if let Some(pos) = file_config.providers.iter().position(|p| p.name.to_lowercase() == name_lower) {
            file_config.providers[pos] = config;
            self.save(&file_config)
        } else {
            Err(ConfigError::ProviderNotFound(name.to_string()))
        }
    }

    async fn add_provider(&self, config: ProviderConfig) -> ConfigResult<()> {
        let mut file_config = self.get_config()?;
        let name_lower = config.name.to_lowercase();
        
        if file_config.providers.iter().any(|p| p.name.to_lowercase() == name_lower) {
            return Err(ConfigError::ProviderExists(config.name.clone()));
        }
        
        file_config.providers.push(config);
        self.save(&file_config)
    }

    async fn remove_provider(&self, name: &str) -> ConfigResult<()> {
        let mut file_config = self.get_config()?;
        let name_lower = name.to_lowercase();
        
        let original_len = file_config.providers.len();
        file_config.providers.retain(|p| p.name.to_lowercase() != name_lower);
        
        if file_config.providers.len() == original_len {
            Err(ConfigError::ProviderNotFound(name.to_string()))
        } else {
            self.save(&file_config)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn test_file_config_provider() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let provider = FileConfigProvider::new(&path, ConfigLevel::User);
        
        // Initially empty
        assert!(!provider.exists());
        assert!(provider.get_providers().await.is_empty());
        
        // Add a provider
        let openai = ProviderConfig::new("openai")
            .with_models(vec!["gpt-4o".to_string()]);
        provider.add_provider(openai).await.unwrap();
        
        // File should exist now
        assert!(provider.exists());
        assert_eq!(provider.get_providers().await.len(), 1);
        
        // Reload and verify persistence
        provider.reload().unwrap();
        assert_eq!(provider.get_providers().await.len(), 1);
    }

    #[tokio::test]
    async fn test_yaml_format() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let provider = FileConfigProvider::new(&path, ConfigLevel::User);
        
        // Add providers
        provider.add_provider(
            ProviderConfig::new("openai")
                .with_models(vec!["gpt-4o".to_string(), "gpt-4o-mini".to_string()])
        ).await.unwrap();
        
        provider.add_provider(
            ProviderConfig::new("anthropic")
                .with_models(vec!["claude-3-5-sonnet-20241022".to_string()])
        ).await.unwrap();
        
        // Check YAML content is readable
        let content = fs::read_to_string(&path).unwrap();
        assert!(content.contains("openai"));
        assert!(content.contains("gpt-4o"));
        assert!(content.contains("anthropic"));
    }

    #[test]
    fn test_backup() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("config.yaml");
        let provider = FileConfigProvider::new(&path, ConfigLevel::User);
        
        // No backup if file doesn't exist
        assert!(provider.backup().unwrap().is_none());
        
        // Create file
        fs::write(&path, "providers: []").unwrap();
        
        // Backup should work
        let backup_path = provider.backup().unwrap().unwrap();
        assert!(backup_path.exists());
        assert!(backup_path.to_string_lossy().contains("backup"));
    }
}
