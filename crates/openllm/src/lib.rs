//! OpenLLM - Unified AI Daemon
//!
//! A single Rust crate providing:
//! - LLM provider implementations (OpenAI, Anthropic, Ollama, etc.)
//! - gRPC API for all clients (VS Code, Python, Node.js, CLI)
//! - Session management with cross-tool continuity
//! - MCP bridge for high-performance tool execution
//! - Configuration and secrets management
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────┐
//! │  Clients (VS Code, Python, Node.js, CLI, Claude Desktop)        │
//! └─────────────────────────────────────────────────────────────────┘
//!                               │ gRPC
//!                               ▼
//! ┌─────────────────────────────────────────────────────────────────┐
//! │  openllm daemon                                                  │
//! │  ├── OpenLLM Service (chat, sessions, models, config)           │
//! │  ├── McpBridge Service (high-perf tool execution)               │
//! │  ├── Providers (OpenAI, Anthropic, Ollama, vscode.lm)           │
//! │  └── Session Manager (persistence, replay, sharing)             │
//! └─────────────────────────────────────────────────────────────────┘
//!                               │
//!           ┌───────────────────┼───────────────────┐
//!           ▼                   ▼                   ▼
//!      LLM APIs           MCP Servers          vscode.lm
//!    (HTTP direct)      (tools, resources)    (via MCP)
//! ```
//!
//! ## Quick Start
//!
//! Run the daemon:
//! ```bash
//! openllm
//! ```
//!
//! Then connect from any client (Python, Node.js, etc.) via gRPC.

// Core types and traits
pub mod types;
pub mod config;
pub mod logging;
pub mod secrets;

// LLM providers
pub mod providers;

// MCP client and tool orchestration
pub mod mcp;
pub mod tools;
pub mod resolver;

// gRPC server
pub mod proto;
pub mod server;
pub mod session;
pub mod state;
pub mod transport;

// Web UI
pub mod web;

// Re-exports for convenience
pub use server::{DaemonServer, McpBridgeService};
pub use state::DaemonState;
pub use session::{Session, SessionManager};
pub use types::{ChatMessage, MessageRole, StreamChunk};
pub use providers::Provider;
pub use mcp::McpClient;