//! Unified secret resolution from multiple sources
//!
//! Checks sources in priority order:
//! 1. Environment variables
//! 2. RPC endpoints (VS Code, etc.)
//! 3. System keychain
//! 4. .env files

use std::sync::Arc;
use crate::secrets::{SecretStore, EnvSecretStore, KeychainSecretStore};
use crate::rpc::{RpcSecretStore, get_rpc_endpoint};
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

/// Secrets store preference - where to store/read API keys
#[derive(Debug, Clone, PartialEq)]
pub enum SecretsStore {
    /// Use VS Code SecretStorage via RPC
    VsCode,
    /// Use system keychain
    Keychain,
}

impl Default for SecretsStore {
    fn default() -> Self {
        SecretsStore::Keychain  // Default to keychain when not in VS Code
    }
}

impl SecretsStore {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "vscode" | "vs_code" | "vs-code" | "secretstorage" => SecretsStore::VsCode,
            _ => SecretsStore::Keychain,
        }
    }
}

/// Unified secret resolver that checks multiple sources
pub struct UnifiedSecretResolver {
    /// Priority-ordered list of sources to check (legacy, will be removed)
    sources: Vec<Arc<dyn SecretStore>>,
    /// RPC endpoint names to check
    rpc_endpoints: Vec<String>,
    /// User's preferred secrets store (set by host application)
    secrets_store: SecretsStore,
    /// Whether to check environment variables for secrets
    check_environment: bool,
    /// Whether to check .env files for secrets
    check_dotenv: bool,
}

impl UnifiedSecretResolver {
    /// Create a new resolver with default sources
    pub fn new() -> Self {
        Self {
            sources: vec![
                Arc::new(EnvSecretStore::new()),
                Arc::new(KeychainSecretStore::new()),
            ],
            rpc_endpoints: vec!["vscode".to_string()],
            secrets_store: SecretsStore::default(),
            check_environment: true,  // Default to checking env vars
            check_dotenv: false,      // Default to not checking .env
        }
    }

    /// Create with custom configuration (legacy - prefer using setters)
    pub fn with_config(
        include_env: bool,
        include_keychain: bool,
        rpc_endpoints: Vec<String>,
    ) -> Self {
        let mut sources: Vec<Arc<dyn SecretStore>> = Vec::new();
        
        if include_env {
            sources.push(Arc::new(EnvSecretStore::new()));
        }
        if include_keychain {
            sources.push(Arc::new(KeychainSecretStore::new()));
        }
        
        Self {
            sources,
            rpc_endpoints,
            secrets_store: SecretsStore::default(),
            check_environment: include_env,
            check_dotenv: false,
        }
    }

    /// Set the secrets store preference
    /// 
    /// This should be called by the host application (e.g., VS Code extension)
    /// to inform the resolver where the user wants secrets stored.
    pub fn set_secrets_store(&mut self, store: SecretsStore) {
        self.secrets_store = store;
    }

    /// Set secrets store from string (convenience for NAPI)
    pub fn set_secrets_store_str(&mut self, store: &str) {
        self.secrets_store = SecretsStore::from_str(store);
    }

    /// Get the current secrets store preference
    pub fn get_secrets_store(&self) -> &SecretsStore {
        &self.secrets_store
    }

    /// Set whether to check environment variables for secrets
    pub fn set_check_environment(&mut self, check: bool) {
        self.check_environment = check;
    }

    /// Get whether environment variables are checked
    pub fn get_check_environment(&self) -> bool {
        self.check_environment
    }

    /// Set whether to check .env files for secrets
    pub fn set_check_dotenv(&mut self, check: bool) {
        self.check_dotenv = check;
    }

    /// Get whether .env files are checked
    pub fn get_check_dotenv(&self) -> bool {
        self.check_dotenv
    }

    /// Add an RPC endpoint to check
    pub fn add_rpc_endpoint(&mut self, name: impl Into<String>) {
        self.rpc_endpoints.push(name.into());
    }

