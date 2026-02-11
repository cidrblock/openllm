//! HTTP routes for the web dashboard
//!
//! These routes proxy to the daemon's gRPC API.

use std::sync::Arc;
use std::convert::Infallible;
use axum::{
    Router,
    routing::{get, post, delete},
    response::{Html, IntoResponse, sse::{Event, Sse}},
    extract::{State, Path},
    http::{StatusCode, header},
    Json,
};
use rust_embed::Embed;
use tower_http::cors::{CorsLayer, Any};
use futures::StreamExt;

use crate::proto::{
    GetStatusRequest, ListProvidersRequest, ListModelsRequest,
    ListSecretsRequest, SetSecretRequest, DeleteSecretRequest, SecretStore,
    ChatRequest as GrpcChatRequest, Message as GrpcMessage, Role,
};
use super::client::DaemonClient;

/// Embedded static assets
#[derive(Embed)]
#[folder = "src/web/static"]
struct Assets;

/// Create the web dashboard router
pub fn create_router(client: Arc<DaemonClient>) -> Router {
    Router::new()
        // API endpoints (proxy to gRPC)
        .route("/api/status", get(api_status))
        .route("/api/providers", get(api_providers))
        .route("/api/models", get(api_models))
        .route("/api/secrets", get(api_secrets))
        .route("/api/secrets/{key}", post(api_set_secret).delete(api_delete_secret))
        .route("/api/chat", post(api_chat_sse))
        // Config endpoints (local file storage)
        .route("/api/config", get(api_get_config).post(api_save_config))
        .route("/api/workspaces", get(api_workspaces))
        // Key status check (keychain or env var)
        .route("/api/key-status", get(api_key_status))
        // Static files
        .route("/", get(index_html))
        .route("/{*path}", get(static_handler))
        // CORS for development
        .layer(CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any))
        .with_state(client)
}

/// Serve index.html
async fn index_html() -> impl IntoResponse {
    match Assets::get("index.html") {
        Some(content) => Html(content.data.into_owned()).into_response(),
        None => (StatusCode::NOT_FOUND, "index.html not found").into_response(),
    }
}

/// Serve static files from embedded assets
async fn static_handler(Path(path): Path<String>) -> impl IntoResponse {
    let path = path.trim_start_matches('/');
    
    match Assets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                [(header::CONTENT_TYPE, mime.as_ref())],
                content.data.into_owned(),
            ).into_response()
        }
        None => (StatusCode::NOT_FOUND, format!("File not found: {}", path)).into_response(),
    }
}

/// GET /api/status - Daemon status via gRPC
async fn api_status(State(client): State<Arc<DaemonClient>>) -> impl IntoResponse {
    let mut grpc = client.client().await;
    
    match grpc.get_status(GetStatusRequest {}).await {
        Ok(response) => {
            let status = response.into_inner();
            let started_at = status.started_at
                .map(|t| chrono::DateTime::from_timestamp(t.seconds, t.nanos as u32)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default())
                .unwrap_or_default();
            
            (StatusCode::OK, Json(serde_json::json!({
                "version": status.version,
                "startedAt": started_at,
                "connectedClients": status.connected_clients,
                "activeSessions": status.active_sessions,
            }))).into_response()
        }
        Err(e) => {
            (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({
                "error": format!("Failed to connect to daemon: {}", e)
            }))).into_response()
        }
    }
}

/// GET /api/providers - List providers via gRPC
async fn api_providers(State(client): State<Arc<DaemonClient>>) -> impl IntoResponse {
    let mut grpc = client.client().await;
    
    match grpc.list_providers(ListProvidersRequest {}).await {
        Ok(response) => {
            let providers: Vec<_> = response.into_inner().providers.into_iter().map(|p| {
                serde_json::json!({
                    "id": p.id,
                    "displayName": p.display_name,
                    "configured": p.configured,
                    "healthy": p.healthy,
                })
            }).collect();
            
            (StatusCode::OK, Json(serde_json::json!({ "providers": providers }))).into_response()
        }
        Err(e) => {
            (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({
                "error": format!("Failed to list providers: {}", e)
            }))).into_response()
        }
    }
}

