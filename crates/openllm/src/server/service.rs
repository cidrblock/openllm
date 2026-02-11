//! OpenLLM gRPC service implementation

use std::pin::Pin;
use std::sync::Arc;
use tonic::{Request, Response, Status};
use tokio_stream::Stream;
use crate::proto::{
    open_llm_server::OpenLlm,
    // Chat
    ChatRequest, ChatChunk, SessionChatRequest,
    // Sessions
    CreateSessionRequest, Session as ProtoSession, GetSessionRequest,
    ListSessionsRequest, ListSessionsResponse, SessionSummary,
    DeleteSessionRequest, WatchSessionsRequest, SessionEvent,
    ReplaySessionRequest, ReplaySessionResponse, ReplayFormat,
    SummarizeSessionRequest, SummarizeSessionResponse,
    ForkSessionRequest, ExportSessionRequest, ExportSessionResponse,
    ImportSessionRequest,
    // Models & Providers
    ListModelsRequest, ListModelsResponse,
    ListProvidersRequest, ListProvidersResponse,
    GetProviderStatusRequest, ProviderStatus,
    // Tools
    ListToolsRequest, ListToolsResponse,
    ExecuteToolRequest, ExecuteToolResponse,
    // Config
    GetConfigRequest, Config, UpdateConfigRequest,
    // Secrets
    GetSecretRequest, GetSecretResponse,
    SetSecretRequest, DeleteSecretRequest,
    ListSecretsRequest, ListSecretsResponse,
    // Lifecycle
    RegisterRequest, RegisterResponse,
    UnregisterRequest, GetStatusRequest, DaemonStatus,
    GetConnectedWorkspacesRequest, GetConnectedWorkspacesResponse,
    ShutdownRequest, HealthCheckRequest, HealthCheckResponse,
    ConnectedClient as ProtoConnectedClient,
    // MCP
    RegisterMcpServerRequest, UnregisterMcpServerRequest,
    ClientType,
    // VSCode backchannel
    VsCodeRequest, VsCodeResponse,
    // Types
    Timestamp,
    Empty,
};
use crate::state::DaemonState;
use crate::session::{ClientInfo, Session};

type ResponseStream<T> = Pin<Box<dyn Stream<Item = Result<T, Status>> + Send>>;

/// The main gRPC service implementation
pub struct DaemonServer {
    state: Arc<DaemonState>,
}

impl DaemonServer {
    /// Create a new daemon server
    pub fn new(state: Arc<DaemonState>) -> Self {
        Self { state }
    }
}

#[tonic::async_trait]
impl OpenLlm for DaemonServer {
    //
    // Chat
    //
    
    type ChatStream = ResponseStream<ChatChunk>;
    
