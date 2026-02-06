//! Tool management module
//!
//! This module provides tool discovery, filtering, and orchestration
//! for LLM tool calling. It acts as the central coordinator for tools
//! from various sources (VS Code, MCP servers, etc.).
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────┐
//! │  ToolRegistry (Rust)                        │
//! │                                             │
//! │  - Fetches tools via MCP tools/list         │
//! │  - Filters internal tools (openllm_*)       │
//! │  - Applies user preferences                 │
//! │  - Provides tools to LLM                    │
//! │  - Orchestrates tool calling loop           │
//! └─────────────────────────────────────────────┘
//!           │
//!           │ RPC (tools/list, tools/call)
//!           ▼
//! ┌─────────────────────────────────────────────┐
//! │  VS Code Extension (MCP Server)             │
//! │                                             │
//! │  Internal tools:                            │
//! │    - openllm_secrets_*, openllm_config_*    │
//! │                                             │
//! │  User tools:                                │
//! │    - cursor_*, vscode.lm.tools              │
//! └─────────────────────────────────────────────┘
//! ```

mod registry;

pub use registry::{ToolRegistry, ToolFilter, ToolInfo};
