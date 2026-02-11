//! Daemon shared state
//!
//! Central state management for all daemon operations.

use dashmap::DashMap;
use parking_lot::RwLock;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, oneshot};
use chrono::{DateTime, Utc};
use tonic::Status;

use crate::proto::{ClientType, SessionEvent, VsCodeRequest, VsCodeResponse};
use crate::session::{Session, SessionManager};
use crate::providers::{self, Provider};
use crate::secrets::{SecretStore, KeychainSecretStore};
use crate::logging::{Logger, NoOpLogger};

/// Connected client information
#[derive(Debug, Clone)]
pub struct ConnectedClient {
    pub client_id: String,
    pub client_type: ClientType,
    pub connected_at: DateTime<Utc>,
    pub is_spawner: bool,
    pub workspace_path: Option<String>,
}

/// Registered MCP server information
#[derive(Debug, Clone)]
pub struct McpServer {
    pub server_id: String,
    pub transport: String,
    pub capabilities: Vec<String>,
}

/// Provider information for listing
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProviderInfo {
    pub id: String,
    pub display_name: String,
    pub configured: bool,
    pub healthy: bool,
}

/// Model information for listing
#[derive(Debug, Clone, serde::Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub provider: String,
    pub display_name: String,
    pub context_window: usize,
}

/// Secret info (without value) for listing
#[derive(Debug, Clone, serde::Serialize)]
pub struct SecretInfoPublic {
    pub key: String,
    pub has_value: bool,
}

/// Provider config entry from config.yaml
#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct ProviderConfigEntry {
    /// Keychain key name (mutually exclusive with api_key_env_var_name)
    #[serde(default)]
    pub api_key_keychain_name: Option<String>,
    /// Environment variable name (mutually exclusive with api_key_keychain_name)
    #[serde(default)]
    pub api_key_env_var_name: Option<String>,
    /// Enabled models for this provider
    #[serde(default)]
    pub enabled_models: Vec<String>,
}

/// VS Code connection for bidirectional communication
pub struct VsCodeConnection {
    /// Sender to push requests to VS Code
    pub request_tx: mpsc::Sender<Result<VsCodeRequest, Status>>,
}

/// Pending VS Code request waiting for response
pub struct PendingVsCodeRequest {
    pub response_tx: oneshot::Sender<VsCodeResponse>,
}

/// Central daemon state shared across all gRPC handlers
pub struct DaemonState {
    /// Version string
    pub version: String,
    
    /// When daemon started
    pub started_at: DateTime<Utc>,
    
    /// Connected clients
    pub clients: DashMap<String, ConnectedClient>,
    
    /// Session manager
    pub sessions: Arc<SessionManager>,
    
    /// Registered MCP servers
    pub mcp_servers: DashMap<String, McpServer>,
    
    /// Connected VS Code instances for backchannel
    pub vscode_connections: DashMap<String, VsCodeConnection>,
    
    /// Pending VS Code requests awaiting responses
    pending_vscode_requests: DashMap<String, PendingVsCodeRequest>,
    
    /// Session event broadcaster
    pub session_events: broadcast::Sender<SessionEvent>,
    
    /// Shutdown signal
    shutdown_tx: RwLock<Option<tokio::sync::oneshot::Sender<()>>>,
    
    /// Secret store (keychain + env fallback)
    pub secret_store: Arc<dyn SecretStore>,
    
    /// LLM providers by ID
    providers: DashMap<String, Arc<dyn Provider>>,
    
    /// Logger
    logger: Arc<dyn Logger>,
}

impl DaemonState {
    /// Create new daemon state
    pub fn new() -> Self {
        let (session_events, _) = broadcast::channel(100);
        
        // Create logger
        let logger: Arc<dyn Logger> = Arc::new(NoOpLogger);
        
        // Create secret store: keychain only
        // Environment variables are read explicitly based on config, not through secret store
        let secret_store: Arc<dyn SecretStore> = Arc::new(KeychainSecretStore::new());
        
        // Initialize providers
        let providers: DashMap<String, Arc<dyn Provider>> = DashMap::new();
        for provider_id in providers::supported_providers() {
            let provider = providers::create_provider(provider_id, Arc::clone(&logger));
            providers.insert(provider_id.to_string(), Arc::from(provider));
        }
        
        Self {
            version: env!("CARGO_PKG_VERSION").to_string(),
            started_at: Utc::now(),
            clients: DashMap::new(),
            sessions: Arc::new(SessionManager::new()),
            mcp_servers: DashMap::new(),
            vscode_connections: DashMap::new(),
            pending_vscode_requests: DashMap::new(),
            session_events,
            shutdown_tx: RwLock::new(None),
            secret_store,
            providers,
            logger,
        }
    }
    
