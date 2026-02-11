//! gRPC server implementation

mod handlers;
mod mcp_bridge;
mod service;

pub use mcp_bridge::McpBridgeService;
pub use service::DaemonServer;
