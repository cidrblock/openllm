//! File-based debug logger for troubleshooting
//!
//! Provides a global logger that writes to a file for debugging purposes.
//! This is particularly useful when stderr/stdout isn't visible (e.g., in VS Code extension host).

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

/// Log levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Trace = 0,
    Debug = 1,
    Info = 2,
    Warn = 3,
    Error = 4,
}

impl std::fmt::Display for LogLevel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LogLevel::Trace => write!(f, "TRACE"),
            LogLevel::Debug => write!(f, "DEBUG"),
            LogLevel::Info => write!(f, "INFO "),
            LogLevel::Warn => write!(f, "WARN "),
            LogLevel::Error => write!(f, "ERROR"),
        }
    }
}

/// Global file logger configuration and state
struct FileLoggerState {
    file: Option<File>,
    min_level: LogLevel,
    enabled: bool,
}

impl FileLoggerState {
    fn new() -> Self {
        // Try to open log file at startup
        let log_path = Self::default_log_path();
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .ok();
        
        // Check if debug logging is enabled via environment variable
        let enabled = std::env::var("OPENLLM_DEBUG").map(|v| v == "1" || v.to_lowercase() == "true").unwrap_or(true);
        let min_level = std::env::var("OPENLLM_LOG_LEVEL")
            .map(|v| match v.to_lowercase().as_str() {
                "trace" => LogLevel::Trace,
                "debug" => LogLevel::Debug,
                "info" => LogLevel::Info,
                "warn" => LogLevel::Warn,
                "error" => LogLevel::Error,
                _ => LogLevel::Debug,
            })
            .unwrap_or(LogLevel::Debug);

        Self { file, min_level, enabled }
    }

    fn default_log_path() -> PathBuf {
        // Use /tmp on Unix, or temp dir on Windows
        let mut path = std::env::temp_dir();
        path.push("openllm-debug.log");
        path
    }

    fn write(&mut self, level: LogLevel, module: &str, message: &str) {
        if !self.enabled || level < self.min_level {
            return;
        }

        if let Some(ref mut file) = self.file {
            let timestamp = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| {
                    let secs = d.as_secs();
                    let millis = d.subsec_millis();
                    // Format as ISO-ish timestamp
                    let hours = (secs % 86400) / 3600;
                    let mins = (secs % 3600) / 60;
                    let secs = secs % 60;
                    format!("{:02}:{:02}:{:02}.{:03}", hours, mins, secs, millis)
                })
                .unwrap_or_else(|_| "??:??:??.???".to_string());

            let _ = writeln!(file, "[{}] [{}] [{}] {}", timestamp, level, module, message);
            let _ = file.flush();
        }
    }
}

/// Global logger instance
static LOGGER: OnceLock<Mutex<FileLoggerState>> = OnceLock::new();

fn get_logger() -> &'static Mutex<FileLoggerState> {
    LOGGER.get_or_init(|| Mutex::new(FileLoggerState::new()))
}

/// Log a message at the specified level
pub fn log(level: LogLevel, module: &str, message: &str) {
    if let Ok(mut logger) = get_logger().lock() {
        logger.write(level, module, message);
    }
}

/// Log a trace message
pub fn trace(module: &str, message: &str) {
    log(LogLevel::Trace, module, message);
}

/// Log a debug message
pub fn debug(module: &str, message: &str) {
    log(LogLevel::Debug, module, message);
}

/// Log an info message
pub fn info(module: &str, message: &str) {
    log(LogLevel::Info, module, message);
}

/// Log a warning message
pub fn warn(module: &str, message: &str) {
    log(LogLevel::Warn, module, message);
}

/// Log an error message
pub fn error(module: &str, message: &str) {
    log(LogLevel::Error, module, message);
}

/// Convenience macros for logging with automatic module name
#[macro_export]
macro_rules! debug_log {
    ($($arg:tt)*) => {
        $crate::logging::file_logger::debug(module_path!(), &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! info_log {
    ($($arg:tt)*) => {
        $crate::logging::file_logger::info(module_path!(), &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! warn_log {
    ($($arg:tt)*) => {
        $crate::logging::file_logger::warn(module_path!(), &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! error_log {
    ($($arg:tt)*) => {
        $crate::logging::file_logger::error(module_path!(), &format!($($arg)*))
    };
}

#[macro_export]
macro_rules! trace_log {
    ($($arg:tt)*) => {
        $crate::logging::file_logger::trace(module_path!(), &format!($($arg)*))
    };
}

/// Get the path to the log file
pub fn log_file_path() -> PathBuf {
    FileLoggerState::default_log_path()
}

/// Clear the log file
pub fn clear_log() {
    let path = log_file_path();
    if let Ok(file) = File::create(&path) {
        drop(file);
    }
    // Re-initialize the logger with a fresh file handle
    if let Ok(mut logger) = get_logger().lock() {
        logger.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_log_levels() {
        assert!(LogLevel::Debug > LogLevel::Trace);
        assert!(LogLevel::Info > LogLevel::Debug);
        assert!(LogLevel::Warn > LogLevel::Info);
        assert!(LogLevel::Error > LogLevel::Warn);
    }

    #[test]
    fn test_logging() {
        // Just make sure it doesn't panic
        debug("test", "test message");
        info("test", "test message");
        warn("test", "test message");
        error("test", "test message");
    }
}