    /// Get a provider by ID
    pub fn get_provider(&self, provider_id: &str) -> Option<Arc<dyn Provider>> {
        self.providers.get(provider_id).map(|p| Arc::clone(&*p))
    }
    
    /// Get provider for a model (extracts provider from "provider/model" format)
    pub fn get_provider_for_model(&self, model: &str) -> Option<Arc<dyn Provider>> {
        let provider_id = model.split('/').next()?;
        self.get_provider(provider_id)
    }
    
    /// List all providers with their status
    pub fn list_providers(&self) -> Vec<ProviderInfo> {
        let provider_config = self.load_provider_config();
        
        self.providers.iter().map(|entry| {
            let provider = entry.value();
            let meta = provider.metadata();
            let provider_id = entry.key().clone();
            
            // Check if provider is configured via config file
            let api_key = self.get_api_key_for_provider(&provider_id, &provider_config);
            let is_configured = api_key.is_some() || !meta.requires_api_key;
            
            ProviderInfo {
                id: provider_id,
                display_name: meta.display_name,
                configured: is_configured,
                healthy: true, // TODO: implement health checks
            }
        }).collect()
    }
    
    /// List available models (from configured providers) - synchronous version using cached/static
    pub fn list_models(&self) -> Vec<ModelInfo> {
        let provider_config = self.load_provider_config();
        let mut models = Vec::new();
        
        for entry in self.providers.iter() {
            let provider = entry.value();
            let meta = provider.metadata();
            let provider_id = entry.key().clone();
            
            // Check if provider is configured via config file
            let api_key = self.get_api_key_for_provider(&provider_id, &provider_config);
            let is_configured = api_key.is_some() || !meta.requires_api_key;
            
            if is_configured {
                for default_model in &meta.default_models {
                    models.push(ModelInfo {
                        id: format!("{}/{}", entry.key(), default_model.id),
                        provider: provider_id.clone(),
                        display_name: default_model.name.clone(),
                        context_window: default_model.context_length as usize,
                    });
                }
            }
        }
        
        models
    }

    /// Load provider config from the config file
    fn load_provider_config(&self) -> std::collections::HashMap<String, ProviderConfigEntry> {
        let config_path = dirs::home_dir()
            .map(|h| h.join(".openllm").join("config.yaml"))
            .unwrap_or_default();
        
        if !config_path.exists() {
            return std::collections::HashMap::new();
        }
        
        let content = match std::fs::read_to_string(&config_path) {
            Ok(c) => c,
            Err(e) => {
                tracing::warn!("Failed to read config file: {}", e);
                return std::collections::HashMap::new();
            }
        };
        
        #[derive(serde::Deserialize)]
        struct ConfigFile {
            #[serde(default)]
            providers: std::collections::HashMap<String, ProviderConfigEntry>,
        }
        
        match serde_yaml::from_str::<ConfigFile>(&content) {
            Ok(config) => config.providers,
            Err(e) => {
                tracing::warn!("Failed to parse config file: {}", e);
                std::collections::HashMap::new()
            }
        }
    }
    
    /// Get API key for a provider based on config
    fn get_api_key_for_provider(&self, provider_id: &str, config: &std::collections::HashMap<String, ProviderConfigEntry>) -> Option<String> {
        if let Some(provider_config) = config.get(provider_id) {
            // Check keychain first
            if let Some(keychain_name) = &provider_config.api_key_keychain_name {
                if let Some(value) = self.secret_store.get(keychain_name) {
                    return Some(value);
                }
            }
            // Check env var
            if let Some(env_var_name) = &provider_config.api_key_env_var_name {
                if let Ok(value) = std::env::var(env_var_name) {
                    if !value.is_empty() {
                        return Some(value);
                    }
                }
            }
        }
        None
    }
    
