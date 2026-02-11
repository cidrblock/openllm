//! Secret storage abstractions and implementations
//!
//! This module provides a pluggable secret storage system with:
//! - `SecretStore` trait for implementing custom stores
//! - Built-in implementations: `MemorySecretStore`, `KeychainSecretStore`
//! - A registry for discovering and creating stores by name
//!
//! Note: Environment variable reading is handled explicitly via config,
//! not through a secret store abstraction.

mod traits;
mod memory_store;
mod keychain_store;
mod registry;

pub use traits::{SecretStore, SecretInfo, SecretStoreError, SecretStoreResult};
pub use memory_store::MemorySecretStore;
pub use keychain_store::KeychainSecretStore;
pub use registry::{register_secret_store, create_secret_store, list_secret_stores, StoreDefinition};
