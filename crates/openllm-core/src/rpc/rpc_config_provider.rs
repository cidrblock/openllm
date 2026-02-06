//! RPC-backed config provider
//!
//! Implements config access by making JSON-RPC calls to an external
//! provider (like VS Code).

use super::client::RpcClient;
use super::endpoint::RpcEndpoint;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A config provider that uses JSON-RPC to communicate with an external provider
pub struct RpcConfigProvider {
    name: String,
    client: RpcClient,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub name: String,
    pub enabled: bool,
    pub models: Vec<String>,
    #[serde(rename = "apiBase", skip_serializing_if = "Option::is_none")]
    pub api_base: Option<String>,
    pub source: String,
    #[serde(rename = "sourceDetail")]
    pub source_detail: String,
}

#[derive(Serialize)]
struct ConfigGetParams {
    provider: String,
    scope: String,
    #[serde(rename = "workspacePath", skip_serializing_if = "Option::is_none")]
    workspace_path: Option<String>,
}

#[derive(Deserialize)]
struct ConfigGetResult {
    providers: Vec<ProviderConfig>,
}

#[derive(Serialize)]
struct ConfigSetParams {
    provider: String,
    scope: String,
    #[serde(rename = "workspacePath", skip_serializing_if = "Option::is_none")]
    workspace_path: Option<String>,
    config: ConfigSetData,
}

#[derive(Serialize)]
struct ConfigSetData {
    #[serde(skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    models: Option<Vec<String>>,
    #[serde(rename = "apiBase", skip_serializing_if = "Option::is_none")]
    api_base: Option<String>,
}

#[derive(Deserialize)]
struct ConfigSetResult {
    success: bool,
}

#[derive(Serialize)]
struct SettingsGetParams {
    scope: String,
}

#[derive(Deserialize)]
pub struct Settings {
    #[serde(rename = "configSource")]
    pub config_source: Option<String>,
    #[serde(rename = "secretsSource")]
    pub secrets_source: Option<String>,
}

#[derive(Deserialize)]
struct SettingsGetResult {
    settings: Settings,
}

#[derive(Serialize)]
struct WorkspaceParams {}

#[derive(Deserialize)]
struct WorkspaceRootResult {
    path: Option<String>,
}

#[derive(Deserialize)]
struct WorkspacePathsResult {
    paths: Vec<String>,
}

/// Errors from RPC config operations
#[derive(Debug, thiserror::Error)]
pub enum RpcConfigError {
    #[error("RPC error: {0}")]
    Rpc(String),
    #[error("Operation failed")]
    Failed,
}

impl RpcConfigProvider {
    /// Create a new RPC config provider from an endpoint
    pub fn new(endpoint: &RpcEndpoint) -> Self {
        Self {
            name: format!("rpc:{}", endpoint.name),
            client: RpcClient::new(
                endpoint.socket_path.to_string_lossy().to_string(),
                endpoint.auth_token.clone(),
            ),
        }
    }

    /// Create from socket path and auth token directly
    pub fn from_parts(
        name: impl Into<String>,
        socket_path: impl Into<String>,
        auth_token: impl Into<String>,
    ) -> Self {
        let name_str = name.into();
        Self {
            name: format!("rpc:{}", name_str),
            client: RpcClient::new(socket_path, auth_token),
        }
    }

    /// Get the name of this provider
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Check if the RPC endpoint is reachable
    pub fn is_reachable(&self) -> bool {
        self.client.ping().unwrap_or(false)
    }

    /// Get all providers at a scope
    pub fn get_providers(
        &self,
        scope: &str,
        workspace_path: Option<&Path>,
    ) -> Result<Vec<ProviderConfig>, RpcConfigError> {
        let result: ConfigGetResult = self
            .client
            .call(
                "config/get",
                ConfigGetParams {
                    provider: "*".to_string(),
                    scope: scope.to_string(),
                    workspace_path: workspace_path.map(|p| p.to_string_lossy().to_string()),
                },
            )
            .map_err(|e| RpcConfigError::Rpc(e.to_string()))?;
        Ok(result.providers)
    }