/// GET /api/models - List models via gRPC
async fn api_models(State(client): State<Arc<DaemonClient>>) -> impl IntoResponse {
    let mut grpc = client.client().await;
    
    match grpc.list_models(ListModelsRequest { provider_filter: None }).await {
        Ok(response) => {
            let models: Vec<_> = response.into_inner().models.into_iter().map(|m| {
                serde_json::json!({
                    "id": m.id,
                    "provider": m.provider,
                    "name": m.name,
                    "displayName": m.display_name,
                    "capabilities": m.capabilities.map(|c| serde_json::json!({
                        "streaming": c.supports_streaming,
                        "tools": c.supports_tools,
                        "vision": c.supports_vision,
                        "contextWindow": c.context_window,
                    })),
                })
            }).collect();
            
            (StatusCode::OK, Json(serde_json::json!({ "models": models }))).into_response()
        }
        Err(e) => {
            (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({
                "error": format!("Failed to list models: {}", e)
            }))).into_response()
        }
    }
}

/// GET /api/secrets - List secrets via gRPC
async fn api_secrets(State(client): State<Arc<DaemonClient>>) -> impl IntoResponse {
    let mut grpc = client.client().await;
    
    match grpc.list_secrets(ListSecretsRequest {}).await {
        Ok(response) => {
            let secrets: Vec<_> = response.into_inner().secrets.into_iter().map(|s| {
                serde_json::json!({
                    "key": s.key,
                    "hasValue": s.has_value,
                })
            }).collect();
            
            (StatusCode::OK, Json(serde_json::json!({ "secrets": secrets }))).into_response()
        }
        Err(e) => {
            (StatusCode::SERVICE_UNAVAILABLE, Json(serde_json::json!({
                "error": format!("Failed to list secrets: {}", e)
            }))).into_response()
        }
    }
}

/// POST /api/secrets/:key - Set a secret via gRPC
async fn api_set_secret(
    State(client): State<Arc<DaemonClient>>,
    Path(key): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let value = body.get("value").and_then(|v| v.as_str());
    
    match value {
        Some(val) => {
            let mut grpc = client.client().await;
            
            match grpc.set_secret(SetSecretRequest {
                key: key.clone(),
                value: val.to_string(),
                store: SecretStore::Keychain.into(),
            }).await {
                Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ 
                    "error": e.to_string() 
                }))).into_response(),
            }
        }
        None => (StatusCode::BAD_REQUEST, Json(serde_json::json!({ 
            "error": "Missing 'value' field" 
        }))).into_response(),
    }
}

/// DELETE /api/secrets/:key - Delete a secret via gRPC
async fn api_delete_secret(
    State(client): State<Arc<DaemonClient>>,
    Path(key): Path<String>,
) -> impl IntoResponse {
    let mut grpc = client.client().await;
    
    match grpc.delete_secret(DeleteSecretRequest { key }).await {
        Ok(_) => (StatusCode::OK, Json(serde_json::json!({ "success": true }))),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ 
            "error": e.to_string() 
        }))),
    }
}

/// Provider config - stored per provider
/// Uses mutually exclusive fields for API key source:
/// - api_key_keychain_name: Key stored in OS keychain
/// - api_key_env_var_name: Key read from environment variable
#[derive(serde::Deserialize, serde::Serialize, Clone, Default)]
struct ProviderConfig {
    /// Name of the key in OS keychain (mutually exclusive with api_key_env_var_name)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key_keychain_name: Option<String>,
    
    /// Name of environment variable containing the key (mutually exclusive with api_key_keychain_name)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key_env_var_name: Option<String>,
    
