//! Secret store registry for discovering and creating stores by name

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use once_cell::sync::Lazy;

use super::traits::SecretStore;
use super::env_store::EnvSecretStore;
use super::memory_store::MemorySecretStore;
use super::keychain_store::KeychainSecretStore;

/// Factory function type for creating secret stores
pub type StoreFactory = Box<dyn Fn() -> Arc<dyn SecretStore> + Send + Sync>;

/// Definition of a registered secret store
pub struct StoreDefinition {
    /// Unique name for this store
    pub name: String,
    /// Human-readable description
    pub description: String,
    /// Factory function to create instances
    pub factory: StoreFactory,
    /// Whether this is an external plugin
    pub is_plugin: bool,
    /// Package name for plugins (e.g., "@openllm/keyring")
    pub package_name: Option<String>,
}

impl std::fmt::Debug for StoreDefinition {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreDefinition")
            .field("name", &self.name)
            .field("description", &self.description)
            .field("is_plugin", &self.is_plugin)
            .field("package_name", &self.package_name)
            .finish()
    }
}

/// Global registry of secret stores
static REGISTRY: Lazy<RwLock<HashMap<String, StoreDefinition>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    
    // Register built-in stores
    map.insert(
        "env".to_string(),
        StoreDefinition {
            name: "env".to_string(),
            description: "Read API keys from environment variables".to_string(),
            factory: Box::new(|| Arc::new(EnvSecretStore::new())),
            is_plugin: false,
            package_name: None,
        },
    );
    
    map.insert(
        "memory".to_string(),
        StoreDefinition {
            name: "memory".to_string(),
            description: "In-memory storage for testing".to_string(),
            factory: Box::new(|| Arc::new(MemorySecretStore::new())),
            is_plugin: false,
            package_name: None,
        },
    );

    map.insert(
        "keychain".to_string(),
        StoreDefinition {
            name: "keychain".to_string(),
            description: "System keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service)".to_string(),
            factory: Box::new(|| Arc::new(KeychainSecretStore::new())),
            is_plugin: false,
            package_name: None,
        },
    );
    
    RwLock::new(map)
});

/// Register a new secret store type
///
/// # Arguments
/// * `name` - Unique name for the store
/// * `description` - Human-readable description
/// * `factory` - Factory function to create instances
///
/// # Example
///
/// ```
/// use openllm_core::secrets::{register_secret_store, MemorySecretStore};
/// use std::sync::Arc;
///
/// register_secret_store(
///     "custom",
///     "My custom store",
///     Box::new(|| Arc::new(MemorySecretStore::new())),
///     false,
///     None,
/// );
/// ```
pub fn register_secret_store(
    name: &str,
    description: &str,
    factory: StoreFactory,
    is_plugin: bool,
    package_name: Option<&str>,
) {
    let mut registry = REGISTRY.write().unwrap();
    registry.insert(
        name.to_string(),
        StoreDefinition {
            name: name.to_string(),
            description: description.to_string(),
            factory,
            is_plugin,
            package_name: package_name.map(|s| s.to_string()),
        },
    );
}

/// Create a secret store by name
///
/// # Arguments
/// * `name` - Name of the store to create
///
/// # Returns
/// The created store, or None if the name is not registered
///
/// # Example
///
/// ```
/// use openllm_core::secrets::create_secret_store;
///
/// let store = create_secret_store("env").expect("env store should exist");
/// ```
pub fn create_secret_store(name: &str) -> Option<Arc<dyn SecretStore>> {
    let registry = REGISTRY.read().unwrap();
    registry.get(name).map(|def| (def.factory)())
}

/// List all registered secret stores
///
/// # Returns
/// A vector of (name, description, is_plugin) tuples
pub fn list_secret_stores() -> Vec<(String, String, bool)> {
    let registry = REGISTRY.read().unwrap();
    registry
        .values()
        .map(|def| (def.name.clone(), def.description.clone(), def.is_plugin))
        .collect()
}

/// Check if a store is registered
pub fn has_secret_store(name: &str) -> bool {
    let registry = REGISTRY.read().unwrap();
    registry.contains_key(name)
}

/// Get the definition of a registered store
pub fn get_store_definition(name: &str) -> Option<(String, String, bool, Option<String>)> {
    let registry = REGISTRY.read().unwrap();
    registry.get(name).map(|def| {
        (
            def.name.clone(),
            def.description.clone(),
            def.is_plugin,
            def.package_name.clone(),
        )
    })
}

/// Unregister a secret store (mainly for testing)
pub fn unregister_secret_store(name: &str) -> bool {
    let mut registry = REGISTRY.write().unwrap();
    registry.remove(name).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_builtin_stores_registered() {
        assert!(has_secret_store("env"));
        assert!(has_secret_store("memory"));
    }

    #[test]
    fn test_create_env_store() {
        let store = create_secret_store("env").unwrap();
        assert_eq!(store.name(), "env");
    }

    #[test]
    fn test_create_memory_store() {
        let store = create_secret_store("memory").unwrap();
        assert_eq!(store.name(), "memory");
    }

    #[test]
    fn test_create_unknown_store() {
        assert!(create_secret_store("nonexistent_xyz").is_none());
    }

    #[test]
    fn test_list_stores() {
        let stores = list_secret_stores();
        
        // Should have at least the built-in stores
        let names: Vec<_> = stores.iter().map(|(n, _, _)| n.as_str()).collect();
        assert!(names.contains(&"env"));
        assert!(names.contains(&"memory"));
    }

    #[test]
    fn test_register_custom_store() {
        // Register a custom store
        register_secret_store(
            "test_custom_store",
            "A test store",
            Box::new(|| Arc::new(MemorySecretStore::new())),
            false,
            None,
        );
        
        assert!(has_secret_store("test_custom_store"));
        
        let store = create_secret_store("test_custom_store").unwrap();
        assert_eq!(store.name(), "memory"); // It's a MemorySecretStore
        
        // Clean up
        unregister_secret_store("test_custom_store");
    }

    #[test]
    fn test_get_store_definition() {
        let def = get_store_definition("env").unwrap();
        assert_eq!(def.0, "env");
        assert!(!def.2); // is_plugin = false
        assert!(def.3.is_none()); // package_name = None
    }
}