    async fn chat(
        &self,
        request: Request<ChatRequest>,
    ) -> Result<Response<Self::ChatStream>, Status> {
        let req = request.into_inner();
        tracing::info!(model = %req.model, message_count = req.messages.len(), "Chat request");
        
        // TODO: Implement actual chat using openllm-core providers
        // For now, return a placeholder response
        
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        
        tokio::spawn(async move {
            use crate::proto::{TextChunk, DoneChunk, chat_chunk::Chunk};
            
            // Placeholder response
            let _ = tx.send(Ok(ChatChunk {
                chunk: Some(Chunk::Text(TextChunk {
                    text: format!("Hello! You asked me using model {}. Chat implementation coming soon.", req.model),
                })),
            })).await;
            
            let _ = tx.send(Ok(ChatChunk {
                chunk: Some(Chunk::Done(DoneChunk {
                    finish_reason: "stop".to_string(),
                })),
            })).await;
        });
        
        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream)))
    }
    
    type SessionChatStream = ResponseStream<ChatChunk>;
    
    async fn session_chat(
        &self,
        request: Request<SessionChatRequest>,
    ) -> Result<Response<Self::SessionChatStream>, Status> {
        let req = request.into_inner();
        
        // Get the session
        let session = self.state.sessions.get(&req.session_id)
            .ok_or_else(|| Status::not_found(format!("Session {} not found", req.session_id)))?;
        
        tracing::info!(
            session_id = %req.session_id,
            model = %session.model,
            "Session chat request"
        );
        
        // TODO: Implement actual chat with session context
        
        let (tx, rx) = tokio::sync::mpsc::channel(100);
        
        let model = session.model.clone();
        tokio::spawn(async move {
            use crate::proto::{TextChunk, DoneChunk, chat_chunk::Chunk};
            
            let _ = tx.send(Ok(ChatChunk {
                chunk: Some(Chunk::Text(TextChunk {
                    text: format!("Continuing session with model {}. Full implementation coming soon.", model),
                })),
            })).await;
            
            let _ = tx.send(Ok(ChatChunk {
                chunk: Some(Chunk::Done(DoneChunk {
                    finish_reason: "stop".to_string(),
                })),
            })).await;
        });
        
        let stream = tokio_stream::wrappers::ReceiverStream::new(rx);
        Ok(Response::new(Box::pin(stream)))
    }
    
    //
    // Sessions
    //
    
    async fn create_session(
        &self,
        request: Request<CreateSessionRequest>,
    ) -> Result<Response<ProtoSession>, Status> {
        let req = request.into_inner();
        
        let client_info = ClientInfo {
            client_type: "unknown".to_string(), // Would come from auth/context
            client_id: "".to_string(),
            user: None,
        };
        
        let session = self.state.sessions
            .create(req.model, client_info, req.topic)
            .await;
        
        tracing::info!(session_id = %session.id, "Session created");
        
        Ok(Response::new(session.to_proto()))
    }
    
    async fn get_session(
        &self,
        request: Request<GetSessionRequest>,
    ) -> Result<Response<ProtoSession>, Status> {
        let req = request.into_inner();
        
        let session = self.state.sessions.get(&req.session_id)
            .ok_or_else(|| Status::not_found(format!("Session {} not found", req.session_id)))?;
        
        Ok(Response::new(session.to_proto()))
    }
    
    async fn list_sessions(
        &self,
        request: Request<ListSessionsRequest>,
    ) -> Result<Response<ListSessionsResponse>, Status> {
        let req = request.into_inner();
        
        let sessions = self.state.sessions.list(
            Some(req.limit as usize),
            Some(req.offset as usize),
        );
        
        let summaries: Vec<SessionSummary> = sessions.iter().map(|s| {
            SessionSummary {
                id: s.id.clone(),
                model: s.model.clone(),
                topic: s.topic.clone().unwrap_or_default(),
                message_count: s.message_count() as i32,
                source: match s.created_by.client_type.as_str() {
                    "vscode" => ClientType::Vscode.into(),
                    "cli" => ClientType::Cli.into(),
                    "python" => ClientType::Python.into(),
                    "nodejs" => ClientType::Nodejs.into(),
                    "mcp" => ClientType::Mcp.into(),
                    _ => ClientType::Unspecified.into(),
                },
                created_at: Some(Timestamp {
                    seconds: s.created_at.timestamp(),
                    nanos: s.created_at.timestamp_subsec_nanos() as i32,
                }),
                updated_at: Some(Timestamp {
                    seconds: s.updated_at.timestamp(),
                    nanos: s.updated_at.timestamp_subsec_nanos() as i32,
                }),
            }
        }).collect();
        
        Ok(Response::new(ListSessionsResponse {
            sessions: summaries,
            total_count: self.state.sessions.count() as i32,
        }))
    }
    
    async fn delete_session(
        &self,
        request: Request<DeleteSessionRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        
        if self.state.sessions.delete(&req.session_id).await {
            tracing::info!(session_id = %req.session_id, "Session deleted");
            Ok(Response::new(Empty {}))
        } else {
            Err(Status::not_found(format!("Session {} not found", req.session_id)))
        }
    }
    
    type WatchSessionsStream = ResponseStream<SessionEvent>;
    
    async fn watch_sessions(
        &self,
        _request: Request<WatchSessionsRequest>,
    ) -> Result<Response<Self::WatchSessionsStream>, Status> {
        let mut rx = self.state.subscribe_session_events();
        
        let (tx, stream_rx) = tokio::sync::mpsc::channel(100);
        
        tokio::spawn(async move {
            while let Ok(event) = rx.recv().await {
                if tx.send(Ok(event)).await.is_err() {
                    break;
                }
            }
        });
        
        let stream = tokio_stream::wrappers::ReceiverStream::new(stream_rx);
        Ok(Response::new(Box::pin(stream)))
    }
    
    async fn replay_session(
        &self,
        request: Request<ReplaySessionRequest>,
    ) -> Result<Response<ReplaySessionResponse>, Status> {
        let req = request.into_inner();
        
        let session = self.state.sessions.get(&req.session_id)
            .ok_or_else(|| Status::not_found(format!("Session {} not found", req.session_id)))?;
        
        let condensed = matches!(req.format(), ReplayFormat::Condensed);
        let max_messages = req.max_messages.filter(|&m| m > 0).map(|m| m as usize);
        
        let formatted = session.format_for_replay(condensed, max_messages);
        
        // Rough token estimate (4 chars per token)
        let token_estimate = formatted.len() / 4;
        
        Ok(Response::new(ReplaySessionResponse {
            formatted_content: formatted,
            message_count: session.message_count() as i32,
            token_estimate: token_estimate as i32,
        }))
    }
    
    async fn summarize_session(
        &self,
        request: Request<SummarizeSessionRequest>,
    ) -> Result<Response<SummarizeSessionResponse>, Status> {
        let req = request.into_inner();
        
        let session = self.state.sessions.get(&req.session_id)
            .ok_or_else(|| Status::not_found(format!("Session {} not found", req.session_id)))?;
        
        // Check cache first
        if let Some(cached) = &session.cached_summary {
            return Ok(Response::new(SummarizeSessionResponse {
                summary: cached.clone(),
                from_cache: true,
            }));
        }
        
        // TODO: Actually generate summary using LLM
        let summary = format!(
            "Session about '{}' with {} messages using model {}",
            session.topic.as_deref().unwrap_or("(no topic)"),
            session.message_count(),
            session.model
        );
        
        Ok(Response::new(SummarizeSessionResponse {
            summary,
            from_cache: false,
        }))
    }
    
    async fn fork_session(
        &self,
        request: Request<ForkSessionRequest>,
    ) -> Result<Response<ProtoSession>, Status> {
        let req = request.into_inner();
        
        let forked = self.state.sessions.fork(
            &req.session_id,
            req.fork_point.map(|p| p as usize),
            req.new_model,
        ).await.ok_or_else(|| Status::not_found(format!("Session {} not found", req.session_id)))?;
        
        tracing::info!(
            session_id = %forked.id,
            forked_from = %req.session_id,
            "Session forked"
        );
        
        Ok(Response::new(forked.to_proto()))
    }
    
    async fn export_session(
        &self,
        request: Request<ExportSessionRequest>,
    ) -> Result<Response<ExportSessionResponse>, Status> {
        let req = request.into_inner();
        
        let json = self.state.sessions.export(&req.session_id)
            .ok_or_else(|| Status::not_found(format!("Session {} not found", req.session_id)))?;
        
        Ok(Response::new(ExportSessionResponse {
            json_content: json,
        }))
    }
    
    async fn import_session(
        &self,
        request: Request<ImportSessionRequest>,
    ) -> Result<Response<ProtoSession>, Status> {
        let req = request.into_inner();
        
        let session = self.state.sessions
            .import(&req.json_content, req.generate_new_id)
            .await
            .map_err(|e| Status::invalid_argument(e))?;
        
        tracing::info!(session_id = %session.id, "Session imported");
        
        Ok(Response::new(session.to_proto()))
    }
    
    //
    // Models & Providers
    //
    
    async fn list_models(
        &self,
        _request: Request<ListModelsRequest>,
    ) -> Result<Response<ListModelsResponse>, Status> {
        // Use dynamic model fetching from provider APIs
        let models = self.state.list_models_dynamic().await;
        
        Ok(Response::new(ListModelsResponse {
            models: models.iter().map(|m| crate::proto::Model {
                id: m.id.clone(),
                provider: m.provider.clone(),
                name: m.id.split('/').nth(1).unwrap_or(&m.id).to_string(),
                display_name: m.display_name.clone(),
                capabilities: Some(crate::proto::ModelCapabilities {
                    supports_streaming: true,
                    supports_tools: true,
                    supports_vision: false,
                    context_window: Some(m.context_window as i32),
                }),
                source: crate::proto::ModelSource::Direct.into(),
            }).collect(),
        }))
    }
    
    async fn list_providers(
        &self,
        _request: Request<ListProvidersRequest>,
    ) -> Result<Response<ListProvidersResponse>, Status> {
        let providers = self.state.list_providers();
        
        Ok(Response::new(ListProvidersResponse {
            providers: providers.iter().map(|p| crate::proto::Provider {
                id: p.id.clone(),
                display_name: p.display_name.clone(),
                configured: p.configured,
                healthy: p.healthy,
                provider_type: crate::proto::ProviderType::Http.into(),
            }).collect(),
        }))
    }
    
    async fn get_provider_status(
        &self,
        request: Request<GetProviderStatusRequest>,
    ) -> Result<Response<ProviderStatus>, Status> {
        let req = request.into_inner();
        
        let providers = self.state.list_providers();
        let provider = providers.iter().find(|p| p.id == req.provider_id);
        
        match provider {
            Some(p) => Ok(Response::new(ProviderStatus {
                provider_id: p.id.clone(),
                configured: p.configured,
                healthy: p.healthy,
                error: None,
                last_check: None,
            })),
            None => Err(Status::not_found(format!("Provider {} not found", req.provider_id))),
        }
    }
    
    //
    // Tools
    //
    
    async fn list_tools(
        &self,
        _request: Request<ListToolsRequest>,
    ) -> Result<Response<ListToolsResponse>, Status> {
        // TODO: Get tools from MCP servers
        Ok(Response::new(ListToolsResponse {
            tools: vec![],
        }))
    }
    
    async fn execute_tool(
        &self,
        request: Request<ExecuteToolRequest>,
    ) -> Result<Response<ExecuteToolResponse>, Status> {
        let req = request.into_inner();
        
        // TODO: Execute tool via MCP
        Ok(Response::new(ExecuteToolResponse {
            content: format!("Tool {} not implemented yet", req.name),
            is_error: true,
        }))
    }
    
    //
    // Configuration
    //
    
    async fn get_config(
        &self,
        _request: Request<GetConfigRequest>,
    ) -> Result<Response<Config>, Status> {
        // TODO: Get config from openllm-core
        Ok(Response::new(Config {
            default_model: "openai/gpt-4o".to_string(),
            providers: std::collections::HashMap::new(),
            session_ttl_days: 7,
            log_level: crate::proto::LogLevel::Info.into(),
        }))
    }
    
    async fn update_config(
        &self,
        _request: Request<UpdateConfigRequest>,
    ) -> Result<Response<Config>, Status> {
        // TODO: Update config
        Err(Status::unimplemented("Config update not implemented yet"))
    }
    
    //
    // Secrets
    //
    
    async fn get_secret(
        &self,
        request: Request<GetSecretRequest>,
    ) -> Result<Response<GetSecretResponse>, Status> {
        let req = request.into_inner();
        
        match self.state.get_secret(&req.key) {
            Some(value) => Ok(Response::new(GetSecretResponse {
                value,
            })),
            None => Err(Status::not_found(format!("Secret {} not found", req.key))),
        }
    }
    
    async fn set_secret(
        &self,
        request: Request<SetSecretRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        
        self.state.set_secret(&req.key, &req.value)
            .map_err(|e| Status::internal(format!("Failed to set secret: {}", e)))?;
        
        tracing::info!(key = %req.key, "Secret set");
        Ok(Response::new(Empty {}))
    }
    
    async fn delete_secret(
        &self,
        request: Request<DeleteSecretRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        
        self.state.delete_secret(&req.key)
            .map_err(|e| Status::internal(format!("Failed to delete secret: {}", e)))?;
        
        tracing::info!(key = %req.key, "Secret deleted");
        Ok(Response::new(Empty {}))
    }
    
    async fn list_secrets(
        &self,
        _request: Request<ListSecretsRequest>,
    ) -> Result<Response<ListSecretsResponse>, Status> {
        let secrets = self.state.list_secrets();
        
        Ok(Response::new(ListSecretsResponse {
            secrets: secrets.iter().map(|s| crate::proto::SecretInfo {
                key: s.key.clone(),
                store: crate::proto::SecretStore::Keychain.into(),
                has_value: s.has_value,
            }).collect(),
        }))
    }
    
    //
    // Daemon Lifecycle
    //
    
    async fn register(
        &self,
        request: Request<RegisterRequest>,
    ) -> Result<Response<RegisterResponse>, Status> {
        let req = request.into_inner();
        
        tracing::info!("Register request received");
        tracing::info!("  workspace_path from request: '{}'", req.workspace_path);
        tracing::info!("  is_spawner: {}", req.is_spawner);
        
        let client_type = req.client.map(|c| ClientType::try_from(c.client_type).unwrap_or(ClientType::Unspecified))
            .unwrap_or(ClientType::Unspecified);
        
        let workspace_path = if req.workspace_path.is_empty() { None } else { Some(req.workspace_path.clone()) };
        tracing::info!("  workspace_path after processing: {:?}", workspace_path);
        
        let client_id = self.state.register_client(client_type, req.is_spawner, workspace_path);
        tracing::info!("  registered client_id: {}", client_id);
        
        Ok(Response::new(RegisterResponse {
            client_id,
            connected_clients: self.state.client_count() as i32,
        }))
    }
    
    async fn unregister(
        &self,
        request: Request<UnregisterRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        self.state.unregister_client(&req.client_id);
        Ok(Response::new(Empty {}))
    }
    
    async fn get_status(
        &self,
        _request: Request<GetStatusRequest>,
    ) -> Result<Response<DaemonStatus>, Status> {
        let clients: Vec<ProtoConnectedClient> = self.state.clients
            .iter()
            .map(|c| ProtoConnectedClient {
                client_id: c.client_id.clone(),
                client_type: c.client_type.into(),
                connected_at: Some(Timestamp {
                    seconds: c.connected_at.timestamp(),
                    nanos: c.connected_at.timestamp_subsec_nanos() as i32,
                }),
                is_spawner: c.is_spawner,
                workspace_path: c.workspace_path.clone().unwrap_or_default(),
            })
            .collect();
        
        Ok(Response::new(DaemonStatus {
            version: self.state.version.clone(),
            started_at: Some(Timestamp {
                seconds: self.state.started_at.timestamp(),
                nanos: self.state.started_at.timestamp_subsec_nanos() as i32,
            }),
            connected_clients: self.state.client_count() as i32,
            active_sessions: self.state.sessions.count() as i32,
            clients,
            registered_mcp_servers: self.state.mcp_server_ids(),
        }))
    }
    
    async fn get_connected_workspaces(
        &self,
        _request: Request<GetConnectedWorkspacesRequest>,
    ) -> Result<Response<GetConnectedWorkspacesResponse>, Status> {
        let workspaces: Vec<String> = self.state.clients
            .iter()
            .filter_map(|c| c.workspace_path.clone())
            .filter(|p| !p.is_empty())
            .collect::<std::collections::HashSet<_>>()
            .into_iter()
            .collect();
        
        Ok(Response::new(GetConnectedWorkspacesResponse { workspaces }))
    }

    async fn shutdown(
        &self,
        request: Request<ShutdownRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        
        tracing::info!(
            force = req.force,
            grace_period = req.grace_period_seconds,
            "Shutdown requested"
        );
        
        if req.force {
            self.state.trigger_shutdown();
        } else {
            // TODO: Implement grace period
            self.state.trigger_shutdown();
        }
        
        Ok(Response::new(Empty {}))
    }
    
    async fn health_check(
        &self,
        _request: Request<HealthCheckRequest>,
    ) -> Result<Response<HealthCheckResponse>, Status> {
        Ok(Response::new(HealthCheckResponse {
            healthy: true,
            version: self.state.version.clone(),
        }))
    }
    
    //
    // MCP Server Registration
    //
    
    async fn register_mcp_server(
        &self,
        request: Request<RegisterMcpServerRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        self.state.register_mcp_server(req.server_id, req.transport, req.capabilities);
        Ok(Response::new(Empty {}))
    }
    
    async fn unregister_mcp_server(
        &self,
        request: Request<UnregisterMcpServerRequest>,
    ) -> Result<Response<Empty>, Status> {
        let req = request.into_inner();
        self.state.unregister_mcp_server(&req.server_id);
        Ok(Response::new(Empty {}))
    }
    
    //
    // VS Code Backchannel
    //
    
    type VSCodeStreamStream = ResponseStream<VsCodeRequest>;
    
    async fn vs_code_stream(
        &self,
        request: Request<tonic::Streaming<VsCodeResponse>>,
    ) -> Result<Response<Self::VSCodeStreamStream>, Status> {
        let mut stream = request.into_inner();
        let state = Arc::clone(&self.state);
        
        tracing::info!("VS Code backchannel connected");
        
        // Create channels for bidirectional communication
        let (request_tx, request_rx) = tokio::sync::mpsc::channel::<Result<VsCodeRequest, Status>>(100);
        
        // Register this VS Code connection with the state
        let vscode_id = state.register_vscode_connection(request_tx.clone());
        
        // Spawn a task to handle incoming responses from VS Code
        let state_clone = Arc::clone(&state);
        tokio::spawn(async move {
            while let Some(result) = stream.message().await.transpose() {
                match result {
                    Ok(response) => {
                        tracing::debug!(request_id = %response.request_id, "Received VS Code response");
                        // Route the response to the waiting request handler
                        state_clone.handle_vscode_response(response);
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "Error receiving from VS Code stream");
                        break;
                    }
                }
            }
            
            tracing::info!("VS Code backchannel disconnected");
            state_clone.unregister_vscode_connection(&vscode_id);
        });
        
        // Return the stream of requests to VS Code
        let stream = tokio_stream::wrappers::ReceiverStream::new(request_rx);
        Ok(Response::new(Box::pin(stream)))
    }
}
