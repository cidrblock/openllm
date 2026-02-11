//! Transport layer for Unix sockets and TCP
//!
//! The daemon can listen on:
//! - Unix socket (default on Linux/macOS): ~/.openllm/daemon.sock
//! - Named pipe (Windows): \\.\pipe\openllm-daemon
//! - TCP (optional, for remote access): localhost:50051

use std::path::PathBuf;

/// Transport configuration
#[derive(Debug, Clone)]
pub enum Transport {
    /// Unix domain socket (Linux/macOS)
    UnixSocket(PathBuf),
    
    /// Named pipe (Windows)
    #[cfg(windows)]
    NamedPipe(String),
    
    /// TCP socket (cross-platform, for remote access)
    Tcp(std::net::SocketAddr),
}

impl Transport {
    /// Get the default transport for the current platform
    pub fn default_local() -> Self {
        #[cfg(unix)]
        {
            Transport::UnixSocket(Self::default_socket_path())
        }
        
        #[cfg(windows)]
        {
            Transport::NamedPipe(r"\\.\pipe\openllm-daemon".to_string())
        }
    }
    
    /// Get the default socket path
    #[cfg(unix)]
    pub fn default_socket_path() -> PathBuf {
        dirs::runtime_dir()
            .or_else(|| dirs::data_local_dir())
            .unwrap_or_else(|| PathBuf::from("/tmp"))
            .join("openllm")
            .join("daemon.sock")
    }
    
    /// Ensure the socket directory exists
    #[cfg(unix)]
    pub fn ensure_socket_dir(&self) -> std::io::Result<()> {
        if let Transport::UnixSocket(path) = self {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
        }
        Ok(())
    }
    
    /// Remove existing socket file if present
    #[cfg(unix)]
    pub fn cleanup_socket(&self) -> std::io::Result<()> {
        if let Transport::UnixSocket(path) = self {
            if path.exists() {
                std::fs::remove_file(path)?;
            }
        }
        Ok(())
    }
    
    /// Check if daemon is already running
    pub fn is_daemon_running(&self) -> bool {
        match self {
            #[cfg(unix)]
            Transport::UnixSocket(path) => path.exists(),
            
            #[cfg(windows)]
            Transport::NamedPipe(_) => {
                // TODO: Check if pipe exists
                false
            }
            
            Transport::Tcp(addr) => {
                std::net::TcpStream::connect_timeout(addr, std::time::Duration::from_millis(100)).is_ok()
            }
        }
    }
}

impl Default for Transport {
    fn default() -> Self {
        Self::default_local()
    }
}

/// Get the PID file path
pub fn pid_file_path() -> PathBuf {
    dirs::runtime_dir()
        .or_else(|| dirs::data_local_dir())
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("openllm")
        .join("daemon.pid")
}

/// Write PID file
pub fn write_pid_file() -> std::io::Result<()> {
    let path = pid_file_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, std::process::id().to_string())
}

/// Read PID from file
pub fn read_pid_file() -> Option<u32> {
    let path = pid_file_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// Remove PID file
pub fn remove_pid_file() -> std::io::Result<()> {
    let path = pid_file_path();
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(())
}
