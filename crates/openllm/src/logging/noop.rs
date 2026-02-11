//! No-op logger implementation

use super::traits::Logger;

/// A logger that does nothing
///
/// Useful for testing or when logging is not needed.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoOpLogger;

impl NoOpLogger {
    /// Create a new no-op logger
    pub fn new() -> Self {
        Self
    }
}

impl Logger for NoOpLogger {
    fn debug(&self, _message: &str) {}
    fn info(&self, _message: &str) {}
    fn warn(&self, _message: &str) {}
    fn error(&self, _message: &str) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_noop_logger() {
        let logger = NoOpLogger::new();
        
        // These should all do nothing without panicking
        logger.debug("debug message");
        logger.info("info message");
        logger.warn("warn message");
        logger.error("error message");
    }
}
