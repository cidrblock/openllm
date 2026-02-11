//! Logging abstractions for runtime-agnostic logging

mod traits;
mod noop;
mod console;
pub mod file_logger;

pub use traits::Logger;
pub use noop::NoOpLogger;
pub use console::ConsoleLogger;

// Re-export file logger functions for convenience
pub use file_logger::{
    log, trace, debug, info, warn, error,
    log_file_path, clear_log, LogLevel,
};
