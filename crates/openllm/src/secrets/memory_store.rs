//! In-memory secret store

use std::collections::HashMap;
use std::sync::RwLock;

use super::traits::{SecretStore, SecretInfo, SecretStoreResult};

/// In-memory secret store for testing and ephemeral use
///
/// This store keeps secrets in memory and is fully read-write.
/// Secrets are lost when the store is dropped.
///
/// # Thread Safety
///
/// The store uses `RwLock` internally and is safe to use from multiple threads.
///
/// # Example
///
/// ```
/// use openllm_core::secrets::{SecretStore, MemorySecretStore};
///
/// let store = MemorySecretStore::new();
/// store.store("openai", "sk-test").unwrap();
/// assert_eq!(store.get("openai"), Some("sk-test".to_string()));
/// ```
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    secrets: RwLock<HashMap<String, String>>,
}

impl MemorySecretStore {
    /// Create a new empty memory store
    pub fn new() -> Self {
        Self {
            secrets: RwLock::new(HashMap::new()),
        }
    }

    /// Create a memory store with initial values
    pub fn with_secrets(initial: HashMap<String, String>) -> Self {
        Self {
            secrets: RwLock::new(initial),
        }
    }

    /// Clear all secrets from the store
    pub fn clear(&self) {
        let mut secrets = self.secrets.write().unwrap();
        secrets.clear();
    }

    /// Get the number of secrets in the store
    pub fn len(&self) -> usize {
        let secrets = self.secrets.read().unwrap();
        secrets.len()
    }

    /// Check if the store is empty
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Store a secret synchronously (useful for initialization)
    pub fn store_sync(&self, key: &str, value: &str) {
        let mut secrets = self.secrets.write().unwrap();
        secrets.insert(key.to_string(), value.to_string());
    }

    /// Get a secret synchronously
    pub fn get_sync(&self, key: &str) -> Option<String> {
        let secrets = self.secrets.read().unwrap();
        secrets.get(key).cloned()
    }
}

impl SecretStore for MemorySecretStore {
    fn name(&self) -> &str {
        "memory"
    }

    fn get(&self, key: &str) -> Option<String> {
        let secrets = self.secrets.read().unwrap();
        secrets.get(key).cloned()
    }

    fn store(&self, key: &str, value: &str) -> SecretStoreResult<()> {
        let mut secrets = self.secrets.write().unwrap();
        secrets.insert(key.to_string(), value.to_string());
        Ok(())
    }

    fn delete(&self, key: &str) -> SecretStoreResult<()> {
        let mut secrets = self.secrets.write().unwrap();
        secrets.remove(key);
        Ok(())
    }

    fn get_info(&self, key: &str) -> SecretInfo {
        if self.has(key) {
            SecretInfo::new(true, self.name())
        } else {
            SecretInfo::not_found()
        }
    }
}

impl Clone for MemorySecretStore {
    fn clone(&self) -> Self {
        let secrets = self.secrets.read().unwrap();
        Self {
            secrets: RwLock::new(secrets.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_memory_store_name() {
        let store = MemorySecretStore::new();
        assert_eq!(store.name(), "memory");
    }

    #[test]
    fn test_memory_store_crud() {
        let store = MemorySecretStore::new();
        
        // Initially empty
        assert!(store.is_empty());
        assert_eq!(store.get("test"), None);
        
        // Store a secret
        store.store("test", "value").unwrap();
        assert_eq!(store.len(), 1);
        assert_eq!(store.get("test"), Some("value".to_string()));
        assert!(store.has("test"));
        
        // Update the secret
        store.store("test", "new_value").unwrap();
        assert_eq!(store.get("test"), Some("new_value".to_string()));
        
        // Delete the secret
        store.delete("test").unwrap();
        assert_eq!(store.get("test"), None);
        assert!(!store.has("test"));
        assert!(store.is_empty());
    }

    #[test]
    fn test_memory_store_with_initial() {
        let mut initial = HashMap::new();
        initial.insert("key1".to_string(), "value1".to_string());
        initial.insert("key2".to_string(), "value2".to_string());
        
        let store = MemorySecretStore::with_secrets(initial);
        
        assert_eq!(store.len(), 2);
        assert_eq!(store.get("key1"), Some("value1".to_string()));
        assert_eq!(store.get("key2"), Some("value2".to_string()));
    }

    #[test]
    fn test_memory_store_clear() {
        let store = MemorySecretStore::new();
        store.store("key1", "value1").unwrap();
        store.store("key2", "value2").unwrap();
        
        assert_eq!(store.len(), 2);
        
        store.clear();
        
        assert!(store.is_empty());
        assert_eq!(store.get("key1"), None);
    }

    #[test]
    fn test_memory_store_get_info() {
        let store = MemorySecretStore::new();
        store.store("exists", "value").unwrap();
        
        let info = store.get_info("exists");
        assert!(info.available);
        assert_eq!(info.source, "memory");
        
        let not_found = store.get_info("nonexistent");
        assert!(!not_found.available);
    }

    #[test]
    fn test_memory_store_sync_methods() {
        let store = MemorySecretStore::new();
        
        store.store_sync("key", "value");
        assert_eq!(store.get_sync("key"), Some("value".to_string()));
    }

    #[test]
    fn test_memory_store_clone() {
        let store = MemorySecretStore::new();
        store.store("key", "value").unwrap();
        
        let cloned = store.clone();
        assert_eq!(cloned.get("key"), Some("value".to_string()));
        
        // Modifying clone doesn't affect original
        cloned.store("key", "modified").unwrap();
        assert_eq!(store.get("key"), Some("value".to_string()));
        assert_eq!(cloned.get("key"), Some("modified".to_string()));
    }

    #[test]
    fn test_memory_store_thread_safety() {
        use std::sync::Arc;
        use std::thread;

        let store = Arc::new(MemorySecretStore::new());
        let mut handles = vec![];

        // Spawn multiple threads that read and write
        for i in 0..10 {
            let store_clone = Arc::clone(&store);
            let handle = thread::spawn(move || {
                let key = format!("key_{}", i);
                let value = format!("value_{}", i);
                store_clone.store(&key, &value).unwrap();
                assert_eq!(store_clone.get(&key), Some(value));
            });
            handles.push(handle);
        }

        for handle in handles {
            handle.join().unwrap();
        }

        assert_eq!(store.len(), 10);
    }
}
