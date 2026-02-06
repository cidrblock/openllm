//! Console logger implementation

use super::traits::Logger;

/// A logger that outputs to the console (stdout/stderr)
#[derive(Debug, Clone)]
pub struct ConsoleLogger {
    prefix: String,
}

impl Default for ConsoleLogger {
    fn default() -> Self {
        Self::new()
    }
}

impl ConsoleLogger {
    /// Create a new console logger with default prefix
    pub fn new() -> Self {
        Self {
            prefix: "[OpenLLM]".to_string(),
        }
    }

    /// Create a console logger with a custom prefix
    pub fn with_prefix(prefix: impl Into<String>) -> Self {
        Self {
            prefix: prefix.into(),
        }
    }
}

impl Logger for ConsoleLogger {
    fn debug(&self, message: &str) {
        eprintln!("{} DEBUG: {}", self.prefix, message);
    }

    fn info(&self, message: &str) {
        println!("{} INFO: {}", self.prefix, message);
    }

    fn warn(&self, message: &str) {
        eprintln!("{} WARN: {}", self.prefix, message);
    }

    fn error(&self, message: &str) {
        eprintln!("{} ERROR: {}", self.prefix, message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_console_logger_creation() {
        let logger = ConsoleLogger::new();
        assert_eq!(logger.prefix, "[OpenLLM]");

        let custom = ConsoleLogger::with_prefix("[MyApp]");
        assert_eq!(custom.prefix, "[MyApp]");
    }

    #[test]
    fn test_console_logger_logs() {
        // This test just verifies the logger doesn't panic
        let logger = ConsoleLogger::new();
        logger.debug("debug message");
        logger.info("info message");
        logger.warn("warn message");
        logger.error("error message");
    }
}