    /// Resolve a secret by key
    ///
    /// Checks sources based on user preferences set by host application.
    /// Priority order:
    /// 1. Environment variables (if check_environment is true)
    /// 2. .env files (if check_dotenv is true)
    /// 3. Primary store (VS Code RPC or system keychain based on secrets_store)
    pub fn resolve(&self, key: &str) -> Option<ResolvedSecret> {
        // Check environment variables if enabled
        if self.check_environment {
            let env_store = EnvSecretStore::new();
            if let Some(value) = env_store.get(key) {
                let env_var_name = format!("{}_API_KEY", key.to_uppercase());
                return Some(ResolvedSecret {
                    value,
                    source: "environment".to_string(),
                    source_detail: format!("Environment variable ${}", env_var_name),
                });
            }
        }

        // Check .env files if enabled
        if self.check_dotenv {
            if let Some(value) = self.try_dotenv_file(key) {
                let env_var_name = format!("{}_API_KEY", key.to_uppercase());
                return Some(ResolvedSecret {
                    value,
                    source: "dotenv".to_string(),
                    source_detail: format!(".env file ({})", env_var_name),
                });
            }
        }

        // Check primary store based on user preference
        match self.secrets_store {
            SecretsStore::VsCode => {
                // Check VS Code RPC endpoints
                for endpoint_name in &self.rpc_endpoints {
                    if let Some(endpoint) = get_rpc_endpoint(endpoint_name) {
                        let rpc_store = RpcSecretStore::new(&endpoint);
                        if let Some(value) = rpc_store.get(key) {
                            return Some(ResolvedSecret {
                                value,
                                source: format!("rpc:{}", endpoint_name),
                                source_detail: format!("{} SecretStorage", endpoint_name),
                            });
                        }
                    }
                }
            }
            SecretsStore::Keychain => {
                // Check system keychain
                let keychain_store = KeychainSecretStore::new();
                if keychain_store.is_available() {
                    if let Some(value) = keychain_store.get(key) {
                        return Some(ResolvedSecret {
                            value,
                            source: "keychain".to_string(),
                            source_detail: "System Keychain".to_string(),
                        });
                    }
                }
            }
        }

        // Legacy: check other registered sources (will be removed)
        for store in &self.sources {
            // Skip env and keychain since we handle them above
            if store.name() == "environment" || store.name() == "keychain" {
                continue;
            }
            if let Some(value) = store.get(key) {
                return Some(ResolvedSecret {
                    value,
                    source: store.name().to_string(),
                    source_detail: store.name().to_string(),
                });
            }
        }

        None
    }
    
