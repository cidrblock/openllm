//! MCP-backed config provider
//!
//! Provides config access by calling MCP internal tools
//! (`openllm_config_*`, `openllm_workspace_*`) on a connected MCP server.

use std::sync::Arc;
use serde::{Deserialize, Serialize};

use super::client::McpClient;

/// Provider configuration from VS Code
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub enabled: bool,
    pub models: Vec<String>,
    #[serde(rename = "apiBase", skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(rename = "sourceDetail", skip_serializing_if = "Option::is_none")]
    pub source_detail: Option<String>,
}

#[derive(Deserialize)]
struct ConfigGetResult {
    providers: Vec<ProviderConfig>,
    #[allow(dead_code)]
    scope: String,
}

#[derive(Deserialize)]
struct ConfigSetResult {
    success: bool,
}

#[derive(Deserialize)]
struct WorkspaceRootResult {
    path: Option<String>,
}

/// Errors from MCP config operations
#[derive(Debug, thiserror::Error)]
pub enum McpConfigError {
    #[error("MCP error: {0}")]
    Mcp(String),
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Operation failed")]
    Failed,
}

/// A config provider that uses MCP tools to communicate with VS Code
pub struct McpConfigProvider {
    name: String,
    client: Arc<McpClient>,
}

impl McpConfigProvider {
    /// Create a new MCP config provider
    pub fn new(name: impl Into<String>, client: Arc<McpClient>) -> Self {
        Self {
            name: format!("mcp:{}", name.into()),
            client,
        }
    }

    /// Get the name of this provider
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Get the MCP client
    pub fn client(&self) -> &Arc<McpClient> {
        &self.client
    }

    /// Get all providers at a scope (async)
    pub async fn get_providers_async(
        &self,
        scope: &str,
    ) -> Result<Vec<ProviderConfig>, McpConfigError> {
        let result = self.client
            .call_tool("openllm_config_get", serde_json::json!({
                "provider": "*",
                "scope": scope
            }))
            .await
            .map_err(|e| McpConfigError::Mcp(e.to_string()))?;

        let text = extract_text_content(&result);
        let parsed: ConfigGetResult = serde_json::from_str(&text)
            .map_err(|e| McpConfigError::Parse(e.to_string()))?;

        Ok(parsed.providers)
    }

    /// Get a specific provider at a scope (async)
    pub async fn get_provider_async(
        &self,
        provider: &str,
        scope: &str,
    ) -> Result<Option<ProviderConfig>, McpConfigError> {
        let result = self.client
            .call_tool("openllm_config_get", serde_json::json!({
                "provider": provider,
                "scope": scope
            }))
            .await
            .map_err(|e| McpConfigError::Mcp(e.to_string()))?;

        let text = extract_text_content(&result);
        let parsed: ConfigGetResult = serde_json::from_str(&text)
            .map_err(|e| McpConfigError::Parse(e.to_string()))?;

        Ok(parsed.providers.into_iter().next())
    }

    /// Set provider configuration (async)
    pub async fn set_provider_async(
        &self,
        provider: &str,
        scope: &str,
        enabled: Option<bool>,
        models: Option<Vec<String>>,
        api_base: Option<String>,
    ) -> Result<(), McpConfigError> {
        let mut config = serde_json::Map::new();
        if let Some(e) = enabled {
            config.insert("enabled".to_string(), serde_json::json!(e));
        }
        if let Some(m) = models {
            config.insert("models".to_string(), serde_json::json!(m));
        }
        if let Some(a) = api_base {
            config.insert("apiBase".to_string(), serde_json::json!(a));
        }

        let result = self.client
            .call_tool("openllm_config_set", serde_json::json!({
                "provider": provider,
                "scope": scope,
                "config": config
            }))
            .await
            .map_err(|e| McpConfigError::Mcp(e.to_string()))?;

        let text = extract_text_content(&result);
        let parsed: ConfigSetResult = serde_json::from_str(&text)
            .map_err(|e| McpConfigError::Parse(e.to_string()))?;

        if parsed.success {
            Ok(())
        } else {
            Err(McpConfigError::Failed)
        }
    }

    /// Get the workspace root path (async)
    pub async fn get_workspace_root_async(&self) -> Result<Option<String>, McpConfigError> {
        let result = self.client
            .call_tool("openllm_workspace_root", serde_json::json!({}))
            .await
            .map_err(|e| McpConfigError::Mcp(e.to_string()))?;

        let text = extract_text_content(&result);
        let parsed: WorkspaceRootResult = serde_json::from_str(&text)
            .map_err(|e| McpConfigError::Parse(e.to_string()))?;

        Ok(parsed.path)
    }

    // Sync versions that block on async

    /// Get all providers at a scope (sync)
    pub fn get_providers(&self, scope: &str) -> Result<Vec<ProviderConfig>, McpConfigError> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(self.get_providers_async(scope))
        })
    }

    /// Get a specific provider (sync)
    pub fn get_provider(
        &self,
        provider: &str,
        scope: &str,
    ) -> Result<Option<ProviderConfig>, McpConfigError> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(self.get_provider_async(provider, scope))
        })
    }

    /// Set provider configuration (sync)
    pub fn set_provider(
        &self,
        provider: &str,
        scope: &str,
        enabled: Option<bool>,
        models: Option<Vec<String>>,
        api_base: Option<String>,
    ) -> Result<(), McpConfigError> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(self.set_provider_async(provider, scope, enabled, models, api_base))
        })
    }

    /// Get workspace root (sync)
    pub fn get_workspace_root(&self) -> Result<Option<String>, McpConfigError> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(self.get_workspace_root_async())
        })
    }
}

/// Extract text content from MCP CallToolResult
fn extract_text_content(result: &rmcp::model::CallToolResult) -> String {
    use rmcp::model::RawContent;
    
    result.content.iter()
        .filter_map(|c| {
            match &c.raw {
                RawContent::Text(t) => Some(t.text.clone()),
                _ => None,
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_mcp_config_provider_name() {
        // Can't test without a real MCP client
        assert!(true);
    }
}