    /// Get a specific provider at a scope
    pub fn get_provider(
        &self,
        provider: &str,
        scope: &str,
        workspace_path: Option<&Path>,
    ) -> Result<Option<ProviderConfig>, RpcConfigError> {
        let result: ConfigGetResult = self
            .client
            .call(
                "config/get",
                ConfigGetParams {
                    provider: provider.to_string(),
                    scope: scope.to_string(),
                    workspace_path: workspace_path.map(|p| p.to_string_lossy().to_string()),
                },
            )
            .map_err(|e| RpcConfigError::Rpc(e.to_string()))?;
        Ok(result.providers.into_iter().next())
    }

    /// Set provider configuration
    pub fn set_provider(
        &self,
        provider: &str,
        scope: &str,
        workspace_path: Option<&Path>,
        enabled: Option<bool>,
        models: Option<Vec<String>>,
        api_base: Option<String>,
    ) -> Result<(), RpcConfigError> {
        let result: ConfigSetResult = self
            .client
            .call(
                "config/set",
                ConfigSetParams {
                    provider: provider.to_string(),
                    scope: scope.to_string(),
                    workspace_path: workspace_path.map(|p| p.to_string_lossy().to_string()),
                    config: ConfigSetData {
                        enabled,
                        models,
                        api_base,
                    },
                },
            )
            .map_err(|e| RpcConfigError::Rpc(e.to_string()))?;

        if result.success {
            Ok(())
        } else {
            Err(RpcConfigError::Failed)
        }
    }

    /// Get OpenLLM settings
    pub fn get_settings(&self, scope: &str) -> Result<Settings, RpcConfigError> {
        let result: SettingsGetResult = self
            .client
            .call(
                "config/getSettings",
                SettingsGetParams {
                    scope: scope.to_string(),
                },
            )
            .map_err(|e| RpcConfigError::Rpc(e.to_string()))?;
        Ok(result.settings)
    }

    /// Get the workspace root path
    pub fn get_workspace_root(&self) -> Result<Option<String>, RpcConfigError> {
        let result: WorkspaceRootResult = self
            .client
            .call("workspace/getRoot", WorkspaceParams {})
            .map_err(|e| RpcConfigError::Rpc(e.to_string()))?;
        Ok(result.path)
    }

    /// Get all workspace paths (for multi-root workspaces)
    pub fn get_workspace_paths(&self) -> Result<Vec<String>, RpcConfigError> {
        let result: WorkspacePathsResult = self
            .client
            .call("workspace/getPaths", WorkspaceParams {})
            .map_err(|e| RpcConfigError::Rpc(e.to_string()))?;
        Ok(result.paths)
    }
    
    // ==================== ASYNC API ====================
    
    /// Async check if reachable
    pub async fn is_reachable_async(&self) -> bool {
        self.client.ping_async().await.unwrap_or(false)
    }
    
    /// Async get all providers at a scope
    pub async fn get_providers_async(
        &self,
        scope: &str,
        workspace_path: Option<&Path>,
    ) -> Result<Vec<ProviderConfig>, RpcConfigError> {
        let result: ConfigGetResult = self
            .client
            .call_async(
                "config/get",
                ConfigGetParams {
                    provider: "*".to_string(),
                    scope: scope.to_string(),
                    workspace_path: workspace_path.map(|p| p.to_string_lossy().to_string()),
                },
            )
            .await
            .map_err(|e| RpcConfigError::Rpc(e.to_string()))?;
        Ok(result.providers)
    }
    
    /// Async set provider configuration
    pub async fn set_provider_async(
        &self,
        provider: &str,
        scope: &str,
        workspace_path: Option<&Path>,
        enabled: Option<bool>,
        models: Option<Vec<String>>,
        api_base: Option<String>,
    ) -> Result<(), RpcConfigError> {
        let result: ConfigSetResult = self
            .client
            .call_async(
                "config/set",
                ConfigSetParams {
                    provider: provider.to_string(),
                    scope: scope.to_string(),
                    workspace_path: workspace_path.map(|p| p.to_string_lossy().to_string()),
                    config: ConfigSetData {
                        enabled,
                        models,
                        api_base,
                    },
                },
            )
            .await
            .map_err(|e| RpcConfigError::Rpc(e.to_string()))?;

        if result.success {
            Ok(())
        } else {
            Err(RpcConfigError::Failed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rpc_config_provider_name() {
        let endpoint = RpcEndpoint::new(
            "vscode",
            "/tmp/test.sock",
            "token",
            vec!["config".to_string()],
        );
        let provider = RpcConfigProvider::new(&endpoint);
        assert_eq!(provider.name(), "rpc:vscode");
    }
}