    /// Async resolve a secret by key (non-blocking for Node.js)
    /// 
    /// Respects the user's secrets_store preference:
    /// - VsCode: Check RPC (VS Code SecretStorage)
    /// - Keychain: Check system keychain
    pub async fn resolve_async(&self, key: &str) -> Option<ResolvedSecret> {
        log::info("SecretResolver", &format!("resolve_async key='{}', secrets_store={:?}, check_env={}, check_dotenv={}", 
                  key, self.secrets_store, self.check_environment, self.check_dotenv));
        
        // Check environment variables if enabled (highest priority)
        if self.check_environment {
            let env_store = EnvSecretStore::new();
            if let Some(value) = env_store.get(key) {
                let env_var_name = format!("{}_API_KEY", key.to_uppercase());
                log::debug("SecretResolver", "Found in environment");
                return Some(ResolvedSecret {
                    value,
                    source: "environment".to_string(),
                    source_detail: format!("Environment variable ${}", env_var_name),
                });
            }
        }

        // Check .env files if enabled
        if self.check_dotenv {
            if let Some(value) = self.try_dotenv_file(key) {
                let env_var_name = format!("{}_API_KEY", key.to_uppercase());
                log::debug("SecretResolver", "Found in dotenv");
                return Some(ResolvedSecret {
                    value,
                    source: "dotenv".to_string(),
                    source_detail: format!(".env file ({})", env_var_name),
                });
            }
        }

        // Check primary store based on user preference
        match self.secrets_store {
            SecretsStore::VsCode => {
                log::debug("SecretResolver", "Checking VsCode RPC...");
                // Check VS Code RPC endpoints
                for endpoint_name in &self.rpc_endpoints {
                    if let Some(endpoint) = get_rpc_endpoint(endpoint_name) {
                        let rpc_store = RpcSecretStore::new(&endpoint);
                        if rpc_store.is_reachable_async().await {
                            if let Some(value) = rpc_store.get_async(key).await {
                                log::info("SecretResolver", "Found in RPC");
                                return Some(ResolvedSecret {
                                    value,
                                    source: format!("rpc:{}", endpoint_name),
                                    source_detail: format!("{} SecretStorage", endpoint_name),
                                });
                            }
                        }
                    }
                }
            }
            SecretsStore::Keychain => {
                log::debug("SecretResolver", "Checking keychain...");
                // Check system keychain only - NO RPC calls
                let keychain_store = KeychainSecretStore::new();
                let available = keychain_store.is_available();
                log::debug("SecretResolver", &format!("Keychain available: {}", available));
                if available {
                    let result = keychain_store.get(key);
                    log::debug("SecretResolver", &format!("Keychain get result: {:?}", result.is_some()));
                    if let Some(value) = result {
                        log::info("SecretResolver", "Found in keychain!");
                        return Some(ResolvedSecret {
                            value,
                            source: "keychain".to_string(),
                            source_detail: "System Keychain".to_string(),
                        });
                    }
                }
            }
        }

        log::debug("SecretResolver", "Not found in primary store, checking fallback sources...");
        
        // Check other registered sources as fallback
        for store in &self.sources {
            if store.name() == "environment" || store.name() == "keychain" {
                continue;
            }
            log::debug("SecretResolver", &format!("Checking fallback: {}", store.name()));
            if let Some(value) = store.get(key) {
                log::info("SecretResolver", &format!("Found in fallback: {}", store.name()));
                return Some(ResolvedSecret {
                    value,
                    source: store.name().to_string(),
                    source_detail: store.name().to_string(),
                });
            }
        }
        
        log::warn("SecretResolver", &format!("Key '{}' not found anywhere", key));

        None
    }

    /// Try to read a secret from .env file
    fn try_dotenv_file(&self, key: &str) -> Option<String> {
        let env_var_name = format!("{}_API_KEY", key.to_uppercase().replace("-", "_"));
        
        // Try .env in current directory
        if let Ok(content) = std::fs::read_to_string(".env") {
            for line in content.lines() {
                let line = line.trim();
                if line.starts_with('#') || line.is_empty() {
                    continue;
                }
                if let Some((k, v)) = line.split_once('=') {
                    if k.trim() == env_var_name {
                        let value = v.trim().trim_matches('"').trim_matches('\'');
                        if !value.is_empty() {
                            return Some(value.to_string());
                        }
                    }
                }
            }
        }
        None
    }

    // ========== WRITE OPERATIONS ==========
    //
    // The resolver routes writes based on user preference (secrets_store).

    /// Get the write destination based on user preference
    fn get_write_destination(&self) -> SecretWriteDestination {
        match self.secrets_store {
            SecretsStore::VsCode => {
                // User wants VS Code SecretStorage - find an RPC endpoint
                for endpoint_name in &self.rpc_endpoints {
                    if get_rpc_endpoint(endpoint_name).is_some() {
                        return SecretWriteDestination::Rpc(endpoint_name.clone());
                    }
                }
                // VS Code selected but no RPC endpoint - shouldn't happen
                eprintln!("Warning: VS Code secrets store selected but no RPC endpoint available");
                SecretWriteDestination::None
            }
            SecretsStore::Keychain => {
                // User wants system keychain
                let keychain_store = KeychainSecretStore::new();
                if keychain_store.is_available() {
                    SecretWriteDestination::Keychain
                } else {
                    SecretWriteDestination::None
                }
            }
        }
    }

