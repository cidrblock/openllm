//! Environment variable secret store

use std::collections::HashMap;
use std::env;

use once_cell::sync::Lazy;

use super::traits::{SecretStore, SecretInfo, SecretStoreError, SecretStoreResult};

/// Mapping from provider names to environment variable names
static ENV_VAR_MAP: Lazy<HashMap<&'static str, Vec<&'static str>>> = Lazy::new(|| {
    let mut m = HashMap::new();
    m.insert("openai", vec!["OPENAI_API_KEY"]);
    m.insert("anthropic", vec!["ANTHROPIC_API_KEY"]);
    m.insert("gemini", vec!["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    m.insert("google", vec!["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    m.insert("mistral", vec!["MISTRAL_API_KEY"]);
    m.insert("azure", vec!["AZURE_API_KEY", "AZURE_OPENAI_API_KEY"]);
    m.insert("openrouter", vec!["OPENROUTER_API_KEY"]);
    m.insert("ollama", vec![]); // Ollama doesn't need an API key
    m
});

/// Secret store that reads from environment variables
///
/// This store is read-only - it can only read environment variables,
/// not set them. Use this for accessing API keys set in the shell
/// or in `.env` files loaded by dotenv.
///
/// # Provider Mapping
///
/// The store automatically maps provider names to environment variables:
/// - `openai` → `OPENAI_API_KEY`
/// - `anthropic` → `ANTHROPIC_API_KEY`
/// - `gemini` → `GEMINI_API_KEY` or `GOOGLE_API_KEY`
/// - etc.
///
/// You can also access environment variables directly by their full name.
///
/// # Example
///
/// ```
/// use openllm_core::secrets::{SecretStore, EnvSecretStore};
///
/// let store = EnvSecretStore::new();
///
/// // These are equivalent if OPENAI_API_KEY is set:
/// let key1 = store.get("openai");
/// let key2 = store.get("OPENAI_API_KEY");
/// ```
#[derive(Debug, Default)]
pub struct EnvSecretStore {
    _private: (), // Prevent direct construction, use new()
}

impl EnvSecretStore {
    /// Create a new environment variable secret store
    pub fn new() -> Self {
        Self { _private: () }
    }

    /// Get the environment variable names for a provider
    pub fn get_env_vars_for_provider(provider: &str) -> Option<&'static [&'static str]> {
        ENV_VAR_MAP.get(provider.to_lowercase().as_str()).map(|v| v.as_slice())
    }
}

impl SecretStore for EnvSecretStore {
    fn name(&self) -> &str {
        "env"
    }

    fn get(&self, key: &str) -> Option<String> {
        // First, try the key as-is (for direct env var access)
        if let Ok(value) = env::var(key) {
            if !value.is_empty() {
                return Some(value);
            }
        }

        // Then, try mapping from provider name to env var
        let lower_key = key.to_lowercase();
        if let Some(env_vars) = ENV_VAR_MAP.get(lower_key.as_str()) {
            for env_var in env_vars {
                if let Ok(value) = env::var(env_var) {
                    if !value.is_empty() {
                        return Some(value);
                    }
                }
            }
        }

        // Finally, try the uppercase version with _API_KEY suffix
        let auto_key = format!("{}_API_KEY", key.to_uppercase());
        if let Ok(value) = env::var(&auto_key) {
            if !value.is_empty() {
                return Some(value);
            }
        }

        None
    }

    fn store(&self, _key: &str, _value: &str) -> SecretStoreResult<()> {
        Err(SecretStoreError::ReadOnly)
    }

    fn delete(&self, _key: &str) -> SecretStoreResult<()> {
        Err(SecretStoreError::ReadOnly)
    }

    fn get_info(&self, key: &str) -> SecretInfo {
        if self.has(key) {
            SecretInfo::new(true, self.name())
        } else {
            SecretInfo::not_found()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_env_store_name() {
        let store = EnvSecretStore::new();
        assert_eq!(store.name(), "env");
    }

    #[test]
    fn test_env_store_read_only() {
        let store = EnvSecretStore::new();
        assert!(matches!(store.store("test", "value"), Err(SecretStoreError::ReadOnly)));
        assert!(matches!(store.delete("test"), Err(SecretStoreError::ReadOnly)));
    }

    #[test]
    fn test_env_store_get_direct() {
        // Set a test env var
        env::set_var("TEST_SECRET_12345", "test_value");
        
        let store = EnvSecretStore::new();
        assert_eq!(store.get("TEST_SECRET_12345"), Some("test_value".to_string()));
        
        // Clean up
        env::remove_var("TEST_SECRET_12345");
    }

    #[test]
    fn test_env_store_get_mapped() {
        // Set OPENAI_API_KEY
        env::set_var("OPENAI_API_KEY", "sk-test-12345");
        
        let store = EnvSecretStore::new();
        
        // Should find via provider name
        assert_eq!(store.get("openai"), Some("sk-test-12345".to_string()));
        assert_eq!(store.get("OpenAI"), Some("sk-test-12345".to_string())); // Case insensitive
        
        // Should also find via direct name
        assert_eq!(store.get("OPENAI_API_KEY"), Some("sk-test-12345".to_string()));
        
        // Clean up
        env::remove_var("OPENAI_API_KEY");
    }

    #[test]
    fn test_env_store_get_not_found() {
        let store = EnvSecretStore::new();
        assert_eq!(store.get("nonexistent_provider_xyz"), None);
    }

    #[test]
    fn test_env_store_has() {
        env::set_var("TEST_HAS_SECRET", "value");
        
        let store = EnvSecretStore::new();
        assert!(store.has("TEST_HAS_SECRET"));
        assert!(!store.has("NONEXISTENT_SECRET_XYZ"));
        
        env::remove_var("TEST_HAS_SECRET");
    }

    #[test]
    fn test_env_store_get_info() {
        env::set_var("TEST_INFO_SECRET", "value");
        
        let store = EnvSecretStore::new();
        
        let info = store.get_info("TEST_INFO_SECRET");
        assert!(info.available);
        assert_eq!(info.source, "env");
        
        let not_found = store.get_info("NONEXISTENT_XYZ");
        assert!(!not_found.available);
        
        env::remove_var("TEST_INFO_SECRET");
    }
}
