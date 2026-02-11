//! Unified secret resolution
//!
//! Resolves secrets from:
//! 1. System keychain (explicit lookup)
//! 2. Environment variables (explicit lookup based on config)
//!
//! Note: The automatic env var / .env file searching has been removed.
//! Env vars are now read explicitly when the config specifies api_key_env_var_name.

use std::sync::Arc;
use crate::secrets::{SecretStore, KeychainSecretStore};
use crate::mcp::{McpClient, McpSecretStore};
use crate::logging::file_logger as log;

/// Result of resolving a secret
#[derive(Debug, Clone)]
pub struct ResolvedSecret {
    /// The secret value
    pub value: String,
    /// Which source provided the secret
    pub source: String,
    /// Human-readable source description
    pub source_detail: String,
}

/// Unified secret resolver
pub struct UnifiedSecretResolver {
    /// MCP client for VS Code communication (optional)
    mcp_client: Option<Arc<McpClient>>,
}

impl UnifiedSecretResolver {
    /// Create a new resolver
    pub fn new() -> Self {
        Self {
            mcp_client: None,
        }
    }

    /// Create with an MCP client for VS Code communication
    pub fn with_mcp_client(mcp_client: Arc<McpClient>) -> Self {
        Self {
            mcp_client: Some(mcp_client),
        }
    }

    /// Set the MCP client for VS Code communication
    pub fn set_mcp_client(&mut self, client: Arc<McpClient>) {
        self.mcp_client = Some(client);
    }

    /// Resolve a secret from keychain by name
    pub fn resolve_from_keychain(&self, key_name: &str) -> Option<ResolvedSecret> {
        let keychain_store = KeychainSecretStore::new();
        if keychain_store.is_available() {
            if let Some(value) = keychain_store.get(key_name) {
                return Some(ResolvedSecret {
                    value,
                    source: "keychain".to_string(),
                    source_detail: "System Keychain".to_string(),
                });
            }
        }
        None
    }

    /// Resolve a secret from environment variable by name
    pub fn resolve_from_env(&self, env_var_name: &str) -> Option<ResolvedSecret> {
        if let Ok(value) = std::env::var(env_var_name) {
            if !value.is_empty() {
                return Some(ResolvedSecret {
                    value,
                    source: "env".to_string(),
                    source_detail: format!("Environment variable ${}", env_var_name),
                });
            }
        }
        None
    }

    /// Check if a key exists in keychain
    pub fn has_keychain_key(&self, key_name: &str) -> bool {
        let keychain_store = KeychainSecretStore::new();
        keychain_store.is_available() && keychain_store.has(key_name)
    }

    /// Check if an environment variable exists
    pub fn has_env_var(&self, env_var_name: &str) -> bool {
        std::env::var(env_var_name).map(|v| !v.is_empty()).unwrap_or(false)
    }

    /// Store a secret in keychain
    pub fn store_in_keychain(&self, key_name: &str, value: &str) -> Result<(), String> {
        log::info("SecretResolver", &format!("Storing key '{}' in keychain", key_name));
        let keychain_store = KeychainSecretStore::new();
        if !keychain_store.is_available() {
            return Err("System keychain not available".to_string());
        }
        keychain_store.store(key_name, value).map_err(|e| e.to_string())
    }

    /// Delete a secret from keychain
    pub fn delete_from_keychain(&self, key_name: &str) -> Result<(), String> {
        log::info("SecretResolver", &format!("Deleting key '{}' from keychain", key_name));
        let keychain_store = KeychainSecretStore::new();
        keychain_store.delete(key_name).map_err(|e| e.to_string())
    }

    /// Store a secret via MCP (VS Code)
    pub fn store_via_mcp(&self, key_name: &str, value: &str) -> Result<(), String> {
        if let Some(ref client) = self.mcp_client {
            let mcp_store = McpSecretStore::new("vscode", client.clone());
            mcp_store.store(key_name, value).map_err(|e| e.to_string())
        } else {
            Err("MCP client not available".to_string())
        }
    }

    /// Delete a secret via MCP (VS Code)
    pub fn delete_via_mcp(&self, key_name: &str) -> Result<(), String> {
        if let Some(ref client) = self.mcp_client {
            let mcp_store = McpSecretStore::new("vscode", client.clone());
            mcp_store.delete(key_name).map_err(|e| e.to_string())
        } else {
            Err("MCP client not available".to_string())
        }
    }

    /// List available sources
    pub fn list_sources(&self) -> Vec<(String, bool)> {
        let keychain_store = KeychainSecretStore::new();
        vec![
            ("keychain".to_string(), keychain_store.is_available()),
            ("env".to_string(), true), // env vars are always readable
            ("mcp:vscode".to_string(), self.mcp_client.is_some()),
        ]
    }
}

impl Default for UnifiedSecretResolver {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolver_creation() {
        let resolver = UnifiedSecretResolver::new();
        let sources = resolver.list_sources();
        assert!(!sources.is_empty());
        assert!(sources.iter().any(|(name, _)| name == "keychain"));
        assert!(sources.iter().any(|(name, _)| name == "env"));
    }

    #[test]
    fn test_resolve_from_env() {
        std::env::set_var("TEST_RESOLVER_API_KEY", "test-key-123");
        let resolver = UnifiedSecretResolver::new();
        let result = resolver.resolve_from_env("TEST_RESOLVER_API_KEY");
        assert!(result.is_some());
        assert_eq!(result.unwrap().value, "test-key-123");
        std::env::remove_var("TEST_RESOLVER_API_KEY");
    }

    #[test]
    fn test_has_env_var() {
        std::env::set_var("TEST_HAS_ENV_VAR", "value");
        let resolver = UnifiedSecretResolver::new();
        assert!(resolver.has_env_var("TEST_HAS_ENV_VAR"));
        assert!(!resolver.has_env_var("NONEXISTENT_VAR_XYZ"));
        std::env::remove_var("TEST_HAS_ENV_VAR");
    }
}