    /// List available models dynamically from provider APIs
    pub async fn list_models_dynamic(&self) -> Vec<ModelInfo> {
        // Load config to determine which providers are configured
        let provider_config = self.load_provider_config();
        
        // Collect provider info first to avoid lifetime issues with async
        let provider_infos: Vec<(String, Arc<dyn Provider>, Option<String>, bool)> = self.providers
            .iter()
            .map(|entry| {
                let provider = Arc::clone(entry.value());
                let meta = provider.metadata();
                let provider_id = entry.key().clone();
                
                // Check if provider is in config and has API key available
                let api_key = self.get_api_key_for_provider(&provider_id, &provider_config);
                let is_configured = api_key.is_some() || !meta.requires_api_key;
                
                (provider_id, provider, api_key, is_configured)
            })
            .collect();
        
        let mut models = Vec::new();
        
        for (provider_id, provider, api_key, is_configured) in provider_infos {
            if !is_configured {
                continue;
            }
            
            let meta = provider.metadata();
            
            // Try to fetch models dynamically
            match provider.list_models(api_key.as_deref()).await {
                Ok(Some(dynamic_models)) => {
                    for m in dynamic_models {
                        models.push(ModelInfo {
                            id: format!("{}/{}", provider_id, m.id),
                            provider: provider_id.clone(),
                            display_name: m.name,
                            context_window: m.context_length as usize,
                        });
                    }
                }
                Ok(None) => {
                    // Provider doesn't support dynamic listing, use static defaults
                    for default_model in &meta.default_models {
                        models.push(ModelInfo {
                            id: format!("{}/{}", provider_id, default_model.id),
                            provider: provider_id.clone(),
                            display_name: default_model.name.clone(),
                            context_window: default_model.context_length as usize,
                        });
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        provider = %provider_id,
                        error = %e,
                        "Failed to fetch models dynamically"
                    );
                }
            }
        }
        
        models
    }
    
    /// List secrets (without values)
    pub fn list_secrets(&self) -> Vec<SecretInfoPublic> {
        providers::supported_providers()
            .iter()
            .map(|p| {
                let key = format!("{}_API_KEY", p.to_uppercase());
                SecretInfoPublic {
                    key: key.clone(),
                    has_value: self.secret_store.has(&key),
                }
            })
            .collect()
    }
    
    /// Set a secret
    pub fn set_secret(&self, key: &str, value: &str) -> Result<(), String> {
        self.secret_store.store(key, value).map_err(|e| e.to_string())
    }
    
    /// Delete a secret
    pub fn delete_secret(&self, key: &str) -> Result<(), String> {
        self.secret_store.delete(key).map_err(|e| e.to_string())
    }
    
    /// Get a secret value
    pub fn get_secret(&self, key: &str) -> Option<String> {
        self.secret_store.get(key)
    }
    
    /// Get the logger
    pub fn logger(&self) -> Arc<dyn Logger> {
        Arc::clone(&self.logger)
    }
    
    /// Get number of connected clients
    pub fn connected_clients(&self) -> usize {
        self.clients.len()
    }
    
    /// Get number of active sessions
    pub fn active_sessions(&self) -> usize {
        self.sessions.count()
    }
    
    /// Register a new client
    pub fn register_client(&self, client_type: ClientType, is_spawner: bool, workspace_path: Option<String>) -> String {
        let client_id = uuid::Uuid::new_v4().to_string();
        
        self.clients.insert(client_id.clone(), ConnectedClient {
            client_id: client_id.clone(),
            client_type,
            connected_at: Utc::now(),
            is_spawner,
            workspace_path: workspace_path.clone(),
        });
        
        tracing::info!(
            client_id = %client_id,
            client_type = ?client_type,
            is_spawner = is_spawner,
            workspace_path = ?workspace_path,
            "Client registered"
        );
        
        client_id
    }
    
    /// Unregister a client
    pub fn unregister_client(&self, client_id: &str) -> Option<ConnectedClient> {
        let removed = self.clients.remove(client_id).map(|(_, c)| c);
        
        if removed.is_some() {
            tracing::info!(client_id = %client_id, "Client unregistered");
        }
        
        removed
    }
    
    /// Get count of connected clients
    pub fn client_count(&self) -> usize {
        self.clients.len()
    }
    
    /// Check if a spawner client is still connected
    pub fn has_spawner(&self) -> bool {
        self.clients.iter().any(|c| c.is_spawner)
    }
    
    /// Register an MCP server
    pub fn register_mcp_server(&self, server_id: String, transport: String, capabilities: Vec<String>) {
        self.mcp_servers.insert(server_id.clone(), McpServer {
            server_id: server_id.clone(),
            transport,
            capabilities,
        });
        
        tracing::info!(server_id = %server_id, "MCP server registered");
    }
    
    /// Unregister an MCP server
    pub fn unregister_mcp_server(&self, server_id: &str) {
        self.mcp_servers.remove(server_id);
        tracing::info!(server_id = %server_id, "MCP server unregistered");
    }
    
    /// Get list of MCP server IDs
    pub fn mcp_server_ids(&self) -> Vec<String> {
        self.mcp_servers.iter().map(|s| s.server_id.clone()).collect()
    }
    
    /// Subscribe to session events
    pub fn subscribe_session_events(&self) -> broadcast::Receiver<SessionEvent> {
        self.session_events.subscribe()
    }
    
