//! Configuration provider abstractions
//!
//! Supports multiple configuration sources:
//! - `MemoryConfigProvider`: In-memory for testing
//! - `FileConfigProvider`: YAML file-based (user/workspace level)

mod traits;
mod memory;
mod file;

pub use traits::{ConfigProvider, ConfigError, ConfigResult};
pub use memory::MemoryConfigProvider;
pub use file::{FileConfigProvider, ConfigFile, ConfigLevel, DefaultSettings};