    /// Enabled models for this provider
    #[serde(default)]
    enabled_models: Vec<String>,
}

/// Main config structure
#[derive(serde::Deserialize, serde::Serialize, Default)]
struct OpenLLMConfig {
    #[serde(default)]
    providers: std::collections::HashMap<String, ProviderConfig>,
}

#[derive(serde::Deserialize)]
struct SaveConfigRequest {
    location: String,  // "user" or absolute path
    config: OpenLLMConfig,
}

/// Get config file path based on location
fn get_config_path(location: &str) -> std::path::PathBuf {
    if location == "user" {
        dirs::home_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join(".openllm")
            .join("config.yaml")
    } else {
        std::path::PathBuf::from(location).join(".openllm").join("config.yaml")
    }
}

/// GET /api/config - Load provider config (YAML)
async fn api_get_config(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let location = params.get("location").map(|s| s.as_str()).unwrap_or("user");
    let path = get_config_path(location);
    
    match std::fs::read_to_string(&path) {
        Ok(content) => {
            match serde_yaml::from_str::<OpenLLMConfig>(&content) {
                Ok(config) => (StatusCode::OK, Json(serde_json::json!({
                    "config": config,
                    "path": path.display().to_string(),
                }))).into_response(),
                Err(e) => (StatusCode::OK, Json(serde_json::json!({
                    "config": OpenLLMConfig::default(),
                    "path": path.display().to_string(),
                    "parseError": e.to_string(),
                }))).into_response(),
            }
        }
        Err(_) => {
            // File doesn't exist, return empty config
            (StatusCode::OK, Json(serde_json::json!({
                "config": OpenLLMConfig::default(),
                "path": path.display().to_string(),
                "exists": false,
            }))).into_response()
        }
    }
}

/// POST /api/config - Save provider config (YAML)
async fn api_save_config(
    Json(request): Json<SaveConfigRequest>,
) -> impl IntoResponse {
    let path = get_config_path(&request.location);
    
    // Create directory if it doesn't exist
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                "error": format!("Failed to create config directory: {}", e)
            }))).into_response();
        }
    }
    
    // Write config as YAML
    match serde_yaml::to_string(&request.config) {
        Ok(content) => {
            match std::fs::write(&path, content) {
                Ok(_) => (StatusCode::OK, Json(serde_json::json!({
                    "success": true,
                    "path": path.display().to_string(),
                }))).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
                    "error": format!("Failed to write config: {}", e)
                }))).into_response(),
            }
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({
            "error": format!("Failed to serialize config: {}", e)
        }))).into_response(),
    }
}

/// GET /api/key-status - Check if a key exists in keychain or env var
/// Query params: source=keychain|env, name=KEY_NAME
async fn api_key_status(
    State(client): State<Arc<DaemonClient>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let source = params.get("source").map(|s| s.as_str()).unwrap_or("");
    let name = params.get("name").map(|s| s.as_str()).unwrap_or("");
    
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
            "error": "name parameter is required"
        }))).into_response();
    }
    
    let exists = match source {
        "keychain" => {
            // Check if key exists in keychain via gRPC secrets API
            let mut grpc = client.client().await;
            match grpc.list_secrets(ListSecretsRequest {}).await {
                Ok(response) => {
                    response.into_inner().secrets.iter().any(|s| s.key == name && s.has_value)
                }
                Err(_) => false,
            }
        }
        "env" => {
            // Check if environment variable exists
            std::env::var(name).is_ok()
        }
        _ => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({
                "error": "source must be 'keychain' or 'env'"
            }))).into_response();
        }
    };
    
    (StatusCode::OK, Json(serde_json::json!({
        "source": source,
        "name": name,
        "exists": exists,
    }))).into_response()
}

