//! Session management
//!
//! Handles session persistence, replay, and sharing.

mod manager;
mod persistence;
mod types;

pub use manager::SessionManager;
pub use types::{Session, ClientInfo, SessionMessage, MessageRole, ToolCall};
