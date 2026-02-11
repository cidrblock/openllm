//! Model and provider configuration types

use serde::{Deserialize, Serialize};

/// Configuration for an individual model
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    /// Unique identifier for this model configuration
    pub id: String,
    /// Display name for the model
    pub name: String,
    /// Provider name (openai, anthropic, google, ollama, etc.)
    pub provider: String,
    /// Model identifier as used by the provider's API
    pub model: String,
    /// API key for authentication (optional, can come from secret store)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Custom API base URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    /// Roles this model can fulfill
    #[serde(default)]
    pub roles: Vec<String>,
    /// Maximum context length in tokens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_length: Option<u32>,
    /// Model capabilities
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ModelCapabilities>,
}

impl ModelConfig {
    /// Create a new model configuration
    pub fn new(id: impl Into<String>, provider: impl Into<String>, model: impl Into<String>) -> Self {
        let id = id.into();
        let model_str = model.into();
        Self {
            name: model_str.clone(),
            id,
            provider: provider.into(),
            model: model_str,
            api_key: None,
            api_base: None,
            roles: vec![],
            context_length: None,
            capabilities: None,
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

    /// Set the context length
    pub fn with_context_length(mut self, length: u32) -> Self {
        self.context_length = Some(length);
        self
    }

    /// Set the capabilities
    pub fn with_capabilities(mut self, capabilities: ModelCapabilities) -> Self {
        self.capabilities = Some(capabilities);
        self
    }
}

/// Model capabilities
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ModelCapabilities {
    /// Whether the model supports image input
    #[serde(default)]
    pub image_input: bool,
    /// Whether the model supports tool/function calling
    #[serde(default)]
    pub tool_calling: bool,
    /// Whether the model supports streaming
    #[serde(default)]
    pub streaming: bool,
}

impl ModelCapabilities {
    /// Create capabilities with all features enabled
    pub fn full() -> Self {
        Self {
            image_input: true,
            tool_calling: true,
            streaming: true,
        }
    }

    /// Create capabilities with just streaming
    pub fn streaming_only() -> Self {
        Self {
            streaming: true,
            ..Default::default()
        }
    }
}

/// Where a provider configuration came from
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConfigSource {
    /// From VS Code user settings (settings.json in user profile)
    VSCodeUser,
    /// From VS Code workspace settings (.vscode/settings.json)
    VSCodeWorkspace,
    /// From user-level config (~/.config/openllm/config.yaml)
    NativeUser,
    /// From workspace-level config (.openllm/config.yaml)
    NativeWorkspace,
    /// From environment or runtime
    Runtime,
    /// Unknown source
    Unknown,
}

impl Default for ConfigSource {
    fn default() -> Self {
        ConfigSource::Unknown
    }
}

impl std::fmt::Display for ConfigSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConfigSource::VSCodeUser => write!(f, "VS Code User Settings"),
            ConfigSource::VSCodeWorkspace => write!(f, "VS Code Workspace Settings"),
            ConfigSource::NativeUser => write!(f, "~/.config/openllm/config.yaml"),
            ConfigSource::NativeWorkspace => write!(f, ".openllm/config.yaml"),
            ConfigSource::Runtime => write!(f, "Runtime"),
            ConfigSource::Unknown => write!(f, "Unknown"),
        }
    }
}

/// Provider configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    /// Provider name (e.g., 'openai', 'anthropic', 'openrouter')
    pub name: String,
    /// Whether this provider is enabled (default: true)
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// Custom API base URL (optional, uses provider default if not set)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    /// List of model names to expose
    #[serde(default)]
    pub models: Vec<String>,
    /// Where this config came from (not serialized to file)
    #[serde(skip)]
    pub source: ConfigSource,
}

fn default_enabled() -> bool {
    true
}

impl ProviderConfig {
    /// Create a new provider configuration
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            enabled: true,
            api_base: None,
            models: vec![],
            source: ConfigSource::Unknown,
        }
    }

    /// Add models to the provider
    pub fn with_models(mut self, models: Vec<String>) -> Self {
        self.models = models;
        self
    }

    /// Set the API base URL
    pub fn with_api_base(mut self, base: impl Into<String>) -> Self {
        self.api_base = Some(base.into());
        self
    }

    /// Disable the provider
    pub fn disabled(mut self) -> Self {
        self.enabled = false;
        self
    }

    /// Set the source of this configuration
    pub fn with_source(mut self, source: ConfigSource) -> Self {
        self.source = source;
        self
    }
}

/// Provider metadata (static information about a provider)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderMetadata {
    /// Provider identifier
    pub id: String,
    /// Display name
    pub display_name: String,
    /// Default API base URL
    pub default_api_base: String,
    /// Whether API key is required
    pub requires_api_key: bool,
    /// Supported models with their context lengths
    pub default_models: Vec<DefaultModel>,
}

/// Default model information for a provider
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DefaultModel {
    /// Model identifier
    pub id: String,
    /// Display name
    pub name: String,
    /// Context length in tokens
    pub context_length: u32,
    /// Model capabilities
    pub capabilities: ModelCapabilities,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_config_builder() {
        let config = ModelConfig::new("gpt4", "openai", "gpt-4")
            .with_api_key("sk-test")
            .with_context_length(8192)
            .with_capabilities(ModelCapabilities::full());

        assert_eq!(config.id, "gpt4");
        assert_eq!(config.provider, "openai");
        assert_eq!(config.model, "gpt-4");
        assert_eq!(config.api_key, Some("sk-test".to_string()));
        assert_eq!(config.context_length, Some(8192));
        assert!(config.capabilities.unwrap().tool_calling);
    }

    #[test]
    fn test_provider_config_serialization() {
        let config = ProviderConfig::new("openai")
            .with_models(vec!["gpt-4".to_string(), "gpt-3.5-turbo".to_string()]);

        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains("\"name\":\"openai\""));
        assert!(json.contains("\"enabled\":true"));
    }
}
