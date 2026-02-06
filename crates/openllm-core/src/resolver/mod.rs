//! Unified resolution for secrets and configuration
//!
//! This module provides a single entry point for resolving secrets and
//! configuration from multiple sources with proper priority ordering.

mod secret_resolver;
mod config_resolver;

pub use secret_resolver::{UnifiedSecretResolver, ResolvedSecret, SecretsStore};
pub use config_resolver::{UnifiedConfigResolver, ResolvedConfig, ResolvedProvider, ConfigSourcePreference};
