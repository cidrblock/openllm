//! gRPC client for connecting to the daemon

use std::sync::Arc;
use tokio::sync::Mutex;
use tonic::transport::Channel;

use crate::proto::open_llm_client::OpenLlmClient;
use crate::transport::Transport;

/// Wrapper around the gRPC client for thread-safe access
pub struct DaemonClient {
    inner: Mutex<OpenLlmClient<Channel>>,
}

impl DaemonClient {
    /// Create a new daemon client from a channel
    pub fn new(channel: Channel) -> Self {
        Self {
            inner: Mutex::new(OpenLlmClient::new(channel)),
        }
    }
    
    /// Get access to the inner client
    pub async fn client(&self) -> tokio::sync::MutexGuard<'_, OpenLlmClient<Channel>> {
        self.inner.lock().await
    }
}

/// Create a gRPC client connected to the daemon
pub async fn create_grpc_client(transport: &Transport) -> Result<Arc<DaemonClient>, Box<dyn std::error::Error>> {
    let channel = match transport {
        #[cfg(unix)]
        Transport::UnixSocket(path) => {
            use hyper_util::rt::TokioIo;
            use tokio::net::UnixStream;
            use tonic::transport::Endpoint;
            
            let path = path.clone();
            
            // For Unix sockets, we use a dummy URI and custom connector
            let channel = Endpoint::try_from("http://[::]:50051")?
                .connect_with_connector(tower::service_fn(move |_| {
                    let path = path.clone();
                    async move {
                        let stream = UnixStream::connect(path).await?;
                        Ok::<_, std::io::Error>(TokioIo::new(stream))
                    }
                }))
                .await?;
            
            channel
        }
        
        Transport::Tcp(addr) => {
            use tonic::transport::Endpoint;
            
            let uri = format!("http://{}", addr);
            Endpoint::try_from(uri)?.connect().await?
        }
        
        #[cfg(windows)]
        Transport::NamedPipe(_) => {
            return Err("Named pipe not supported yet".into());
        }
    };
    
    Ok(Arc::new(DaemonClient::new(channel)))
}
