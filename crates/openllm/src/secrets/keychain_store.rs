//! System keychain secret store
//!
//! Uses the OS keychain for secure secret storage:
//! - macOS: Keychain
//! - Windows: Credential Manager
//! - Linux: Secret Service (GNOME Keyring, KWallet)

use keyring::Entry;
use super::traits::{SecretStore, SecretStoreError, SecretInfo};
use crate::logging::file_logger as log;

/// Secret store backed by the system keychain
///
/// This provides secure, persistent storage for API keys and other secrets
/// using the operating system's native credential management:
///
/// - **macOS**: Keychain Services
/// - **Windows**: Credential Manager
/// - **Linux**: Secret Service API (GNOME Keyring, KWallet, etc.)
///
/// # Example
///
/// ```no_run
/// use openllm_core::secrets::KeychainSecretStore;
/// use openllm_core::secrets::SecretStore;
///
/// let store = KeychainSecretStore::new();
/// 
/// // Store a secret
/// store.store("openai", "sk-...").unwrap();
///
/// // Retrieve it
/// let key = store.get("openai");
/// assert!(key.is_some());
/// ```
pub struct KeychainSecretStore {
    service_name: String,
}

impl KeychainSecretStore {
    /// Create a new keychain store with the default service name "openllm"
    pub fn new() -> Self {
        Self::with_service("openllm")
    }

    /// Create a new keychain store with a custom service name
    ///
    /// The service name is used to namespace secrets in the keychain.
    /// For example, with service "openllm" and key "openai", the full
    /// keychain entry would be "openllm:openai".
    pub fn with_service(service: impl Into<String>) -> Self {
        Self {
            service_name: service.into(),
        }
    }

    /// Get a keyring entry for the given key
    fn entry(&self, key: &str) -> Result<Entry, SecretStoreError> {
        Entry::new(&self.service_name, key)
            .map_err(|e| SecretStoreError::Other(format!("Failed to create keychain entry: {}", e)))
    }
}

impl Default for KeychainSecretStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SecretStore for KeychainSecretStore {
    fn name(&self) -> &str {
        "keychain"
    }

    fn is_available(&self) -> bool {
        // Try to create an entry to check if keychain is available
        // This will fail on headless servers without a keychain daemon
        log::debug("KeychainSecretStore", &format!("is_available() called, service='{}'", self.service_name));
        match Entry::new(&self.service_name, "__openllm_availability_check__") {
            Ok(_) => {
                log::debug("KeychainSecretStore", "is_available() = true");
                true
            }
            Err(e) => {
                log::warn("KeychainSecretStore", &format!("is_available() = false, error: {:?}", e));
                false
            }
        }
    }

    fn get(&self, key: &str) -> Option<String> {
        log::debug("KeychainSecretStore", &format!("get() called for key='{}', service='{}'", key, self.service_name));
        match self.entry(key) {
            Ok(entry) => {
                match entry.get_password() {
                    Ok(password) => {
                        log::debug("KeychainSecretStore", &format!("get() SUCCESS, value len={}", password.len()));
                        Some(password)
                    },
                    Err(keyring::Error::NoEntry) => {
                        log::debug("KeychainSecretStore", "get() NoEntry");
                        None
                    },
                    Err(e) => {
                        log::warn("KeychainSecretStore", &format!("get() error: {:?}", e));
                        None
                    },
                }
            }
            Err(e) => {
                log::error("KeychainSecretStore", &format!("get() entry creation failed: {:?}", e));
                None
            }
        }
    }

    fn store(&self, key: &str, value: &str) -> Result<(), SecretStoreError> {
        log::info("KeychainSecretStore", &format!("store() called for key='{}', service='{}'", key, self.service_name));
        
        let entry = self.entry(key)?;
        log::debug("KeychainSecretStore", "Entry created, calling set_password...");
        
        entry.set_password(value)
            .map_err(|e| {
                log::error("KeychainSecretStore", &format!("set_password FAILED: {:?}", e));
                SecretStoreError::Other(format!("Failed to store in keychain: {}", e))
            })?;
        
        log::debug("KeychainSecretStore", "set_password returned Ok, verifying with NEW entry...");
        
        // Verify with a NEW Entry object to ensure it's actually persisted, not just cached
        let verify_entry = self.entry(key)?;
        match verify_entry.get_password() {
            Ok(retrieved) if retrieved == value => {
                log::info("KeychainSecretStore", "Verification SUCCESS - key persisted correctly");
                Ok(())
            },
            Ok(other) => {
                log::error("KeychainSecretStore", &format!("Verification FAILED - value mismatch: expected len={}, got len={}", value.len(), other.len()));
                Err(SecretStoreError::Other("Keychain store verification failed: value mismatch".to_string()))
            },
            Err(e) => {
                log::error("KeychainSecretStore", &format!("Verification FAILED - could not read back: {:?}", e));
                Err(SecretStoreError::Other(format!("Keychain store verification failed: could not read back: {}", e)))
            },
        }
    }

    fn delete(&self, key: &str) -> Result<(), SecretStoreError> {
        let entry = self.entry(key)?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()), // Already deleted
            Err(e) => Err(SecretStoreError::Other(format!("Failed to delete from keychain: {}", e))),
        }
    }

    fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    fn get_info(&self, key: &str) -> SecretInfo {
        SecretInfo {
            available: self.has(key),
            source: "keychain".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Note: These tests require a running keychain service
    // They may fail on CI systems without proper keychain setup
    
    #[test]
    #[ignore] // Requires system keychain
    fn test_store_and_get() {
        let store = KeychainSecretStore::with_service("openllm-test");
        
        // Clean up any existing test key
        let _ = store.delete("test_key");
        
        // Store and retrieve
        store.store("test_key", "test_value").unwrap();
        assert_eq!(store.get("test_key"), Some("test_value".to_string()));
        
        // Clean up
        store.delete("test_key").unwrap();
        assert_eq!(store.get("test_key"), None);
    }

    #[test]
    #[ignore] // Requires system keychain
    fn test_has() {
        let store = KeychainSecretStore::with_service("openllm-test");
        
        let _ = store.delete("has_test");
        
        assert!(!store.has("has_test"));
        store.store("has_test", "value").unwrap();
        assert!(store.has("has_test"));
        
        store.delete("has_test").unwrap();
    }

    #[test]
    fn test_name() {
        let store = KeychainSecretStore::new();
        assert_eq!(store.name(), "keychain");
    }
}