    /// Broadcast a session event
    pub fn broadcast_session_event(&self, event: SessionEvent) {
        let _ = self.session_events.send(event);
    }
    
    /// Set shutdown signal sender
    pub fn set_shutdown_signal(&self, tx: tokio::sync::oneshot::Sender<()>) {
        *self.shutdown_tx.write() = Some(tx);
    }
    
    /// Trigger shutdown
    pub fn trigger_shutdown(&self) {
        if let Some(tx) = self.shutdown_tx.write().take() {
            let _ = tx.send(());
            tracing::info!("Shutdown triggered");
        }
    }
    
    //
    // VS Code Backchannel Management
    //
    
    /// Register a VS Code connection
    pub fn register_vscode_connection(&self, request_tx: mpsc::Sender<Result<VsCodeRequest, Status>>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        
        self.vscode_connections.insert(id.clone(), VsCodeConnection { request_tx });
        
        tracing::info!(vscode_id = %id, "VS Code connection registered");
        
        id
    }
    
    /// Unregister a VS Code connection
    pub fn unregister_vscode_connection(&self, id: &str) {
        self.vscode_connections.remove(id);
        tracing::info!(vscode_id = %id, "VS Code connection unregistered");
    }
    
    /// Check if any VS Code is connected
    pub fn has_vscode_connection(&self) -> bool {
        !self.vscode_connections.is_empty()
    }
    
    /// Send a request to VS Code and wait for response
    pub async fn call_vscode(&self, request: VsCodeRequest) -> Result<VsCodeResponse, Status> {
        // Find an available VS Code connection
        let request_tx = {
            let conn = self.vscode_connections.iter().next();
            match conn {
                Some(c) => c.request_tx.clone(),
                None => return Err(Status::unavailable("No VS Code connection available")),
            }
        };
        
        // Create a channel for the response
        let (response_tx, response_rx) = oneshot::channel();
        
        // Store the pending request
        let request_id = request.request_id.clone();
        self.pending_vscode_requests.insert(
            request_id.clone(),
            PendingVsCodeRequest { response_tx },
        );
        
        // Send the request to VS Code
        if let Err(e) = request_tx.send(Ok(request)).await {
            self.pending_vscode_requests.remove(&request_id);
            return Err(Status::internal(format!("Failed to send to VS Code: {}", e)));
        }
        
        // Wait for response with timeout
        match tokio::time::timeout(std::time::Duration::from_secs(30), response_rx).await {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(_)) => {
                self.pending_vscode_requests.remove(&request_id);
                Err(Status::internal("VS Code response channel closed"))
            }
            Err(_) => {
                self.pending_vscode_requests.remove(&request_id);
                Err(Status::deadline_exceeded("VS Code request timed out"))
            }
        }
    }
    
    /// Handle a response from VS Code
    pub fn handle_vscode_response(&self, response: VsCodeResponse) {
        if let Some((_, pending)) = self.pending_vscode_requests.remove(&response.request_id) {
            let _ = pending.response_tx.send(response);
        } else {
            tracing::warn!(
                request_id = %response.request_id,
                "Received VS Code response for unknown request"
            );
        }
    }

    /// Get workspaces from all connected VS Code clients
    pub async fn get_vscode_workspaces(&self) -> Vec<String> {
        let mut workspaces = Vec::new();
        
        // Get all VS Code connection IDs first to avoid holding the lock
        let connection_ids: Vec<String> = self.vscode_connections
            .iter()
            .map(|c| c.key().clone())
            .collect();
        
        for _conn_id in connection_ids {
            // Create a GetWorkspace request
            let request_id = uuid::Uuid::new_v4().to_string();
            let request = VsCodeRequest {
                request_id: request_id.clone(),
                request: Some(crate::proto::vs_code_request::Request::GetWorkspace(
                    crate::proto::GetWorkspaceRequest {}
                )),
            };
            
            // Call VS Code and wait for response
            match self.call_vscode(request).await {
                Ok(response) => {
                    if let Some(crate::proto::vs_code_response::Response::GetWorkspace(ws)) = response.response {
                        if !ws.workspace_path.is_empty() {
                            workspaces.push(ws.workspace_path);
                        }
                        // Also include all workspace folders
                        for folder in ws.workspace_folders {
                            if !folder.is_empty() && !workspaces.contains(&folder) {
                                workspaces.push(folder);
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "Failed to get workspace from VS Code");
                }
            }
        }
        
        // Deduplicate
        workspaces.sort();
        workspaces.dedup();
        workspaces
    }
}

impl Default for DaemonState {
    fn default() -> Self {
        Self::new()
    }
}
