//! Chained secret store with fallback behavior

use std::sync::Arc;

use super::traits::{SecretStore, SecretInfo, SecretStoreResult};

/// A secret store that chains multiple stores together with fallback behavior
///
/// When reading, the chain tries each store in order and returns the first match.
/// When writing, the chain writes to the designated write store (default: first store).
///
/// # Example
///
/// ```
/// use openllm_core::secrets::{SecretStore, ChainSecretStore, EnvSecretStore, MemorySecretStore};
/// use std::sync::Arc;
///
/// let memory = Arc::new(MemorySecretStore::new());
/// let env = Arc::new(EnvSecretStore::new());
///
/// // Try memory first, then fall back to env
/// let chain = ChainSecretStore::new(vec![memory.clone(), env]);
///
/// // Writes go to memory (first store)
/// chain.store("test", "value").unwrap();
/// ```
pub struct ChainSecretStore {
    stores: Vec<Arc<dyn SecretStore>>,
    write_store_index: usize,
}

impl ChainSecretStore {
    /// Create a new chain store
    ///
    /// The first store is used for writes by default.
    /// Stores are tried in order for reads.
    pub fn new(stores: Vec<Arc<dyn SecretStore>>) -> Self {
        if stores.is_empty() {
            panic!("ChainSecretStore requires at least one store");
        }
        Self {
            stores,
            write_store_index: 0,
        }
    }

    /// Create a chain store with a specific write store
    ///
    /// # Arguments
    /// * `stores` - The stores to chain, tried in order for reads
    /// * `write_store_index` - Index of the store to use for writes
    pub fn with_write_store(stores: Vec<Arc<dyn SecretStore>>, write_store_index: usize) -> Self {
        if stores.is_empty() {
            panic!("ChainSecretStore requires at least one store");
        }
        if write_store_index >= stores.len() {
            panic!("write_store_index out of bounds");
        }
        Self {
            stores,
            write_store_index,
        }
    }

    /// Get the stores in this chain
    pub fn stores(&self) -> &[Arc<dyn SecretStore>] {
        &self.stores
    }

    /// Get the write store
    pub fn write_store(&self) -> &Arc<dyn SecretStore> {
        &self.stores[self.write_store_index]
    }

    /// Find which store has a key
    pub fn find_store(&self, key: &str) -> Option<&Arc<dyn SecretStore>> {
        for store in &self.stores {
            if store.is_available() && store.has(key) {
                return Some(store);
            }
        }
        None
    }
}

impl SecretStore for ChainSecretStore {
    fn name(&self) -> &str {
        "chain"
    }

    fn is_available(&self) -> bool {
        // Chain is available if any store is available
        self.stores.iter().any(|s| s.is_available())
    }

    fn get(&self, key: &str) -> Option<String> {
        for store in &self.stores {
            if !store.is_available() {
                continue;
            }
            if let Some(value) = store.get(key) {
                return Some(value);
            }
        }
        None
    }

    fn store(&self, key: &str, value: &str) -> SecretStoreResult<()> {
        self.stores[self.write_store_index].store(key, value)
    }

    fn delete(&self, key: &str) -> SecretStoreResult<()> {
        // Try to delete from all stores that have the key
        let mut deleted_any = false;
        for store in &self.stores {
            if store.has(key) {
                // Ignore errors (some stores may be read-only)
                if store.delete(key).is_ok() {
                    deleted_any = true;
                }
            }
        }
        
        // As long as we deleted from at least one store (or no store had it), succeed
        Ok(())
    }

    fn get_info(&self, key: &str) -> SecretInfo {
        for store in &self.stores {
            if !store.is_available() {
                continue;
            }
            if store.has(key) {
                return SecretInfo::new(true, store.name());
            }
        }
        SecretInfo::not_found()
    }
}