/// GET /api/workspaces - Get connected VS Code workspaces
async fn api_workspaces(
    State(client): State<Arc<DaemonClient>>,
) -> impl IntoResponse {
    let mut grpc = client.client().await;
    
    // Get full status including clients with their workspace paths
    match grpc.get_status(GetStatusRequest {}).await {
        Ok(response) => {
            let status = response.into_inner();
            
            // Extract workspaces and client details for debugging
            let mut workspaces: Vec<String> = vec![];
            let mut clients_debug: Vec<serde_json::Value> = vec![];
            
            for c in &status.clients {
                clients_debug.push(serde_json::json!({
                    "client_id": c.client_id,
                    "client_type": c.client_type,
                    "workspace_path": c.workspace_path,
                    "is_spawner": c.is_spawner,
                }));
                
                if !c.workspace_path.is_empty() && !workspaces.contains(&c.workspace_path) {
                    workspaces.push(c.workspace_path.clone());
                }
            }
            
            (StatusCode::OK, Json(serde_json::json!({
                "workspaces": workspaces,
                "connected_clients": status.connected_clients,
                "clients": clients_debug,
            })))
        }
        Err(e) => {
            (StatusCode::OK, Json(serde_json::json!({
                "workspaces": Vec::<String>::new(),
                "connected_clients": 0,
                "error": e.to_string(),
            })))
        }
    }
}

/// Chat request body from browser
#[derive(serde::Deserialize)]
struct ChatRequestBody {
    model: String,
    messages: Vec<ChatMessageBody>,
}

#[derive(serde::Deserialize)]
struct ChatMessageBody {
    role: String,
    content: String,
}

/// POST /api/chat - Streaming chat via SSE (proxies to gRPC Chat stream)
async fn api_chat_sse(
    State(client): State<Arc<DaemonClient>>,
    Json(request): Json<ChatRequestBody>,
) -> Sse<impl futures::stream::Stream<Item = Result<Event, Infallible>>> {
    let stream = async_stream::stream! {
        // Convert messages to gRPC format
        let messages: Vec<GrpcMessage> = request.messages.iter().map(|m| {
            GrpcMessage {
                role: match m.role.as_str() {
                    "system" => Role::System.into(),
                    "user" => Role::User.into(),
                    "assistant" => Role::Assistant.into(),
                    _ => Role::User.into(),
                },
                content: m.content.clone(),
                name: String::new(),
                tool_call_id: String::new(),
                tool_calls: vec![],
            }
        }).collect();
        
        // Make gRPC streaming call
        let mut grpc = client.client().await;
        
        let grpc_request = GrpcChatRequest {
            model: request.model.clone(),
            messages,
            options: None,
        };
        
        match grpc.chat(grpc_request).await {
            Ok(response) => {
                let mut stream = response.into_inner();
                
                while let Some(chunk_result) = stream.next().await {
                    match chunk_result {
                        Ok(chunk) => {
                            // Extract text from the chunk
                            if let Some(crate::proto::chat_chunk::Chunk::Text(text_chunk)) = chunk.chunk {
                                let event = Event::default()
                                    .event("message")
                                    .data(serde_json::json!({
                                        "type": "text",
                                        "content": text_chunk.text
                                    }).to_string());
                                yield Ok::<Event, Infallible>(event);
                            } else if let Some(crate::proto::chat_chunk::Chunk::Done(_)) = chunk.chunk {
                                let event = Event::default()
                                    .event("done")
                                    .data(serde_json::json!({
                                        "type": "done"
                                    }).to_string());
                                yield Ok::<Event, Infallible>(event);
                            }
                        }
                        Err(e) => {
                            let event = Event::default()
                                .event("error")
                                .data(serde_json::json!({
                                    "error": e.to_string()
                                }).to_string());
                            yield Ok::<Event, Infallible>(event);
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                let event = Event::default()
                    .event("error")
                    .data(serde_json::json!({
                        "error": format!("Failed to start chat: {}", e)
                    }).to_string());
                yield Ok::<Event, Infallible>(event);
            }
        }
    };

    Sse::new(stream)
}
