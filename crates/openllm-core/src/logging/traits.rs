//! Logger trait definition

use std::sync::Arc;

/// Logger abstraction for runtime-agnostic logging
///
/// Implementations:
/// - `NoOpLogger`: Silent logger for testing
/// - `ConsoleLogger`: Logs to stdout/stderr
/// - VS Code adapter: Logs to VS Code output channel
pub trait Logger: Send + Sync {
    /// Log a debug message
    fn debug(&self, message: &str);

    /// Log an info message
    fn info(&self, message: &str);

    /// Log a warning message
    fn warn(&self, message: &str);

    /// Log an error message
    fn error(&self, message: &str);
}

/// Type alias for a boxed logger
pub type BoxedLogger = Box<dyn Logger>;

/// Type alias for an Arc-wrapped logger
pub type SharedLogger = Arc<dyn Logger>;

/// Extension trait for logging with format arguments
pub trait LoggerExt: Logger {
    /// Log a debug message with format arguments
    fn debug_fmt(&self, args: std::fmt::Arguments<'_>) {
        self.debug(&args.to_string());
    }

    /// Log an info message with format arguments
    fn info_fmt(&self, args: std::fmt::Arguments<'_>) {
        self.info(&args.to_string());
    }

    /// Log a warning message with format arguments
    fn warn_fmt(&self, args: std::fmt::Arguments<'_>) {
        self.warn(&args.to_string());
    }

    /// Log an error message with format arguments
    fn error_fmt(&self, args: std::fmt::Arguments<'_>) {
        self.error(&args.to_string());
    }
}

// Implement LoggerExt for all Logger implementations
impl<T: Logger + ?Sized> LoggerExt for T {}

/// Convenience macros for logging
#[macro_export]
macro_rules! log_debug {
    ($logger:expr, $($arg:tt)*) => {
        $logger.debug(&format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_info {
    ($logger:expr, $($arg:tt)*) => {
        $logger.info(&format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_warn {
    ($logger:expr, $($arg:tt)*) => {
        $logger.warn(&format!($($arg)*))
    };
}

#[macro_export]
macro_rules! log_error {
    ($logger:expr, $($arg:tt)*) => {
        $logger.error(&format!($($arg)*))
    };
}