// Implement Debug manually since Arc<dyn SecretStore> doesn't implement Debug
impl std::fmt::Debug for ChainSecretStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChainSecretStore")
            .field("stores", &format!("[{} stores]", self.stores.len()))
            .field("write_store_index", &self.write_store_index)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecretStore;

    #[test]
    fn test_chain_store_name() {
        let store = ChainSecretStore::new(vec![Arc::new(MemorySecretStore::new())]);
        assert_eq!(store.name(), "chain");
    }

    #[test]
    fn test_chain_store_fallback() {
        let store1 = Arc::new(MemorySecretStore::new());
        let store2 = Arc::new(MemorySecretStore::new());
        
        // Only store2 has the key
        store2.store("key", "from_store2").unwrap();
        
        let chain = ChainSecretStore::new(vec![store1, store2]);
        
        // Should find it in store2
        assert_eq!(chain.get("key"), Some("from_store2".to_string()));
    }

    #[test]
    fn test_chain_store_priority() {
        let store1 = Arc::new(MemorySecretStore::new());
        let store2 = Arc::new(MemorySecretStore::new());
        
        // Both stores have the key
        store1.store("key", "from_store1").unwrap();
        store2.store("key", "from_store2").unwrap();
        
        let chain = ChainSecretStore::new(vec![store1, store2]);
        
        // Should return from first store (priority)
        assert_eq!(chain.get("key"), Some("from_store1".to_string()));
    }

    #[test]
    fn test_chain_store_write() {
        let store1 = Arc::new(MemorySecretStore::new());
        let store2 = Arc::new(MemorySecretStore::new());
        
        let chain = ChainSecretStore::new(vec![store1.clone(), store2.clone()]);
        
        // Write to chain
        chain.store("key", "value").unwrap();
        
        // Should be in store1 (default write store)
        assert_eq!(store1.get("key"), Some("value".to_string()));
        assert_eq!(store2.get("key"), None);
    }

    #[test]
    fn test_chain_store_custom_write_store() {
        let store1 = Arc::new(MemorySecretStore::new());
        let store2 = Arc::new(MemorySecretStore::new());
        
        // Use store2 as write store
        let chain = ChainSecretStore::with_write_store(
            vec![store1.clone(), store2.clone()],
            1
        );
        
        chain.store("key", "value").unwrap();
        
        // Should be in store2
        assert_eq!(store1.get("key"), None);
        assert_eq!(store2.get("key"), Some("value".to_string()));
    }

    #[test]
    fn test_chain_store_get_info() {
        let store1 = Arc::new(MemorySecretStore::new());
        let store2 = Arc::new(MemorySecretStore::new());
        
        store2.store("key", "value").unwrap();
        
        let chain = ChainSecretStore::new(vec![store1, store2]);
        
        let info = chain.get_info("key");
        assert!(info.available);
        assert_eq!(info.source, "memory"); // From store2
        
        let not_found = chain.get_info("nonexistent");
        assert!(!not_found.available);
    }

    #[test]
    fn test_chain_store_delete() {
        let store1 = Arc::new(MemorySecretStore::new());
        let store2 = Arc::new(MemorySecretStore::new());
        
        store1.store("key", "value1").unwrap();
        store2.store("key", "value2").unwrap();
        
        let chain = ChainSecretStore::new(vec![store1.clone(), store2.clone()]);
        
        // Delete should remove from all stores
        chain.delete("key").unwrap();
        
        assert_eq!(store1.get("key"), None);
        assert_eq!(store2.get("key"), None);
    }

    #[test]
    fn test_chain_store_find_store() {
        let store1 = Arc::new(MemorySecretStore::new());
        let store2 = Arc::new(MemorySecretStore::new());
        
        store2.store("key", "value").unwrap();
        
        let chain = ChainSecretStore::new(vec![store1, store2]);
        
        let found = chain.find_store("key");
        assert!(found.is_some());
        assert_eq!(found.unwrap().name(), "memory");
    }

    #[test]
    #[should_panic(expected = "requires at least one store")]
    fn test_chain_store_empty_panics() {
        ChainSecretStore::new(vec![]);
    }

    #[test]
    #[should_panic(expected = "out of bounds")]
    fn test_chain_store_invalid_write_index_panics() {
        let store = Arc::new(MemorySecretStore::new());
        ChainSecretStore::with_write_store(vec![store], 5);
    }
}
