//! Session persistence to disk

use std::fs;
use std::path::PathBuf;

use super::types::Session;

/// Handles reading/writing sessions to disk
pub struct SessionPersistence {
    /// Directory where sessions are stored
    sessions_dir: PathBuf,
}

impl SessionPersistence {
    /// Create a new persistence layer
    pub fn new() -> Self {
        let sessions_dir = Self::default_sessions_dir();
        
        // Ensure directory exists
        if let Err(e) = fs::create_dir_all(&sessions_dir) {
            tracing::error!(error = %e, path = ?sessions_dir, "Failed to create sessions directory");
        }
        
        Self { sessions_dir }
    }
    
    /// Get the default sessions directory
    fn default_sessions_dir() -> PathBuf {
        dirs::data_local_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("openllm")
            .join("sessions")
    }
    
    /// Save a session to disk
    pub fn save(&self, session: &Session) -> Result<(), std::io::Error> {
        let path = self.session_path(&session.id);
        let json = serde_json::to_string_pretty(session)?;
        fs::write(&path, json)?;
        tracing::debug!(session_id = %session.id, path = ?path, "Session saved");
        Ok(())
    }
    
    /// Load a session from disk
    pub fn load(&self, id: &str) -> Result<Session, std::io::Error> {
        let path = self.session_path(id);
        let json = fs::read_to_string(&path)?;
        let session: Session = serde_json::from_str(&json)?;
        Ok(session)
    }
    
    /// Delete a session from disk
    pub fn delete(&self, id: &str) -> Result<(), std::io::Error> {
        let path = self.session_path(id);
        if path.exists() {
            fs::remove_file(&path)?;
            tracing::debug!(session_id = %id, "Session deleted from disk");
        }
        Ok(())
    }
    
    /// Load all sessions from disk
    pub fn load_all(&self) -> Result<Vec<Session>, std::io::Error> {
        let mut sessions = Vec::new();
        
        if !self.sessions_dir.exists() {
            return Ok(sessions);
        }
        
        for entry in fs::read_dir(&self.sessions_dir)? {
            let entry = entry?;
            let path = entry.path();
            
            if path.extension().map(|e| e == "json").unwrap_or(false) {
                match fs::read_to_string(&path) {
                    Ok(json) => {
                        match serde_json::from_str::<Session>(&json) {
                            Ok(session) => sessions.push(session),
                            Err(e) => {
                                tracing::warn!(
                                    path = ?path,
                                    error = %e,
                                    "Failed to parse session file"
                                );
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(
                            path = ?path,
                            error = %e,
                            "Failed to read session file"
                        );
                    }
                }
            }
        }
        
        tracing::info!(count = sessions.len(), "Loaded sessions from disk");
        Ok(sessions)
    }
    
    /// Get the path for a session file
    fn session_path(&self, id: &str) -> PathBuf {
        self.sessions_dir.join(format!("{}.json", id))
    }
}

impl Default for SessionPersistence {
    fn default() -> Self {
        Self::new()
    }
}
