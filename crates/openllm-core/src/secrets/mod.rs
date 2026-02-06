//! Secret storage abstractions and implementations
//!
//! This module provides a pluggable secret storage system with:
//! - `SecretStore` trait for implementing custom stores
//! - Built-in implementations: `EnvSecretStore`, `MemorySecretStore`, `ChainSecretStore`, `KeychainSecretStore`
//! - A registry for discovering and creating stores by name

mod traits;
mod env_store;
mod memory_store;
mod chain_store;
mod keychain_store;
mod registry;

pub use traits::{SecretStore, SecretInfo, SecretStoreError, SecretStoreResult};
pub use env_store::EnvSecretStore;
pub use memory_store::MemorySecretStore;
pub use chain_store::ChainSecretStore;
pub use keychain_store::KeychainSecretStore;
pub use registry::{register_secret_store, create_secret_store, list_secret_stores, StoreDefinition};
