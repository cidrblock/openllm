//! Core traits and types for secret storage

use thiserror::Error;

/// Information about a secret
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretInfo {
    /// Whether the secret exists
    pub available: bool,
    /// Which store provided the secret (useful for chain stores)
    pub source: String,
}

impl SecretInfo {
    pub fn new(available: bool, source: impl Into<String>) -> Self {
        Self {
            available,
            source: source.into(),
        }
    }

    pub fn not_found() -> Self {
        Self {
            available: false,
            source: "none".to_string(),
        }
    }
}

/// Errors that can occur during secret store operations
#[derive(Error, Debug)]
pub enum SecretStoreError {
    #[error("Store is read-only")]
    ReadOnly,

    #[error("Secret not found: {0}")]
    NotFound(String),

    #[error("Store not available: {0}")]
    NotAvailable(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Store error: {0}")]
    Other(String),
}

pub type SecretStoreResult<T> = Result<T, SecretStoreError>;

/// Trait for secret storage implementations
///
/// Implementations can be:
/// - Environment variables (`EnvSecretStore`)
/// - In-memory for testing (`MemorySecretStore`)
/// - Chained for fallback behavior (`ChainSecretStore`)
/// - Custom implementations (database, keychain, Vault, etc.)
///
/// # Example
///
/// ```
/// use openllm_core::secrets::{SecretStore, EnvSecretStore};
///
/// let store = EnvSecretStore::new();
/// // store.get("openai") will check OPENAI_API_KEY
/// ```
pub trait SecretStore: Send + Sync {
    /// Human-readable name of this store
    fn name(&self) -> &str;

    /// Check if this store is available
    ///
    /// For example, a keychain store might not be available on a headless server.
    fn is_available(&self) -> bool {
        true
    }

    /// Retrieve a secret by key
    ///
    /// The key can be:
    /// - A provider name (e.g., "openai") which gets mapped to the appropriate env var
    /// - A direct key (e.g., "OPENAI_API_KEY")
    fn get(&self, key: &str) -> Option<String>;

    /// Store a secret
    ///
    /// Returns `Err(SecretStoreError::ReadOnly)` if the store doesn't support writing.
    fn store(&self, key: &str, value: &str) -> SecretStoreResult<()>;

    /// Delete a secret
    ///
    /// Returns `Err(SecretStoreError::ReadOnly)` if the store doesn't support deletion.
    fn delete(&self, key: &str) -> SecretStoreResult<()>;

    /// Check if a secret exists
    fn has(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    /// Get information about a secret
    fn get_info(&self, key: &str) -> SecretInfo {
        SecretInfo::new(self.has(key), self.name())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_info() {
        let info = SecretInfo::new(true, "test");
        assert!(info.available);
        assert_eq!(info.source, "test");

        let not_found = SecretInfo::not_found();
        assert!(!not_found.available);
        assert_eq!(not_found.source, "none");
    }
}
