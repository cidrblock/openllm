//! Web dashboard server for OpenLLM
//!
//! This module provides an HTTP server that:
//! - Connects to the daemon via gRPC (as a client)
//! - Serves static files (HTML/CSS/JS dashboard)
//! - Proxies HTTP requests to gRPC calls
//! - Uses SSE for streaming chat responses

mod routes;
mod client;

pub use routes::create_router;
pub use client::create_grpc_client;

/// Default port for the web dashboard
pub const DEFAULT_WEB_PORT: u16 = 8787;