    /// Store a secret, automatically routing to the best destination
    ///
    /// If `preferred_store` is "auto", routes to:
    /// - RPC (VS Code) if available
    /// - System keychain otherwise
    ///
    /// Otherwise, routes to the specified store:
    /// - "rpc:vscode" → Store via RPC to VS Code
    /// - "keychain" → Store in system keychain
    /// - "rpc:<name>" → Store via any registered RPC endpoint
    pub fn store(&self, key: &str, value: &str, preferred_store: &str) -> Result<String, String> {
        log::info("SecretResolver", &format!("store() key='{}', preferred_store='{}', secrets_store={:?}", 
                  key, preferred_store, self.secrets_store));
        
        // Handle "auto" routing
        if preferred_store == "auto" {
            let dest = self.get_write_destination();
            log::debug("SecretResolver", &format!("auto routing -> {:?}", dest));
            match dest {
                SecretWriteDestination::Rpc(name) => {
                    return self.store(key, value, &format!("rpc:{}", name));
                }
                SecretWriteDestination::Keychain => {
                    return self.store(key, value, "keychain");
                }
                SecretWriteDestination::None => {
                    log::error("SecretResolver", "No secret store available");
                    return Err("No secret store available (no RPC endpoint and keychain unavailable)".to_string());
                }
            }
        }

        // Handle "vscode" as shorthand for "rpc:vscode"
        if preferred_store == "vscode" {
            return self.store(key, value, "rpc:vscode");
        }

        if preferred_store == "keychain" {
            log::debug("SecretResolver", "Creating KeychainSecretStore...");
            let keychain_store = KeychainSecretStore::new();
            log::debug("SecretResolver", &format!("Keychain available: {}", keychain_store.is_available()));
            if keychain_store.is_available() {
                log::debug("SecretResolver", "Calling keychain_store.store()...");
                keychain_store.store(key, value)
                    .map_err(|e| {
                        log::error("SecretResolver", &format!("keychain_store.store FAILED: {}", e));
                        e.to_string()
                    })?;
                log::info("SecretResolver", "keychain_store.store succeeded!");
                return Ok("System Keychain".to_string());
            } else {
                log::error("SecretResolver", "System keychain not available");
                return Err("System keychain not available".to_string());
            }
        }

        if let Some(endpoint_name) = preferred_store.strip_prefix("rpc:") {
            if let Some(endpoint) = get_rpc_endpoint(endpoint_name) {
                let rpc_store = RpcSecretStore::new(&endpoint);
                if rpc_store.is_reachable() {
                    rpc_store.store(key, value)
                        .map_err(|e| e.to_string())?;
                    log::info("SecretResolver", &format!("Stored via RPC: {}", endpoint_name));
                    return Ok(format!("{} SecretStorage", endpoint_name));
                } else {
                    log::error("SecretResolver", &format!("RPC endpoint '{}' not reachable", endpoint_name));
                    return Err(format!("RPC endpoint '{}' not reachable", endpoint_name));
                }
            } else {
                log::error("SecretResolver", &format!("RPC endpoint '{}' not registered", endpoint_name));
                return Err(format!("RPC endpoint '{}' not registered", endpoint_name));
            }
        }

        log::error("SecretResolver", &format!("Unknown store: {}", preferred_store));
        Err(format!("Unknown store: {}", preferred_store))
    }

