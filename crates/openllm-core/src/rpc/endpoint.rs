//! RPC endpoint registration and discovery
//!
//! External providers (like VS Code) register their RPC endpoints here,
//! and openllm-core can discover and connect to them.

use std::collections::HashMap;
use std::path::PathBuf;
use parking_lot::RwLock;
use once_cell::sync::Lazy;

/// Information about an RPC endpoint
#[derive(Debug, Clone)]
pub struct RpcEndpoint {
    /// Human-readable name (e.g., "vscode", "1password")
    pub name: String,
    /// Path to the Unix socket or named pipe
    pub socket_path: PathBuf,
    /// Authentication token required for requests
    pub auth_token: String,
    /// Capabilities this endpoint supports
    pub capabilities: Vec<String>,
}

impl RpcEndpoint {
    pub fn new(
        name: impl Into<String>,
        socket_path: impl Into<PathBuf>,
        auth_token: impl Into<String>,
        capabilities: Vec<String>,
    ) -> Self {
        Self {
            name: name.into(),
            socket_path: socket_path.into(),
            auth_token: auth_token.into(),
            capabilities,
        }
    }

    /// Check if this endpoint supports a specific capability
    pub fn has_capability(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
    }

    /// Check if this endpoint supports secrets
    pub fn supports_secrets(&self) -> bool {
        self.has_capability("secrets")
    }

    /// Check if this endpoint supports config
    pub fn supports_config(&self) -> bool {
        self.has_capability("config")
    }
}

/// Registry for RPC endpoints
pub struct RpcEndpointRegistry {
    endpoints: RwLock<HashMap<String, RpcEndpoint>>,
}

impl RpcEndpointRegistry {
    pub fn new() -> Self {
        Self {
            endpoints: RwLock::new(HashMap::new()),
        }
    }

    /// Register an endpoint
    pub fn register(&self, endpoint: RpcEndpoint) {
        let name = endpoint.name.clone();
        self.endpoints.write().insert(name, endpoint);
    }

    /// Unregister an endpoint by name
    pub fn unregister(&self, name: &str) -> Option<RpcEndpoint> {
        self.endpoints.write().remove(name)
    }

    /// Get an endpoint by name
    pub fn get(&self, name: &str) -> Option<RpcEndpoint> {
        self.endpoints.read().get(name).cloned()
    }

    /// Get all endpoints that support a capability
    pub fn get_by_capability(&self, capability: &str) -> Vec<RpcEndpoint> {
        self.endpoints
            .read()
            .values()
            .filter(|e| e.has_capability(capability))
            .cloned()
            .collect()
    }

    /// List all registered endpoint names
    pub fn list(&self) -> Vec<String> {
        self.endpoints.read().keys().cloned().collect()
    }

    /// Check if any endpoints are registered
    pub fn is_empty(&self) -> bool {
        self.endpoints.read().is_empty()
    }
}

impl Default for RpcEndpointRegistry {
    fn default() -> Self {
        Self::new()
    }
}

// Global registry instance
static GLOBAL_REGISTRY: Lazy<RpcEndpointRegistry> = Lazy::new(RpcEndpointRegistry::new);

/// Register an RPC endpoint globally
pub fn register_rpc_endpoint(endpoint: RpcEndpoint) {
    GLOBAL_REGISTRY.register(endpoint);
}

/// Get an RPC endpoint by name from the global registry
pub fn get_rpc_endpoint(name: &str) -> Option<RpcEndpoint> {
    GLOBAL_REGISTRY.get(name)
}

/// Get all RPC endpoints that support a capability
pub fn get_rpc_endpoints_by_capability(capability: &str) -> Vec<RpcEndpoint> {
    GLOBAL_REGISTRY.get_by_capability(capability)
}

/// Unregister an RPC endpoint by name
pub fn unregister_rpc_endpoint(name: &str) -> Option<RpcEndpoint> {
    GLOBAL_REGISTRY.unregister(name)
}

/// List all registered RPC endpoints
pub fn list_rpc_endpoints() -> Vec<String> {
    GLOBAL_REGISTRY.list()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_endpoint_capabilities() {
        let endpoint = RpcEndpoint::new(
            "test",
            "/tmp/test.sock",
            "token123",
            vec!["secrets".to_string(), "config".to_string()],
        );

        assert!(endpoint.supports_secrets());
        assert!(endpoint.supports_config());
        assert!(endpoint.has_capability("secrets"));
        assert!(!endpoint.has_capability("unknown"));
    }

    #[test]
    fn test_registry() {
        let registry = RpcEndpointRegistry::new();
        
        let endpoint = RpcEndpoint::new(
            "vscode",
            "/tmp/vscode.sock",
            "token",
            vec!["secrets".to_string()],
        );
        
        registry.register(endpoint);
        
        assert!(!registry.is_empty());
        assert!(registry.get("vscode").is_some());
        assert!(registry.get("unknown").is_none());
        
        let secrets_endpoints = registry.get_by_capability("secrets");
        assert_eq!(secrets_endpoints.len(), 1);
        assert_eq!(secrets_endpoints[0].name, "vscode");
        
        registry.unregister("vscode");
        assert!(registry.is_empty());
    }
}
