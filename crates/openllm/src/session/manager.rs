//! Session manager

use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::persistence::SessionPersistence;
use super::types::{Session, ClientInfo};

/// Manages all chat sessions
pub struct SessionManager {
    /// In-memory session cache
    sessions: DashMap<String, Session>,
    
    /// Persistence layer
    persistence: Arc<RwLock<SessionPersistence>>,
}

impl SessionManager {
    /// Create a new session manager
    pub fn new() -> Self {
        let persistence = SessionPersistence::new();
        
        // Load existing sessions from disk
        let sessions = DashMap::new();
        if let Ok(loaded) = persistence.load_all() {
            for session in loaded {
                sessions.insert(session.id.clone(), session);
            }
        }
        
        Self {
            sessions,
            persistence: Arc::new(RwLock::new(persistence)),
        }
    }
    
    /// Create a new session
    pub async fn create(&self, model: String, created_by: ClientInfo, topic: Option<String>) -> Session {
        let mut session = Session::new(model, created_by);
        session.topic = topic;
        
        // Persist
        if let Err(e) = self.persistence.read().await.save(&session) {
            tracing::error!(error = %e, session_id = %session.id, "Failed to persist session");
        }
        
        self.sessions.insert(session.id.clone(), session.clone());
        session
    }
    
    /// Get a session by ID
    pub fn get(&self, id: &str) -> Option<Session> {
        self.sessions.get(id).map(|s| s.clone())
    }
    
    /// List all sessions
    pub fn list(&self, limit: Option<usize>, offset: Option<usize>) -> Vec<Session> {
        let mut sessions: Vec<_> = self.sessions.iter().map(|s| s.clone()).collect();
        
        // Sort by updated_at descending
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        
        let offset = offset.unwrap_or(0);
        let limit = limit.unwrap_or(usize::MAX);
        
        sessions.into_iter().skip(offset).take(limit).collect()
    }
    
    /// Update a session (add message, etc.)
    pub async fn update(&self, session: Session) -> Result<(), String> {
        // Persist
        if let Err(e) = self.persistence.read().await.save(&session) {
            tracing::error!(error = %e, session_id = %session.id, "Failed to persist session");
            return Err(format!("Failed to persist: {}", e));
        }
        
        self.sessions.insert(session.id.clone(), session);
        Ok(())
    }
    
    /// Delete a session
    pub async fn delete(&self, id: &str) -> bool {
        if self.sessions.remove(id).is_some() {
            if let Err(e) = self.persistence.read().await.delete(id) {
                tracing::error!(error = %e, session_id = %id, "Failed to delete session file");
            }
            true
        } else {
            false
        }
    }
    
    /// Fork a session
    pub async fn fork(&self, id: &str, fork_point: Option<usize>, new_model: Option<String>) -> Option<Session> {
        let original = self.get(id)?;
        let forked = original.fork(fork_point, new_model);
        
        // Persist
        if let Err(e) = self.persistence.read().await.save(&forked) {
            tracing::error!(error = %e, session_id = %forked.id, "Failed to persist forked session");
        }
        
        self.sessions.insert(forked.id.clone(), forked.clone());
        Some(forked)
    }
    
    /// Export a session as JSON
    pub fn export(&self, id: &str) -> Option<String> {
        let session = self.get(id)?;
        serde_json::to_string_pretty(&session).ok()
    }
    
    /// Import a session from JSON
    pub async fn import(&self, json: &str, generate_new_id: bool) -> Result<Session, String> {
        let mut session: Session = serde_json::from_str(json)
            .map_err(|e| format!("Invalid JSON: {}", e))?;
        
        if generate_new_id {
            session.id = uuid::Uuid::new_v4().to_string();
        }
        
        // Check for ID collision
        if !generate_new_id && self.sessions.contains_key(&session.id) {
            return Err(format!("Session {} already exists", session.id));
        }
        
        // Persist
        if let Err(e) = self.persistence.read().await.save(&session) {
            tracing::error!(error = %e, session_id = %session.id, "Failed to persist imported session");
            return Err(format!("Failed to persist: {}", e));
        }
        
        self.sessions.insert(session.id.clone(), session.clone());
        Ok(session)
    }
    
    /// Get session count
    pub fn count(&self) -> usize {
        self.sessions.len()
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}