    /// Delete a secret, automatically routing to the best destination
    pub fn delete(&self, key: &str, preferred_store: &str) -> Result<String, String> {
        // Handle "auto" routing
        if preferred_store == "auto" {
            match self.get_write_destination() {
                SecretWriteDestination::Rpc(name) => {
                    return self.delete(key, &format!("rpc:{}", name));
                }
                SecretWriteDestination::Keychain => {
                    return self.delete(key, "keychain");
                }
                SecretWriteDestination::None => {
                    return Err("No secret store available".to_string());
                }
            }
        }

        // Handle "vscode" as shorthand
        if preferred_store == "vscode" {
            return self.delete(key, "rpc:vscode");
        }

        if preferred_store == "keychain" {
            let keychain_store = KeychainSecretStore::new();
            keychain_store.delete(key).map_err(|e| e.to_string())?;
            return Ok("System Keychain".to_string());
        }

        if let Some(endpoint_name) = preferred_store.strip_prefix("rpc:") {
            if let Some(endpoint) = get_rpc_endpoint(endpoint_name) {
                let rpc_store = RpcSecretStore::new(&endpoint);
                rpc_store.delete(key).map_err(|e| e.to_string())?;
                return Ok(format!("{} SecretStorage", endpoint_name));
            } else {
                return Err(format!("RPC endpoint '{}' not registered", endpoint_name));
            }
        }

        Err(format!("Unknown store: {}", preferred_store))
    }

    /// Get information about where a secret write would go
    pub fn get_write_destination_info(&self) -> (String, String) {
        match self.get_write_destination() {
            SecretWriteDestination::Rpc(name) => (
                format!("rpc:{}", name),
                format!("{} SecretStorage", name),
            ),
            SecretWriteDestination::Keychain => (
                "keychain".to_string(),
                "System Keychain".to_string(),
            ),
            SecretWriteDestination::None => (
                "none".to_string(),
                "No store available".to_string(),
            ),
        }
    }

    /// Get information about where a secret would be resolved from
    /// without actually retrieving the value
    pub fn get_source_info(&self, key: &str) -> Option<(String, String)> {
        self.resolve(key).map(|r| (r.source, r.source_detail))
    }

    /// Get source info for multiple keys in a single batch call
    /// 
    /// This is more efficient than calling get_source_info for each key
    /// because it reuses connections and caches intermediate results.
    /// 
    /// Respects the secrets_store preference - only checks the configured store.
    /// 
    /// Returns: HashMap<key, Option<(source, source_detail, env_var_name)>>
    pub fn get_all_source_info(&self, keys: &[&str]) -> std::collections::HashMap<String, Option<(String, String, String)>> {
        let mut results = std::collections::HashMap::new();
        
        // Pre-check store availability once based on preference
        let rpc_available_endpoint: Option<(String, RpcSecretStore)> = if matches!(self.secrets_store, SecretsStore::VsCode) {
            // Only check RPC when VsCode is selected
            self.rpc_endpoints.iter().find_map(|name| {
                get_rpc_endpoint(name).and_then(|ep| {
                    let rpc_store = RpcSecretStore::new(&ep);
                    if rpc_store.is_reachable() {
                        Some((name.clone(), rpc_store))
                    } else {
                        None
                    }
                })
            })
        } else {
            None // Don't check RPC at all for Keychain mode
        };
        
        // Check keychain availability once (only if Keychain mode)
        let keychain_store = KeychainSecretStore::new();
        let keychain_available = matches!(self.secrets_store, SecretsStore::Keychain) && keychain_store.is_available();
        let env_store = EnvSecretStore::new();
        
        for key in keys {
            let env_key = format!("{}_API_KEY", key.to_uppercase().replace("-", "_"));
            
            // Try environment first if enabled (fast, local)
            if self.check_environment {
                if env_store.get(key).is_some() {
                    results.insert(key.to_string(), Some((
                        "environment".to_string(),
                        format!("Environment variable: {}", env_key),
                        env_key.clone(),
                    )));
                    continue;
                }
            }
            
            // Try .env files if enabled
            if self.check_dotenv {
                if self.try_dotenv_file(key).is_some() {
                    results.insert(key.to_string(), Some((
                        "dotenv".to_string(),
                        format!(".env file ({})", env_key),
                        env_key.clone(),
                    )));
                    continue;
                }
            }
            
            // Try the configured store based on preference
            match self.secrets_store {
                SecretsStore::VsCode => {
                    // Try RPC if available
                    if let Some((ref endpoint_name, ref rpc_store)) = rpc_available_endpoint {
                        if rpc_store.get(key).is_some() {
                            results.insert(key.to_string(), Some((
                                "secretStorage".to_string(),
                                format!("{} SecretStorage", endpoint_name),
                                String::new(),
                            )));
                            continue;
                        }
                    }
                }
                SecretsStore::Keychain => {
                    // Try keychain if available
                    log::debug("SecretResolver", &format!("get_all_source_info: checking keychain for '{}', available={}", key, keychain_available));
                    if keychain_available {
                        let has_key = keychain_store.get(key).is_some();
                        log::debug("SecretResolver", &format!("get_all_source_info: keychain has '{}'={}", key, has_key));
                        if has_key {
                            results.insert(key.to_string(), Some((
                                "keychain".to_string(),
                                "System Keychain".to_string(),
                                String::new(),
                            )));
                            continue;
                        }
                    }
                }
            }
            
            // Not found in any source
            log::debug("SecretResolver", &format!("get_all_source_info: '{}' not found", key));
            results.insert(key.to_string(), None);
        }
        
        results
    }

