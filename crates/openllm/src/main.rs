//! OpenLLM - Unified AI Daemon
//!
//! A unified AI daemon serving all OpenLLM clients via gRPC.
//!
//! Usage:
//!   openllm daemon       # Start daemon (foreground)
//!   openllm status       # Check daemon status
//!   openllm stop         # Stop running daemon
//!   openllm web          # Start web dashboard (connects to daemon)

use std::sync::Arc;
use tonic::transport::Server;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use openllm::{
    proto::open_llm_server::OpenLlmServer,
    proto::mcp_bridge_server::McpBridgeServer,
    server::{DaemonServer, McpBridgeService},
    state::DaemonState,
    transport::{Transport, write_pid_file, remove_pid_file},
    web::{self, DEFAULT_WEB_PORT},
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize logging
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(tracing_subscriber::fmt::layer())
        .init();
    
    // Parse args
    let args: Vec<String> = std::env::args().collect();
    
    // Get subcommand (first non-flag argument after program name)
    let subcommand = args.get(1).map(|s| s.as_str());
    
    match subcommand {
        Some("--help") | Some("-h") | Some("help") => {
            print_help();
            Ok(())
        }
        Some("--version") | Some("-v") | Some("version") => {
            println!("openllm {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some("daemon") | Some("--daemon") => {
            run_daemon().await
        }
        Some("status") | Some("--status") => {
            check_status()
        }
        Some("stop") | Some("--stop") => {
            stop_daemon()
        }
        Some("web") => {
            run_web_server().await
        }
        None => {
            // No subcommand - show help
            print_help();
            Ok(())
        }
        Some(cmd) => {
            eprintln!("Unknown command: {}", cmd);
            eprintln!("Run 'openllm --help' for usage");
            std::process::exit(1);
        }
    }
}

fn print_help() {
    println!(r#"OpenLLM - Unified AI Daemon

USAGE:
    openllm <COMMAND>

COMMANDS:
    daemon          Start the daemon (foreground)
    status          Check if daemon is running
    stop            Stop running daemon
    web             Start web dashboard (connects to daemon)
    help            Print help

OPTIONS:
    -h, --help      Print help
    -v, --version   Print version

DESCRIPTION:
    The OpenLLM daemon provides a unified gRPC interface for all OpenLLM
    clients (VS Code, Python, Node.js, CLI). It manages:
    
    - LLM provider connections and chat
    - Session persistence and replay
    - Tool orchestration via MCP
    - Configuration and secrets
    
    Start the daemon first with 'openllm daemon', then optionally run
    'openllm web' to start the web dashboard at http://localhost:8787
"#);
}

fn check_status() -> Result<(), Box<dyn std::error::Error>> {
    let transport = Transport::default_local();
    
    if transport.is_daemon_running() {
        println!("OpenLLM daemon is running");
        
        if let Some(pid) = openllm::transport::read_pid_file() {
            println!("  PID: {}", pid);
        }
        
        match &transport {
            #[cfg(unix)]
            Transport::UnixSocket(path) => println!("  Socket: {}", path.display()),
            Transport::Tcp(addr) => println!("  Address: {}", addr),
            #[cfg(windows)]
            Transport::NamedPipe(name) => println!("  Pipe: {}", name),
        }
        
        Ok(())
    } else {
        println!("OpenLLM daemon is not running");
        std::process::exit(1);
    }
}

fn stop_daemon() -> Result<(), Box<dyn std::error::Error>> {
    let transport = Transport::default_local();
    
    if let Some(pid) = openllm::transport::read_pid_file() {
        #[cfg(unix)]
        {
            use std::process::Command;
            
            // First try graceful SIGTERM
            let status = Command::new("kill")
                .arg("-TERM")
                .arg(pid.to_string())
                .status()?;
            
            if status.success() {
                println!("Sent SIGTERM to daemon (PID {})", pid);
                
                // Wait a moment for cleanup, then verify it stopped
                std::thread::sleep(std::time::Duration::from_millis(500));
                
                // Check if process is still running
                let still_running = Command::new("kill")
                    .arg("-0")
                    .arg(pid.to_string())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                
                if still_running {
                    // Wait a bit more then force kill
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let _ = Command::new("kill")
                        .arg("-9")
                        .arg(pid.to_string())
                        .status();
                    println!("Force killed daemon");
                }
            }
            
            // Clean up PID file and socket regardless
            if let Err(e) = remove_pid_file() {
                tracing::debug!("Could not remove PID file: {}", e);
            }
            if let Err(e) = transport.cleanup_socket() {
                tracing::debug!("Could not remove socket: {}", e);
            }
            
            println!("Daemon stopped and cleaned up");
            Ok(())
        }
        
        #[cfg(windows)]
        {
            // TODO: Windows process termination
            eprintln!("Stop not implemented on Windows yet");
            std::process::exit(1);
        }
    } else {
        // No PID file, but maybe stale socket exists - clean it up
        if let Err(_) = transport.cleanup_socket() {
            // Ignore
        }
        eprintln!("No daemon PID file found (cleaned up any stale socket)");
        std::process::exit(1);
    }
}

async fn run_daemon() -> Result<(), Box<dyn std::error::Error>> {
    let transport = Transport::default_local();
    
    // Check if already running
    if transport.is_daemon_running() {
        eprintln!("OpenLLM daemon is already running");
        std::process::exit(1);
    }
    
    // Create shared state
    let state = Arc::new(DaemonState::new());
    
    // Set up shutdown signal
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    state.set_shutdown_signal(shutdown_tx);
    
    // Create gRPC services
    let openllm_service = DaemonServer::new(state.clone());
    let mcp_bridge_service = McpBridgeService::new(state.clone());
    
    tracing::info!(version = %state.version, "Starting OpenLLM daemon");
    tracing::info!("Services: OpenLLM API + MCP Bridge (gRPC)");
    
    // Start server based on transport
    match &transport {
        #[cfg(unix)]
        Transport::UnixSocket(path) => {
            use tokio::net::UnixListener;
            use tokio_stream::wrappers::UnixListenerStream;
            
            // Ensure directory exists and clean up old socket
            transport.ensure_socket_dir()?;
            transport.cleanup_socket()?;
            
            // Write PID file
            write_pid_file()?;
            
            let listener = UnixListener::bind(path)?;
            tracing::info!(path = %path.display(), "Listening on Unix socket");
            
            let incoming = UnixListenerStream::new(listener);
            
            // Handle shutdown signals (Ctrl+C and SIGTERM)
            let shutdown_state = state.clone();
            tokio::spawn(async move {
                let ctrl_c = tokio::signal::ctrl_c();
                
                #[cfg(unix)]
                {
                    use tokio::signal::unix::{signal, SignalKind};
                    let mut sigterm = signal(SignalKind::terminate()).expect("Failed to register SIGTERM handler");
                    
                    tokio::select! {
                        _ = ctrl_c => {
                            tracing::info!("Received Ctrl+C, shutting down");
                        }
                        _ = sigterm.recv() => {
                            tracing::info!("Received SIGTERM, shutting down");
                        }
                    }
                }
                
                #[cfg(not(unix))]
                {
                    ctrl_c.await.ok();
                    tracing::info!("Received Ctrl+C, shutting down");
                }
                
                shutdown_state.trigger_shutdown();
            });
            
            // Wrap services with tonic-web for gRPC-Web support (browser clients)
            let grpc_web_layer = tonic_web::GrpcWebLayer::new();
            
            Server::builder()
                .accept_http1(true)  // Required for gRPC-Web
                .layer(grpc_web_layer)
                .add_service(OpenLlmServer::new(openllm_service))
                .add_service(McpBridgeServer::new(mcp_bridge_service))
                .serve_with_incoming_shutdown(incoming, async {
                    shutdown_rx.await.ok();
                })
                .await?;
            
            // Cleanup
            transport.cleanup_socket()?;
            remove_pid_file()?;
        }
        
        Transport::Tcp(addr) => {
            // Write PID file
            write_pid_file()?;
            
            tracing::info!(addr = %addr, "Listening on TCP");
            
            // Handle shutdown signals (Ctrl+C and SIGTERM)
            let shutdown_state = state.clone();
            tokio::spawn(async move {
                let ctrl_c = tokio::signal::ctrl_c();
                
                #[cfg(unix)]
                {
                    use tokio::signal::unix::{signal, SignalKind};
                    let mut sigterm = signal(SignalKind::terminate()).expect("Failed to register SIGTERM handler");
                    
                    tokio::select! {
                        _ = ctrl_c => {
                            tracing::info!("Received Ctrl+C, shutting down");
                        }
                        _ = sigterm.recv() => {
                            tracing::info!("Received SIGTERM, shutting down");
                        }
                    }
                }
                
                #[cfg(not(unix))]
                {
                    ctrl_c.await.ok();
                    tracing::info!("Received Ctrl+C, shutting down");
                }
                
                shutdown_state.trigger_shutdown();
            });
            
            Server::builder()
                .add_service(OpenLlmServer::new(openllm_service))
                .add_service(McpBridgeServer::new(mcp_bridge_service))
                .serve_with_shutdown(*addr, async {
                    shutdown_rx.await.ok();
                })
                .await?;
            
            remove_pid_file()?;
        }
        
        #[cfg(windows)]
        Transport::NamedPipe(_) => {
            // TODO: Windows named pipe support
            eprintln!("Named pipe support not implemented yet");
            std::process::exit(1);
        }
    }
    
    tracing::info!("Daemon stopped");
    Ok(())
}

/// Run the web dashboard server
/// 
/// This connects to the daemon via gRPC and serves an HTTP interface.
async fn run_web_server() -> Result<(), Box<dyn std::error::Error>> {
    let transport = Transport::default_local();
    
    // Check if daemon is running
    if !transport.is_daemon_running() {
        eprintln!("OpenLLM daemon is not running. Start it with: openllm daemon");
        std::process::exit(1);
    }
    
    // Create gRPC client to daemon
    let client = web::create_grpc_client(&transport).await?;
    
    // Create web server router
    let app = web::create_router(client);
    
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], DEFAULT_WEB_PORT));
    tracing::info!(addr = %addr, "Web dashboard listening");
    println!("OpenLLM Web Dashboard: http://{}", addr);
    
    let listener = tokio::net::TcpListener::bind(addr).await?;
    
    // Handle Ctrl+C
    tokio::spawn(async {
        tokio::signal::ctrl_c().await.ok();
        tracing::info!("Received Ctrl+C, shutting down web server");
        std::process::exit(0);
    });
    
    axum::serve(listener, app).await?;
    
    Ok(())
}