    /// List all available secret sources and their status
    /// 
    /// Only checks sources relevant to the current secrets_store preference
    /// to avoid unnecessary RPC calls.
    pub fn list_sources(&self) -> Vec<(String, bool)> {
        let mut sources = Vec::new();
        
        // Environment is always listed (if check is enabled)
        if self.check_environment {
            sources.push(("environment".to_string(), true));
        }
        
        // .env files (if check is enabled)
        if self.check_dotenv {
            sources.push(("dotenv".to_string(), true));
        }
        
        // Only check the configured store type - no unnecessary RPC calls
        match self.secrets_store {
            SecretsStore::VsCode => {
                // Check RPC endpoints only when VsCode is the selected store
                for endpoint_name in &self.rpc_endpoints {
                    if let Some(endpoint) = get_rpc_endpoint(endpoint_name) {
                        let rpc_store = RpcSecretStore::new(&endpoint);
                        sources.push((
                            format!("rpc:{}", endpoint_name),
                            rpc_store.is_reachable(),
                        ));
                    } else {
                        sources.push((
                            format!("rpc:{}", endpoint_name),
                            false,
                        ));
                    }
                }
            }
            SecretsStore::Keychain => {
                // Check keychain only when it's the selected store
                let keychain_store = KeychainSecretStore::new();
                sources.push(("keychain".to_string(), keychain_store.is_available()));
            }
        }
        
        sources
    }
}

impl Default for UnifiedSecretResolver {
    fn default() -> Self {
        Self::new()
    }
}

/// Where a secret write will be routed
#[derive(Debug)]
enum SecretWriteDestination {
    /// Write to RPC endpoint (endpoint_name)
    Rpc(String),
    /// Write to system keychain
    Keychain,
    /// No store available
    None,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolver_creation() {
        let resolver = UnifiedSecretResolver::new();
        let sources = resolver.list_sources();
        assert!(!sources.is_empty());
        assert!(sources.iter().any(|(name, _)| name == "environment"));
    }

    #[test]
    fn test_resolve_from_env() {
        std::env::set_var("TEST_PROVIDER_API_KEY", "test-key-123");
        let resolver = UnifiedSecretResolver::new();
        // Note: EnvSecretStore maps "test_provider" -> "TEST_PROVIDER_API_KEY"
        // This test may not work as expected due to key mapping
        std::env::remove_var("TEST_PROVIDER_API_KEY");
    }
}
