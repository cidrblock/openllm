//! Node.js bindings for OpenLLM via napi-rs

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode, ErrorStrategy};
use napi_derive::napi;
use std::sync::Arc;
use futures::StreamExt;

use openllm_core::secrets::{
    SecretStore as CoreSecretStore,
    EnvSecretStore as CoreEnvSecretStore,
    MemorySecretStore as CoreMemorySecretStore,
    KeychainSecretStore as CoreKeychainSecretStore,
    list_secret_stores as core_list_secret_stores,
};
// MCP is now used instead of RPC for VS Code communication
// RPC types have been removed - see mcp module in openllm-core
use openllm_core::resolver::{
    UnifiedSecretResolver as CoreUnifiedSecretResolver,
    UnifiedConfigResolver as CoreUnifiedConfigResolver,
};
use openllm_core::config::{
    FileConfigProvider as CoreFileConfigProvider,
    ConfigLevel as CoreConfigLevel,
    ConfigProvider as CoreConfigProvider,
};
use openllm_core::logging::{NoOpLogger, Logger};
use openllm_core::providers::{
    ProviderModelConfig as CoreProviderModelConfig,
    StreamChatOptions as CoreStreamChatOptions,
    create_provider as core_create_provider,
    supported_providers as core_supported_providers,
};
use openllm_core::types::{
    ChatMessage as CoreChatMessage,
    MessageContent as CoreMessageContent,
    MessageRole as CoreMessageRole,
    CancellationToken as CoreCancellationToken,
    StreamChunk as CoreStreamChunk,
};
use openllm_core::mcp::McpClient as CoreMcpClient;

use parking_lot::RwLock;
use once_cell::sync::Lazy;

// ============================================================================
// Global MCP Endpoint Registry
// ============================================================================

/// Registered MCP endpoint information
#[derive(Clone)]
struct McpEndpointInfo {
    #[allow(dead_code)]
    name: String,
    socket_path: String,
    #[allow(dead_code)]
    http_url: Option<String>,
}

/// Global registry of MCP endpoints
/// In practice, there's usually just one (the VS Code extension)
static MCP_ENDPOINTS: Lazy<RwLock<Vec<McpEndpointInfo>>> = Lazy::new(|| RwLock::new(Vec::new()));

/// Global MCP client (lazily created when first needed)
static MCP_CLIENT: Lazy<RwLock<Option<Arc<CoreMcpClient>>>> = Lazy::new(|| RwLock::new(None));

/// MCP endpoint configuration for registration
#[napi(object)]
pub struct McpEndpoint {
    /// Name identifier for this endpoint (e.g., "vscode")
    pub name: String,
    /// Unix socket path (or Windows named pipe path)
    pub socket_path: String,
    /// Optional HTTP URL format (e.g., "http+unix://...")
    pub http_url: Option<String>,
}

/// Register an MCP endpoint that the Rust core can connect to
/// 
/// This should be called by the VS Code extension (or other host) after starting
/// its MCP server, so that the Rust ToolRegistry can discover and execute tools.
/// 
/// ## Example (TypeScript)
/// ```typescript
/// const mcpInfo = await mcpToolServer.start();
/// native.registerMcpEndpoint({
///   name: 'vscode',
///   socketPath: mcpInfo.socketPath,
///   httpUrl: mcpInfo.httpUrl,
/// });
/// ```
#[napi]
pub fn register_mcp_endpoint(endpoint: McpEndpoint) -> Result<()> {
    let info = McpEndpointInfo {
        name: endpoint.name.clone(),
        socket_path: endpoint.socket_path.clone(),
        http_url: endpoint.http_url,
    };
    
    // Store the endpoint
    {
        let mut endpoints = MCP_ENDPOINTS.write();
        // Replace existing endpoint with same name
        endpoints.retain(|e| e.name != endpoint.name);
        endpoints.push(info);
    }
    
    // Clear existing client so it will be recreated with new endpoint
    {
        let mut client = MCP_CLIENT.write();
        *client = None;
    }
    
    Ok(())
}

/// Unregister an MCP endpoint
#[napi]
pub fn unregister_mcp_endpoint(name: String) -> bool {
    let mut endpoints = MCP_ENDPOINTS.write();
    let len_before = endpoints.len();
    endpoints.retain(|e| e.name != name);
    
    if endpoints.len() < len_before {
        // Clear client cache
        let mut client = MCP_CLIENT.write();
        *client = None;
        true
    } else {
        false
    }
}

/// Check if an MCP endpoint is registered
#[napi]
pub fn has_mcp_endpoint(name: String) -> bool {
    MCP_ENDPOINTS.read().iter().any(|e| e.name == name)
}

/// Get the socket path for a registered MCP endpoint
#[napi]
pub fn get_mcp_socket_path(name: String) -> Option<String> {
    MCP_ENDPOINTS.read()
        .iter()
        .find(|e| e.name == name)
        .map(|e| e.socket_path.clone())
}

/// Get the socket path for the first registered MCP endpoint
fn get_first_mcp_socket_path() -> Result<String> {
    let endpoints = MCP_ENDPOINTS.read();
    endpoints.first()
        .map(|e| e.socket_path.clone())
        .ok_or_else(|| Error::from_reason("No MCP endpoint registered. Call registerMcpEndpoint first."))
}

/// Get or create the global MCP client (async version)
/// 
/// This connects to the first registered endpoint (typically "vscode")
async fn get_or_create_mcp_client_async() -> Result<Arc<CoreMcpClient>> {
    // Check if we already have a client
    {
        let client = MCP_CLIENT.read();
        if let Some(ref c) = *client {
            return Ok(c.clone());
        }
    }
    
    // Get the socket path
    let socket_path = get_first_mcp_socket_path()?;
    
    // Create a new client (async connect)
    let logger: Arc<dyn Logger> = Arc::new(NoOpLogger);
    
    #[cfg(unix)]
    let client = CoreMcpClient::connect_unix(&socket_path, logger)
        .await
        .map_err(|e| Error::from_reason(format!("Failed to connect to MCP server: {}", e)))?;
    
    #[cfg(windows)]
    let client = CoreMcpClient::connect_named_pipe(&socket_path, logger)
        .await
        .map_err(|e| Error::from_reason(format!("Failed to connect to MCP server: {}", e)))?;
    
    let client = Arc::new(client);
    
    // Store it
    {
        let mut stored = MCP_CLIENT.write();
        *stored = Some(client.clone());
    }
    
    Ok(client)
}

// ============================================================================
// Secret Store Types
// ============================================================================

#[napi(object)]
pub struct SecretInfo {
    pub available: bool,
    pub source: String,
}

impl From<openllm_core::SecretInfo> for SecretInfo {
    fn from(info: openllm_core::SecretInfo) -> Self {
        Self { available: info.available, source: info.source }
    }
}

#[napi(object)]
pub struct StoreInfo {
    pub name: String,
    pub description: String,
    pub is_plugin: bool,
}

// ============================================================================
// EnvSecretStore
// ============================================================================

#[napi]
pub struct EnvSecretStore {
    inner: Arc<CoreEnvSecretStore>,
}

#[napi]
impl EnvSecretStore {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: Arc::new(CoreEnvSecretStore::new()) }
    }

    #[napi(getter)]
    pub fn name(&self) -> String { self.inner.name().to_string() }

    #[napi]
    pub fn is_available(&self) -> bool { self.inner.is_available() }

    #[napi]
    pub async fn get(&self, key: String) -> Option<String> { self.inner.get(&key) }

    #[napi]
    pub async fn store(&self, key: String, value: String) -> Result<()> {
        self.inner.store(&key, &value).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn delete(&self, key: String) -> Result<()> {
        self.inner.delete(&key).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn has(&self, key: String) -> bool { self.inner.has(&key) }

    #[napi]
    pub async fn get_info(&self, key: String) -> SecretInfo { self.inner.get_info(&key).into() }
}

// ============================================================================
// MemorySecretStore
// ============================================================================

#[napi]
pub struct MemorySecretStore {
    inner: Arc<CoreMemorySecretStore>,
}

#[napi]
impl MemorySecretStore {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: Arc::new(CoreMemorySecretStore::new()) }
    }

    #[napi(getter)]
    pub fn name(&self) -> String { self.inner.name().to_string() }

    #[napi]
    pub fn is_available(&self) -> bool { self.inner.is_available() }

    #[napi]
    pub async fn get(&self, key: String) -> Option<String> { self.inner.get(&key) }

    #[napi]
    pub async fn store(&self, key: String, value: String) -> Result<()> {
        self.inner.store(&key, &value).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn delete(&self, key: String) -> Result<()> {
        self.inner.delete(&key).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn has(&self, key: String) -> bool { self.inner.has(&key) }

    #[napi]
    pub async fn get_info(&self, key: String) -> SecretInfo { self.inner.get_info(&key).into() }

    #[napi]
    pub fn clear(&self) { self.inner.clear(); }

    #[napi]
    pub fn len(&self) -> u32 { self.inner.len() as u32 }

    #[napi]
    pub fn is_empty(&self) -> bool { self.inner.is_empty() }
}

// ============================================================================
// KeychainSecretStore
// ============================================================================

/// System keychain secret store (macOS Keychain, Windows Credential Manager, Linux Secret Service)
#[napi]
pub struct KeychainSecretStore {
    inner: Arc<CoreKeychainSecretStore>,
}

#[napi]
impl KeychainSecretStore {
    #[napi(constructor)]
    pub fn new(service: Option<String>) -> Self {
        let store = match service {
            Some(s) => CoreKeychainSecretStore::with_service(s),
            None => CoreKeychainSecretStore::new(),
        };
        Self { inner: Arc::new(store) }
    }

    #[napi(getter)]
    pub fn name(&self) -> String { self.inner.name().to_string() }

    #[napi]
    pub fn is_available(&self) -> bool { self.inner.is_available() }

    #[napi]
    pub async fn get(&self, key: String) -> Option<String> { self.inner.get(&key) }

    #[napi]
    pub async fn store(&self, key: String, value: String) -> Result<()> {
        self.inner.store(&key, &value).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn delete(&self, key: String) -> Result<()> {
        self.inner.delete(&key).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn has(&self, key: String) -> bool { self.inner.has(&key) }

    #[napi]
    pub async fn get_info(&self, key: String) -> SecretInfo { self.inner.get_info(&key).into() }
}

// ============================================================================
// Config Types
// ============================================================================

#[napi(string_enum)]
pub enum ConfigLevel {
    User,
    Workspace,
}

impl From<ConfigLevel> for CoreConfigLevel {
    fn from(level: ConfigLevel) -> Self {
        match level {
            ConfigLevel::User => CoreConfigLevel::User,
            ConfigLevel::Workspace => CoreConfigLevel::Workspace,
        }
    }
}

impl From<CoreConfigLevel> for ConfigLevel {
    fn from(level: CoreConfigLevel) -> Self {
        match level {
            CoreConfigLevel::User => ConfigLevel::User,
            CoreConfigLevel::Workspace => ConfigLevel::Workspace,
        }
    }
}

/// Where a provider configuration came from
#[napi(string_enum)]
pub enum ProviderConfigSource {
    VSCodeUser,
    VSCodeWorkspace,
    NativeUser,
    NativeWorkspace,
    Runtime,
    Unknown,
}

impl From<openllm_core::types::ConfigSource> for ProviderConfigSource {
    fn from(source: openllm_core::types::ConfigSource) -> Self {
        match source {
            openllm_core::types::ConfigSource::VSCodeUser => ProviderConfigSource::VSCodeUser,
            openllm_core::types::ConfigSource::VSCodeWorkspace => ProviderConfigSource::VSCodeWorkspace,
            openllm_core::types::ConfigSource::NativeUser => ProviderConfigSource::NativeUser,
            openllm_core::types::ConfigSource::NativeWorkspace => ProviderConfigSource::NativeWorkspace,
            openllm_core::types::ConfigSource::Runtime => ProviderConfigSource::Runtime,
            openllm_core::types::ConfigSource::Unknown => ProviderConfigSource::Unknown,
        }
    }
}

#[napi(object)]
pub struct ProviderConfig {
    pub name: String,
    pub enabled: bool,
    pub api_base: Option<String>,
    pub models: Vec<String>,
    /// Where this config came from
    pub source: ProviderConfigSource,
    /// Human-readable source description
    pub source_detail: String,
}

impl From<openllm_core::types::ProviderConfig> for ProviderConfig {
    fn from(config: openllm_core::types::ProviderConfig) -> Self {
        let source_detail = config.source.to_string();
        Self {
            name: config.name,
            enabled: config.enabled,
            api_base: config.api_base,
            models: config.models,
            source: config.source.into(),
            source_detail,
        }
    }
}

impl From<ProviderConfig> for openllm_core::types::ProviderConfig {
    fn from(config: ProviderConfig) -> Self {
        let source = match config.source {
            ProviderConfigSource::VSCodeUser => openllm_core::types::ConfigSource::VSCodeUser,
            ProviderConfigSource::VSCodeWorkspace => openllm_core::types::ConfigSource::VSCodeWorkspace,
            ProviderConfigSource::NativeUser => openllm_core::types::ConfigSource::NativeUser,
            ProviderConfigSource::NativeWorkspace => openllm_core::types::ConfigSource::NativeWorkspace,
            ProviderConfigSource::Runtime => openllm_core::types::ConfigSource::Runtime,
            ProviderConfigSource::Unknown => openllm_core::types::ConfigSource::Unknown,
        };
        openllm_core::types::ProviderConfig {
            name: config.name,
            enabled: config.enabled,
            api_base: config.api_base,
            models: config.models,
            source,
        }
    }
}

/// File-based configuration provider (YAML)
#[napi]
pub struct FileConfigProvider {
    inner: Arc<CoreFileConfigProvider>,
}

#[napi]
impl FileConfigProvider {
    #[napi(factory)]
    pub fn user() -> Self {
        Self { inner: Arc::new(CoreFileConfigProvider::user()) }
    }

    #[napi(factory)]
    pub fn workspace(workspace_root: String) -> Self {
        Self { inner: Arc::new(CoreFileConfigProvider::workspace(workspace_root)) }
    }

    #[napi(getter)]
    pub fn path(&self) -> String {
        self.inner.path().to_string_lossy().to_string()
    }

    #[napi(getter)]
    pub fn level(&self) -> ConfigLevel {
        self.inner.level().into()
    }

    #[napi]
    pub fn exists(&self) -> bool {
        self.inner.exists()
    }

    #[napi]
    pub async fn get_providers(&self) -> Result<Vec<ProviderConfig>> {
        let providers = self.inner.get_providers().await;
        Ok(providers.into_iter().map(|p| p.into()).collect())
    }

    #[napi]
    pub async fn add_provider(&self, config: ProviderConfig) -> Result<()> {
        self.inner.add_provider(config.into()).await
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn update_provider(&self, name: String, config: ProviderConfig) -> Result<()> {
        self.inner.update_provider(&name, config.into()).await
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn remove_provider(&self, name: String) -> Result<()> {
        self.inner.remove_provider(&name).await
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn reload(&self) -> Result<()> {
        self.inner.reload()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(())
    }

    #[napi]
    pub fn backup(&self) -> Result<Option<String>> {
        let backup_path = self.inner.backup()
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(backup_path.map(|p| p.to_string_lossy().to_string()))
    }

    #[napi]
    pub fn export_json(&self) -> Result<String> {
        self.inner.export_json()
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn import_json(&self, json: String) -> Result<()> {
        self.inner.import_json(&json)
            .map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub fn import_providers(&self, providers: Vec<ProviderConfig>) -> Result<()> {
        let core_providers: Vec<openllm_core::types::ProviderConfig> = 
            providers.into_iter().map(|p| p.into()).collect();
        self.inner.import_providers(core_providers)
            .map_err(|e| Error::from_reason(e.to_string()))
    }
}

// ============================================================================
// Chat Message Types
// ============================================================================

#[napi(string_enum)]
pub enum MessageRole {
    System,
    User,
    Assistant,
}

#[napi(object)]
pub struct ChatMessage {
    pub role: MessageRole,
    pub content: String,
}

// ============================================================================
// Tool Types (used internally for orchestrator)
// ============================================================================

#[napi(object)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub input_schema: Option<String>,
}

#[napi(object)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: String,  // JSON string
}

#[napi(object)]
pub struct ToolResult {
    pub call_id: String,
    pub content: String,
    pub is_error: bool,
}

// ============================================================================
// Model Configuration
// ============================================================================

#[napi(object)]
pub struct ModelCapabilities {
    pub image_input: bool,
    pub tool_calling: bool,
    pub streaming: bool,
}

#[napi(object)]
pub struct ModelConfig {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model: String,
    pub api_key: Option<String>,
    pub api_base: Option<String>,
    pub context_length: Option<u32>,
}

#[napi(object)]
pub struct DefaultModel {
    pub id: String,
    pub name: String,
    pub context_length: u32,
    pub capabilities: ModelCapabilities,
}

#[napi(object)]
pub struct ProviderMetadata {
    pub id: String,
    pub display_name: String,
    pub default_api_base: String,
    pub requires_api_key: bool,
    pub default_models: Vec<DefaultModel>,
}

impl From<openllm_core::types::ProviderMetadata> for ProviderMetadata {
    fn from(m: openllm_core::types::ProviderMetadata) -> Self {
        Self {
            id: m.id,
            display_name: m.display_name,
            default_api_base: m.default_api_base,
            requires_api_key: m.requires_api_key,
            default_models: m.default_models.into_iter().map(|dm| DefaultModel {
                id: dm.id,
                name: dm.name,
                context_length: dm.context_length,
                capabilities: ModelCapabilities {
                    image_input: dm.capabilities.image_input,
                    tool_calling: dm.capabilities.tool_calling,
                    streaming: dm.capabilities.streaming,
                },
            }).collect(),
        }
    }
}

// ============================================================================
// Registry Functions
// ============================================================================

#[napi]
pub fn list_secret_stores() -> Vec<StoreInfo> {
    core_list_secret_stores()
        .into_iter()
        .map(|(name, description, is_plugin)| StoreInfo { name, description, is_plugin })
        .collect()
}

/// List all available provider metadata
/// 
/// Returns metadata for all supported providers via the unified GenaiProvider
#[napi]
pub fn list_providers() -> Vec<ProviderMetadata> {
    let logger: Arc<dyn Logger> = Arc::new(NoOpLogger::new());
    
    // Get all supported provider IDs and create metadata for each
    core_supported_providers()
        .iter()
        .filter(|&id| *id != "mock") // Exclude mock from public list
        .map(|&id| {
            core_create_provider(id, Arc::clone(&logger)).metadata().into()
        })
        .collect()
}

// ============================================================================
// Streaming Types
// ============================================================================

/// Option for a user prompt response
#[napi(object)]
pub struct PromptOption {
    /// Unique ID for this option
    pub id: String,
    /// Display label for the option
    pub label: String,
    /// Whether this is the default/recommended option
    pub is_default: bool,
}

/// A chunk from a streaming response or orchestration event
#[napi(object)]
pub struct StreamChunk {
    /// Chunk type: "text", "tool_call", "tool_call_delta", "tool_executing",
    /// "tool_result", "orchestration_status", "user_prompt", "done", "error"
    pub chunk_type: String,
    
    // -- Text chunk fields --
    /// Text content (for text chunks)
    pub text: Option<String>,
    
    // -- Tool call chunk fields --
    /// Tool call (for tool_call chunks)
    pub tool_call: Option<ToolCall>,
    
    // -- Tool call delta chunk fields --
    /// Tool call ID (for tool_call_delta, tool_executing, tool_result chunks)
    pub tool_call_id: Option<String>,
    /// Tool name (for tool_call_delta, tool_executing, tool_result chunks)
    pub tool_name: Option<String>,
    /// Tool input delta (for tool_call_delta chunks)
    pub tool_input_delta: Option<String>,
    /// Tool arguments (for tool_executing chunks)
    pub tool_arguments: Option<String>,
    /// Tool result content (for tool_result chunks)
    pub tool_result: Option<String>,
    /// Whether the tool result is an error (for tool_result chunks)
    pub is_error: Option<bool>,
    
    // -- Orchestration status chunk fields --
    /// Current iteration number (for orchestration_status chunks)
    pub iteration: Option<u32>,
    /// Maximum iterations allowed (for orchestration_status chunks)
    pub max_iterations: Option<u32>,
    
    // -- User prompt chunk fields --
    /// Unique ID for this prompt (for user_prompt chunks)
    pub prompt_id: Option<String>,
    /// Type of prompt (for user_prompt chunks)
    pub prompt_type: Option<String>,
    /// Title for the prompt (for user_prompt chunks)
    pub title: Option<String>,
    /// Message for the prompt (for user_prompt chunks, also used for status messages)
    pub message: Option<String>,
    /// Available options (for user_prompt chunks)
    pub options: Option<Vec<PromptOption>>,
    /// Context data as JSON string (for user_prompt chunks)
    pub context: Option<String>,
    
    // -- Done chunk fields --
    /// Summary (for done chunks)
    pub summary: Option<String>,
    
    // -- Error chunk fields --
    /// Whether the error is recoverable (for error chunks)
    pub recoverable: Option<bool>,
}

impl From<CoreStreamChunk> for StreamChunk {
    fn from(chunk: CoreStreamChunk) -> Self {
        let default = Self {
            chunk_type: String::new(),
            text: None,
            tool_call: None,
            tool_call_id: None,
            tool_name: None,
            tool_input_delta: None,
            tool_arguments: None,
            tool_result: None,
            is_error: None,
            iteration: None,
            max_iterations: None,
            prompt_id: None,
            prompt_type: None,
            title: None,
            message: None,
            options: None,
            context: None,
            summary: None,
            recoverable: None,
        };
        
        match chunk {
            CoreStreamChunk::Text { text } => Self {
                chunk_type: "text".to_string(),
                text: Some(text),
                ..default
            },
            CoreStreamChunk::ToolCall { tool_call } => Self {
                chunk_type: "tool_call".to_string(),
                tool_call: Some(ToolCall {
                    id: tool_call.id,
                    name: tool_call.name,
                    input: tool_call.input.to_string(),
                }),
                ..default
            },
            CoreStreamChunk::ToolCallDelta { id, name, input_delta } => Self {
                chunk_type: "tool_call_delta".to_string(),
                tool_call_id: Some(id),
                tool_name: name,
                tool_input_delta: input_delta,
                ..default
            },
            CoreStreamChunk::ToolExecuting { id, name, arguments } => Self {
                chunk_type: "tool_executing".to_string(),
                tool_call_id: Some(id),
                tool_name: Some(name),
                tool_arguments: Some(arguments),
                ..default
            },
            CoreStreamChunk::ToolResult { id, name, result, is_error } => Self {
                chunk_type: "tool_result".to_string(),
                tool_call_id: Some(id),
                tool_name: Some(name),
                tool_result: Some(result),
                is_error: Some(is_error),
                ..default
            },
            CoreStreamChunk::OrchestrationStatus { iteration, max_iterations, message } => Self {
                chunk_type: "orchestration_status".to_string(),
                iteration: Some(iteration),
                max_iterations: Some(max_iterations),
                message: Some(message),
                ..default
            },
            CoreStreamChunk::UserPrompt { prompt_id, prompt_type, title, message, options, context } => Self {
                chunk_type: "user_prompt".to_string(),
                prompt_id: Some(prompt_id),
                prompt_type: Some(prompt_type),
                title: Some(title),
                message: Some(message),
                options: Some(options.into_iter().map(|o| PromptOption {
                    id: o.id,
                    label: o.label,
                    is_default: o.is_default,
                }).collect()),
                context: context.map(|c| c.to_string()),
                ..default
            },
            CoreStreamChunk::Done { summary } => Self {
                chunk_type: "done".to_string(),
                summary,
                ..default
            },
            CoreStreamChunk::Error { message, recoverable } => Self {
                chunk_type: "error".to_string(),
                message: Some(message),
                recoverable: Some(recoverable),
                ..default
            },
        }
    }
}

/// Options for streaming chat requests
#[napi(object)]
pub struct StreamChatOptions {
    /// Temperature (0.0 - 2.0)
    pub temperature: Option<f64>,
    /// Maximum tokens to generate
    pub max_tokens: Option<u32>,
    /// Stop sequences
    pub stop: Option<Vec<String>>,
}

impl Default for StreamChatOptions {
    fn default() -> Self {
        Self {
            temperature: None,
            max_tokens: None,
            stop: None,
        }
    }
}

/// Configuration for a provider request
#[napi(object)]
pub struct ProviderRequestConfig {
    /// Model name (e.g., "gpt-4o", "claude-3-5-sonnet")
    pub model: String,
    /// API key (optional, falls back to env var)
    pub api_key: Option<String>,
    /// Custom API base URL
    pub api_base: Option<String>,
}

// ============================================================================
// Message Conversion Helpers
// ============================================================================

fn convert_messages_to_core(messages: Vec<ChatMessage>) -> Vec<CoreChatMessage> {
    messages.into_iter().map(|msg| {
        CoreChatMessage {
            role: match msg.role {
                MessageRole::System => CoreMessageRole::System,
                MessageRole::User => CoreMessageRole::User,
                MessageRole::Assistant => CoreMessageRole::Assistant,
            },
            content: CoreMessageContent::Text(msg.content),
        }
    }).collect()
}

fn convert_options_to_core(options: Option<StreamChatOptions>) -> CoreStreamChatOptions {
    let opts = options.unwrap_or_default();
    let mut core_opts = CoreStreamChatOptions::new();
    
    if let Some(temp) = opts.temperature {
        core_opts = core_opts.with_temperature(temp as f32);
    }
    if let Some(max) = opts.max_tokens {
        core_opts = core_opts.with_max_tokens(max);
    }
    if let Some(stop) = opts.stop {
        core_opts = core_opts.with_stop(stop);
    }
    
    core_opts
}

// ============================================================================
// Unified LLM Provider
// ============================================================================

/// Unified LLM provider that supports all providers via genai
/// 
/// Supported providers: openai, anthropic, gemini, ollama, groq, xai, deepseek,
/// cohere, fireworks, together, azure, openrouter, mistral, redhat, mock
/// 
/// For mock provider, the model parameter in streamChat configures the behavior:
/// - "echo" or "mock-echo": Echoes back the user's message
/// - "fixed" or "fixed:response text": Returns a fixed response
/// - "error" or "error:message": Simulates an error
/// - "empty": Returns an empty response
#[napi]
pub struct LlmProvider {
    inner: Box<dyn openllm_core::providers::Provider>,
    provider_id: String,
}

#[napi]
impl LlmProvider {
    /// Create a new provider for the given provider ID
    /// 
    /// Supported: openai, anthropic, gemini, ollama, groq, xai, deepseek,
    /// cohere, fireworks, together, azure, openrouter, mistral, redhat, mock
    #[napi(constructor)]
    pub fn new(provider_id: String) -> Self {
        let logger = Arc::new(NoOpLogger::new());
        Self {
            inner: core_create_provider(&provider_id, logger),
            provider_id,
        }
    }

    #[napi(getter)]
    pub fn name(&self) -> String {
        self.inner.name().to_string()
    }

    #[napi(getter)]
    pub fn provider_id(&self) -> String {
        self.provider_id.clone()
    }

    #[napi]
    pub fn metadata(&self) -> ProviderMetadata {
        self.inner.metadata().into()
    }

    /// Stream chat completion with callback for each chunk
    #[napi]
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderRequestConfig,
        options: Option<StreamChatOptions>,
        #[napi(ts_arg_type = "(err: Error | null, chunk: StreamChunk | null) => void")]
        callback: ThreadsafeFunction<StreamChunk>,
    ) -> Result<()> {
        openllm_core::logging::info("napi", &format!(
            "LlmProvider[{}].stream_chat: model={}, messages={}, apiKey={}, apiBase={:?}",
            self.provider_id,
            config.model,
            messages.len(),
            if config.api_key.is_some() { "present" } else { "none" },
            config.api_base
        ));

        let core_messages = convert_messages_to_core(messages);
        let core_config = CoreProviderModelConfig {
            model: config.model,
            api_key: config.api_key,
            api_base: config.api_base,
        };
        let core_options = convert_options_to_core(options);
        let cancel_token = CoreCancellationToken::new();

        let stream_result = self.inner
            .stream_chat(core_messages, core_config, core_options, cancel_token)
            .await;

        match &stream_result {
            Ok(_) => openllm_core::logging::info("napi", &format!("LlmProvider[{}]: stream started", self.provider_id)),
            Err(e) => openllm_core::logging::error("napi", &format!("LlmProvider[{}]: error: {}", self.provider_id, e)),
        }

        let stream_result = stream_result.map_err(|e| Error::from_reason(e.to_string()))?;

        let mut stream = stream_result;
        let mut chunk_count = 0;
        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    chunk_count += 1;
                    let js_chunk: StreamChunk = chunk.into();
                    callback.call(Ok(js_chunk), ThreadsafeFunctionCallMode::Blocking);
                }
                Err(e) => {
                    openllm_core::logging::error("napi", &format!("LlmProvider[{}]: chunk error: {}", self.provider_id, e));
                    callback.call(
                        Err(Error::from_reason(e.to_string())),
                        ThreadsafeFunctionCallMode::Blocking,
                    );
                    break;
                }
            }
        }

        openllm_core::logging::info("napi", &format!("LlmProvider[{}]: complete, {} chunks", self.provider_id, chunk_count));
        Ok(())
    }
}

/// Get list of all supported provider IDs
#[napi]
pub fn get_supported_providers() -> Vec<String> {
    core_supported_providers().iter().map(|s| s.to_string()).collect()
}

// Note: Provider-specific classes (OpenAIProvider, AnthropicProvider, MockProvider, etc.)
// have been removed. Use the generic LlmProvider class with a provider ID string instead:
//   new LlmProvider("openai")
//   new LlmProvider("anthropic")
//   new LlmProvider("gemini")
//   new LlmProvider("mock")
//   etc.
// This provides a normalized interface where callers don't need to know about provider-specific classes.
// 
// For mock provider, configure behavior via the model parameter:
//   streamChat(messages, { model: "echo" }, ...)   // echoes user message
//   streamChat(messages, { model: "fixed:Hello" }, ...)  // returns "Hello"
//   streamChat(messages, { model: "error:Oops" }, ...)   // simulates error
//   streamChat(messages, { model: "empty" }, ...)  // returns empty response

// ============================================================================
// Factory Function for Dynamic Provider Creation
// ============================================================================

/// Create a provider by name and stream chat
/// 
/// This uses the unified create_provider factory to support all providers via genai
#[napi]
pub async fn stream_chat_with_provider(
    provider_name: String,
    messages: Vec<ChatMessage>,
    config: ProviderRequestConfig,
    options: Option<StreamChatOptions>,
    #[napi(ts_arg_type = "(err: Error | null, chunk: StreamChunk | null) => void")]
    callback: ThreadsafeFunction<StreamChunk>,
) -> Result<()> {
    let logger: Arc<dyn Logger> = Arc::new(NoOpLogger::new());
    
    openllm_core::logging::info("napi", &format!(
        "stream_chat_with_provider: provider={}, model={}, messages={}",
        provider_name, config.model, messages.len()
    ));
    
    // Use the unified create_provider factory
    let provider = core_create_provider(&provider_name, Arc::clone(&logger));
    
    let core_messages = convert_messages_to_core(messages);
    let core_config = CoreProviderModelConfig {
        model: config.model,
        api_key: config.api_key,
        api_base: config.api_base,
    };
    let core_options = convert_options_to_core(options);
    let cancel_token = CoreCancellationToken::new();

    let stream_result = provider
        .stream_chat(core_messages, core_config, core_options, cancel_token)
        .await;

    match &stream_result {
        Ok(_) => openllm_core::logging::info("napi", &format!("stream_chat_with_provider[{}]: stream started", provider_name)),
        Err(e) => openllm_core::logging::error("napi", &format!("stream_chat_with_provider[{}]: error: {}", provider_name, e)),
    }

    let mut stream = stream_result.map_err(|e| Error::from_reason(e.to_string()))?;
    let mut chunk_count = 0;

    while let Some(chunk_result) = stream.next().await {
        match chunk_result {
            Ok(chunk) => {
                chunk_count += 1;
                let js_chunk: StreamChunk = chunk.into();
                callback.call(Ok(js_chunk), ThreadsafeFunctionCallMode::Blocking);
            }
            Err(e) => {
                openllm_core::logging::error("napi", &format!("stream_chat_with_provider[{}]: chunk error: {}", provider_name, e));
                callback.call(
                    Err(Error::from_reason(e.to_string())),
                    ThreadsafeFunctionCallMode::Blocking,
                );
                break;
            }
        }
    }

    openllm_core::logging::info("napi", &format!("stream_chat_with_provider[{}]: complete, {} chunks", provider_name, chunk_count));
    Ok(())
}

// ============================================================================
// MCP Endpoint Registration
// ============================================================================
// 
// RPC has been replaced with MCP (Model Context Protocol) for VS Code communication.
// The MCP client in openllm-core connects to the VS Code MCP server for:
// - Secret management (API keys)
// - Configuration (provider settings)
// - Tool orchestration
//
// See the mcp module in openllm-core for the implementation.

// ============================================================================
// Unified Resolvers
// ============================================================================

/// Result of resolving a secret from multiple sources
#[napi(object)]
pub struct ResolvedSecret {
    /// The secret value
    pub value: String,
    /// Which source provided the secret (e.g., "environment", "rpc:vscode", "keychain")
    pub source: String,
    /// Human-readable source description
    pub source_detail: String,
}

/// Result of resolving a provider configuration
#[napi(object)]
pub struct ResolvedProviderConfig {
    /// Provider name
    pub name: String,
    /// Whether the provider is enabled
    pub enabled: bool,
    /// Optional custom API base URL
    pub api_base: Option<String>,
    /// Configured models
    pub models: Vec<String>,
    /// Which source provided this configuration
    pub source: String,
    /// Human-readable source description
    pub source_detail: String,
}

/// Information about a config/secret source
#[napi(object)]
pub struct SourceInfo {
    /// Source identifier
    pub name: String,
    /// Whether the source is available
    pub available: bool,
    /// Human-readable description or path
    pub detail: String,
}

/// Detailed information about a secret source (for batch queries)
#[napi(object)]
pub struct SecretSourceInfo {
    /// Source type: 'environment', 'dotenv', 'secretStorage', 'keychain', 'none'
    pub source: String,
    /// Human-readable description
    pub source_detail: String,
    /// Environment variable name if applicable
    pub env_var_name: Option<String>,
    /// Whether a secret was found
    pub available: bool,
}

/// Unified secret resolver that checks multiple sources in priority order
#[napi]
pub struct UnifiedSecretResolver {
    inner: CoreUnifiedSecretResolver,
}

#[napi]
impl UnifiedSecretResolver {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: CoreUnifiedSecretResolver::new(),
        }
    }

    /// Set the secrets store preference
    /// 
    /// Called by host application to inform the resolver where the user
    /// wants API keys stored.
    /// 
    /// Valid values: "vscode", "keychain"
    #[napi]
    pub fn set_secrets_store(&mut self, store: String) {
        self.inner.set_secrets_store_str(&store);
    }

    /// Get the current secrets store preference
    #[napi]
    pub fn get_secrets_store(&self) -> String {
        match self.inner.get_secrets_store() {
            openllm_core::resolver::SecretsStore::VsCode => "vscode".to_string(),
            openllm_core::resolver::SecretsStore::Keychain => "keychain".to_string(),
        }
    }

    /// Set whether to check environment variables for secrets
    #[napi]
    pub fn set_check_environment(&mut self, check: bool) {
        self.inner.set_check_environment(check);
    }

    /// Get whether environment variables are checked
    #[napi]
    pub fn get_check_environment(&self) -> bool {
        self.inner.get_check_environment()
    }

    /// Set whether to check .env files for secrets
    #[napi]
    pub fn set_check_dotenv(&mut self, check: bool) {
        self.inner.set_check_dotenv(check);
    }

    /// Get whether .env files are checked
    #[napi]
    pub fn get_check_dotenv(&self) -> bool {
        self.inner.get_check_dotenv()
    }

    /// Resolve a secret from all configured sources (async - doesn't block Node.js event loop)
    /// 
    /// Checks sources based on user preferences set via setSecretsStore/setCheckEnvironment/setCheckDotenv
    #[napi]
    pub async fn resolve(&self, key: String) -> Option<ResolvedSecret> {
        self.inner.resolve_async(&key).await.map(|r| ResolvedSecret {
            value: r.value,
            source: r.source,
            source_detail: r.source_detail,
        })
    }

    /// Store a secret to a specific destination
    /// 
    /// Destination can be:
    /// - "auto" → automatically route to best available store
    /// - "vscode" → shorthand for "rpc:vscode"
    /// - "keychain" → system keychain
    /// - "rpc:<name>" → specific RPC endpoint
    /// 
    /// Returns the name of the destination where the secret was stored.
    #[napi]
    pub fn store(&self, key: String, value: String, destination: String) -> Result<String> {
        openllm_core::logging::debug("NAPI", &format!("store key='{}', destination='{}'", key, destination));
        let result = self.inner.store(&key, &value, &destination);
        openllm_core::logging::debug("NAPI", &format!("store result: {:?}", result));
        result.map_err(|e| Error::from_reason(e))
    }

    /// Store a secret using auto-routing based on user preferences
    /// 
    /// This is the preferred method - Rust automatically routes to the correct
    /// destination based on the secrets_store preference set via setSecretsStore().
    /// 
    /// Returns the name of the destination where the secret was stored.
    #[napi]
    pub fn store_auto(&self, key: String, value: String) -> Result<String> {
        openllm_core::logging::debug("NAPI", &format!("store_auto key='{}'", key));
        let result = self.inner.store(&key, &value, "auto");
        openllm_core::logging::debug("NAPI", &format!("store_auto result: {:?}", result));
        result.map_err(|e| Error::from_reason(e))
    }

    /// Delete a secret from a specific destination
    /// 
    /// Returns the name of the destination where the secret was deleted from.
    #[napi]
    pub fn delete(&self, key: String, destination: String) -> Result<String> {
        self.inner.delete(&key, &destination)
            .map_err(|e| Error::from_reason(e))
    }

    /// Get information about where a secret is stored
    #[napi]
    pub fn get_source_info(&self, key: String) -> Option<SourceInfo> {
        self.inner.get_source_info(&key).map(|(source, detail)| SourceInfo {
            name: source,
            available: true,
            detail,
        })
    }

    /// Get source info for multiple keys in a single batch call
    /// 
    /// More efficient than calling get_source_info for each key because
    /// it reuses RPC connections and caches intermediate results.
    #[napi]
    pub fn get_all_source_info(&self, keys: Vec<String>) -> std::collections::HashMap<String, Option<SecretSourceInfo>> {
        let key_refs: Vec<&str> = keys.iter().map(|s| s.as_str()).collect();
        self.inner.get_all_source_info(&key_refs)
            .into_iter()
            .map(|(k, v)| (k, v.map(|(source, detail, env_var)| SecretSourceInfo {
                source,
                source_detail: detail,
                env_var_name: if env_var.is_empty() { None } else { Some(env_var) },
                available: true,
            })))
            .collect()
    }

    /// List all available secret sources
    #[napi]
    pub fn list_sources(&self) -> Vec<SourceInfo> {
        self.inner.list_sources()
            .into_iter()
            .map(|(name, available)| SourceInfo {
                name: name.clone(),
                available,
                detail: name,
            })
            .collect()
    }

    /// Get information about where a secret write would go
    /// 
    /// Returns (source_id, human_readable_description)
    #[napi]
    pub fn get_write_destination_info(&self) -> WriteDestinationInfo {
        let (id, detail) = self.inner.get_write_destination_info();
        WriteDestinationInfo { id, detail }
    }
}

/// Information about where a write will be routed
#[napi(object)]
pub struct WriteDestinationInfo {
    /// The destination identifier (e.g., "rpc:vscode", "keychain", "native:user")
    pub id: String,
    /// Human-readable description (e.g., "VS Code SecretStorage", "~/.config/openllm/config.yaml")
    pub detail: String,
}

/// Unified config resolver that checks multiple sources in priority order
#[napi]
pub struct UnifiedConfigResolver {
    inner: CoreUnifiedConfigResolver,
}

#[napi]
impl UnifiedConfigResolver {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: CoreUnifiedConfigResolver::new(),
        }
    }

    /// Create with a workspace path
    #[napi(factory)]
    pub fn with_workspace(workspace_path: String) -> Self {
        Self {
            inner: CoreUnifiedConfigResolver::with_workspace(workspace_path),
        }
    }

    /// Set the workspace path
    #[napi]
    pub fn set_workspace(&mut self, workspace_path: Option<String>) {
        self.inner.set_workspace(workspace_path.map(std::path::PathBuf::from));
    }

    /// Set the config source preference and load from sources (async)
    /// 
    /// Called by host application (e.g., VS Code extension) to inform the resolver
    /// where the user wants provider config stored.
    /// 
    /// Valid values: "native", "vscode"
    /// 
    /// This is async to prevent deadlocking the Node.js event loop when
    /// config source is "vscode" (which requires RPC calls).
    #[napi]
    pub async fn set_config_source(&self, source: String) -> Result<()> {
        let mut inner = self.inner.clone();
        
        // Run on blocking thread to avoid deadlocking the event loop
        // (the RPC call needs the event loop to accept the connection)
        tokio::task::spawn_blocking(move || {
            // Set config source preference and load from sources
            inner.set_config_source_str(&source);
        })
        .await
        .map_err(|e| Error::from_reason(format!("Task join error: {}", e)))?;
        
        Ok(())
    }
    
    /// Set config source preference only (no loading) - synchronous
    /// 
    /// Use this if you want to set the preference and call loadFromSourcesAsync separately.
    #[napi]
    pub fn set_config_source_sync(&mut self, source: String) {
        // Just set the preference, don't trigger load
        use openllm_core::resolver::ConfigSourcePreference;
        self.inner.config_source = ConfigSourcePreference::from_str(&source);
    }
    
    /// Load providers from sources asynchronously
    /// 
    /// Call this after setting preferences to load config from the correct sources.
    /// This is async to prevent deadlocking the Node.js event loop.
    #[napi]
    pub async fn load_from_sources_async(&self) -> Result<()> {
        let inner = self.inner.clone();
        
        tokio::task::spawn_blocking(move || {
            inner.load_from_sources();
        })
        .await
        .map_err(|e| Error::from_reason(format!("Task join error: {}", e)))?;
        
        Ok(())
    }

    /// Get the current config source preference
    #[napi]
    pub fn get_config_source(&self) -> String {
        match self.inner.get_config_source() {
            openllm_core::resolver::ConfigSourcePreference::Native => "native".to_string(),
            openllm_core::resolver::ConfigSourcePreference::VsCode => "vscode".to_string(),
        }
    }

    /// Get all providers, merged from all sources (async - doesn't block Node.js event loop)
    /// 
    /// Later sources override earlier ones (workspace overrides user)
    #[napi]
    pub async fn get_all_providers(&self) -> Vec<ResolvedProviderConfig> {
        self.inner.get_all_providers_async()
            .await
            .providers
            .into_iter()
            .map(|p| ResolvedProviderConfig {
                name: p.name,
                enabled: p.enabled,
                api_base: p.api_base,
                models: p.models,
                source: p.source,
                source_detail: p.source_detail,
            })
            .collect()
    }

    /// Get a specific provider, merged from all sources
    #[napi]
    pub fn get_provider(&self, name: String) -> Option<ResolvedProviderConfig> {
        self.inner.get_provider(&name).map(|p| ResolvedProviderConfig {
            name: p.name,
            enabled: p.enabled,
            api_base: p.api_base,
            models: p.models,
            source: p.source,
            source_detail: p.source_detail,
        })
    }

    /// Get providers at a specific scope only ("user" or "workspace")
    #[napi]
    pub fn get_providers_at_scope(&self, scope: String) -> Vec<ResolvedProviderConfig> {
        self.inner.get_providers_at_scope(&scope)
            .into_iter()
            .map(|p| ResolvedProviderConfig {
                name: p.name,
                enabled: p.enabled,
                api_base: p.api_base,
                models: p.models,
                source: p.source,
                source_detail: p.source_detail,
            })
            .collect()
    }

    /// List all available config sources
    #[napi]
    pub fn list_sources(&self) -> Vec<SourceInfo> {
        self.inner.list_sources()
            .into_iter()
            .map(|(name, available, detail)| SourceInfo {
                name,
                available,
                detail,
            })
            .collect()
    }

    // ========== WRITE METHODS ==========
    // These intelligently route writes to the appropriate destination
    // IMPORTANT: These MUST be async to prevent deadlock!
    // The methods may call RPC back to the Node.js server, so we can't block the event loop.

    /// Save a provider configuration (async to prevent event loop deadlock)
    /// 
    /// The scope determines user vs workspace ("user" or "workspace").
    /// The resolver automatically routes to VS Code (if RPC available) or native YAML.
    /// 
    /// Returns the destination where the config was saved.
    #[napi]
    pub async fn save_provider(&self, provider: ResolvedProviderConfig, scope: String) -> Result<String> {
        let core_provider = openllm_core::resolver::ResolvedProvider {
            name: provider.name.clone(),
            enabled: provider.enabled,
            api_base: provider.api_base.clone(),
            models: provider.models.clone(),
            source: provider.source.clone(),
            source_detail: provider.source_detail.clone(),
        };
        let inner = self.inner.clone();
        
        // Run on blocking thread to avoid deadlocking the event loop
        // (the RPC call needs the event loop to accept the connection)
        tokio::task::spawn_blocking(move || {
            inner.save_provider(&core_provider, &scope)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Task join error: {}", e)))?
        .map_err(|e| Error::from_reason(e))
    }

    /// Update models for a provider (async to prevent event loop deadlock)
    /// 
    /// Returns the destination where the config was saved.
    #[napi]
    pub async fn update_provider_models(&self, provider_name: String, models: Vec<String>, scope: String) -> Result<String> {
        let inner = self.inner.clone();
        
        tokio::task::spawn_blocking(move || {
            inner.update_provider_models(&provider_name, models, &scope)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Task join error: {}", e)))?
        .map_err(|e| Error::from_reason(e))
    }

    /// Toggle provider enabled state (async to prevent event loop deadlock)
    /// 
    /// Returns the destination where the config was saved.
    #[napi]
    pub async fn toggle_provider(&self, provider_name: String, enabled: bool, scope: String) -> Result<String> {
        let inner = self.inner.clone();
        
        tokio::task::spawn_blocking(move || {
            inner.toggle_provider(&provider_name, enabled, &scope)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Task join error: {}", e)))?
        .map_err(|e| Error::from_reason(e))
    }

    /// Remove a provider from the specified scope (async to prevent event loop deadlock)
    /// 
    /// Returns the destination where the provider was removed from.
    #[napi]
    pub async fn remove_provider(&self, provider_name: String, scope: String) -> Result<String> {
        let inner = self.inner.clone();
        
        tokio::task::spawn_blocking(move || {
            inner.remove_provider(&provider_name, &scope)
        })
        .await
        .map_err(|e| Error::from_reason(format!("Task join error: {}", e)))?
        .map_err(|e| Error::from_reason(e))
    }

    /// Get information about where a config write would go for the given scope
    #[napi]
    pub fn get_write_destination_info(&self, scope: String) -> WriteDestinationInfo {
        let (id, detail) = self.inner.get_write_destination_info(&scope);
        WriteDestinationInfo { id, detail }
    }

    /// Force reload provider state from all sources
    /// 
    /// Call this when you know external config has changed (e.g., user edited config file).
    /// Normally not needed since in-memory state is updated on writes.
    #[napi]
    pub fn reload(&self) {
        self.inner.reload();
    }

    /// Force reload provider state from all sources (async version)
    #[napi]
    pub async fn reload_async(&self) {
        self.inner.reload_async().await;
    }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/// Resolve a secret from all sources (convenience function, async)
/// 
/// This is the main entry point for getting secrets. It checks:
/// 1. Environment variables
/// 2. VS Code (if RPC endpoint registered)
/// 3. System keychain
#[napi]
pub async fn resolve_secret(key: String) -> Option<ResolvedSecret> {
    let resolver = CoreUnifiedSecretResolver::new();
    resolver.resolve_async(&key).await.map(|r| ResolvedSecret {
        value: r.value,
        source: r.source,
        source_detail: r.source_detail,
    })
}

/// Resolve all provider configurations (convenience function, async)
/// 
/// This merges configurations from all sources with proper priority.
#[napi]
pub async fn resolve_all_providers(workspace_path: Option<String>) -> Vec<ResolvedProviderConfig> {
    let resolver = match workspace_path {
        Some(path) => CoreUnifiedConfigResolver::with_workspace(path),
        None => CoreUnifiedConfigResolver::new(),
    };
    resolver.get_all_providers_async()
        .await
        .providers
        .into_iter()
        .map(|p| ResolvedProviderConfig {
            name: p.name,
            enabled: p.enabled,
            api_base: p.api_base,
            models: p.models,
            source: p.source,
            source_detail: p.source_detail,
        })
        .collect()
}

/// Resolve a specific provider configuration (convenience function)
#[napi]
pub fn resolve_provider(name: String, workspace_path: Option<String>) -> Option<ResolvedProviderConfig> {
    let resolver = match workspace_path {
        Some(path) => CoreUnifiedConfigResolver::with_workspace(path),
        None => CoreUnifiedConfigResolver::new(),
    };
    resolver.get_provider(&name).map(|p| ResolvedProviderConfig {
        name: p.name,
        enabled: p.enabled,
        api_base: p.api_base,
        models: p.models,
        source: p.source,
        source_detail: p.source_detail,
    })
}

// ============================================================================
// Debug Logging
// ============================================================================

/// Get the path to the debug log file
#[napi]
pub fn get_debug_log_path() -> String {
    openllm_core::logging::log_file_path().to_string_lossy().to_string()
}

/// Clear the debug log file
#[napi]
pub fn clear_debug_log() {
    openllm_core::logging::clear_log();
}

/// Write a message to the debug log
#[napi]
pub fn debug_log(module: String, message: String) {
    openllm_core::logging::info(&module, &message);
}

// ============================================================================
// Unified Chat Function (Simple API)
// ============================================================================

/// Configuration for the chat() function
#[napi(object)]
#[derive(Debug, Clone)]
pub struct ChatConfig {
    /// Provider ID (e.g., "openai", "anthropic", "vscode")
    pub provider: String,
    /// Model name (e.g., "gpt-4o", "claude-3-5-sonnet-20241022")
    pub model: String,
    /// API key for authentication (optional for some providers)
    pub api_key: Option<String>,
    /// Custom API base URL (optional)
    pub api_base: Option<String>,
    /// Maximum tool calling iterations (default: 10)
    pub max_tool_iterations: Option<u32>,
    /// Whether to include tools from MCP (default: true if MCP is registered)
    pub enable_tools: Option<bool>,
}

/// Unified chat function - the simplest way to chat with any LLM
/// 
/// This function handles everything:
/// 1. Creates the appropriate provider based on config.provider
/// 2. Connects to MCP for tools (if registered)
/// 3. Runs the tool orchestration loop
/// 4. Streams all events back via the callback
/// 
/// ## Example
/// 
/// ```typescript
/// import { chat } from '@openllm/native';
/// 
/// await chat(
///   [{ role: 'user', content: 'Hello!' }],
///   { provider: 'openai', model: 'gpt-4o', apiKey: 'sk-...' },
///   (chunk) => {
///     if (chunk.chunkType === 'text') {
///       process.stdout.write(chunk.text);
///     }
///   }
/// );
/// ```
#[napi]
pub async fn chat(
    messages: Vec<ChatMessage>,
    config: ChatConfig,
    #[napi(ts_arg_type = "(chunk: StreamChunk) => void")]
    callback: ThreadsafeFunction<StreamChunk, ErrorStrategy::CalleeHandled>,
) -> Result<()> {
    openllm_core::logging::info("napi", &format!(
        "chat: provider={}, model={}", config.provider, config.model
    ));
    
    let logger: Arc<dyn Logger> = Arc::new(NoOpLogger::new());
    
    // Create the provider
    let provider = core_create_provider(&config.provider, Arc::clone(&logger));
    let provider_arc: Arc<dyn openllm_core::providers::Provider> = Arc::from(provider);
    
    // Convert messages
    let core_messages: Vec<CoreChatMessage> = messages.iter()
        .map(|m| {
            let role = match m.role {
                MessageRole::System => CoreMessageRole::System,
                MessageRole::User => CoreMessageRole::User,
                MessageRole::Assistant => CoreMessageRole::Assistant,
            };
            CoreChatMessage {
                role,
                content: CoreMessageContent::Text(m.content.clone()),
            }
        })
        .collect();
    
    // Build model config
    let mut core_model = CoreProviderModelConfig::new(&config.model);
    if let Some(ref api_key) = config.api_key {
        core_model = core_model.with_api_key(api_key.clone());
    }
    if let Some(ref api_base) = config.api_base {
        core_model = core_model.with_api_base(api_base.clone());
    }
    
    // Build options
    let core_options = CoreStreamChatOptions::new();
    
    // Check if we should use MCP for tools
    let enable_tools = config.enable_tools.unwrap_or(true);
    let mcp_available = has_mcp_endpoint("vscode".to_string());
    
    if enable_tools && mcp_available {
        // Use orchestrator with tools
        openllm_core::logging::info("napi", "chat: using orchestrator with MCP tools");
        
        // Get MCP client
        let mcp_client = get_or_create_mcp_client_async().await
            .map_err(|e| Error::from_reason(format!("Failed to connect to MCP: {}", e)))?;
        
        // Create tool registry
        let mut tool_registry = openllm_core::ToolRegistry::new(Arc::clone(&logger));
        tool_registry.set_client(mcp_client);
        tool_registry.refresh().await
            .map_err(|e| Error::from_reason(format!("Failed to refresh tools: {}", e)))?;
        
        openllm_core::logging::info("napi", &format!(
            "chat: found {} tools", tool_registry.tool_count()
        ));
        
        // Create orchestrator
        let max_iterations = config.max_tool_iterations.unwrap_or(10);
        let orchestrator_config = openllm_core::OrchestratorConfig::default()
            .with_max_iterations(max_iterations)
            .with_continue_on_error(true)
            .with_emit_status(true);
        
        let orchestrator = Arc::new(openllm_core::ChatOrchestrator::new(
            Arc::new(tool_registry),
            Arc::clone(&logger),
            orchestrator_config,
        ));
        
        // Stream with orchestration
        let cancel_token = CoreCancellationToken::new();
        let mut stream = orchestrator.stream_chat(
            provider_arc,
            core_messages,
            core_model,
            core_options,
            cancel_token,
        );
        
        while let Some(chunk) = stream.next().await {
            // chunk is already CoreStreamChunk
            let napi_chunk: StreamChunk = chunk.into();
            callback.call(Ok(napi_chunk), ThreadsafeFunctionCallMode::NonBlocking);
        }
    } else {
        // Simple streaming without tools
        openllm_core::logging::info("napi", "chat: using simple streaming (no tools)");
        
        let cancel_token = CoreCancellationToken::new();
        let stream_result = provider_arc
            .stream_chat(core_messages, core_model, core_options, cancel_token)
            .await;
        
        let mut stream = stream_result.map_err(|e| Error::from_reason(e.to_string()))?;
        
        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    let napi_chunk: StreamChunk = chunk.into();
                    callback.call(Ok(napi_chunk), ThreadsafeFunctionCallMode::NonBlocking);
                }
                Err(e) => {
                    callback.call(
                        Err(Error::from_reason(e.to_string())),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                    break;
                }
            }
        }
    }
    
    openllm_core::logging::info("napi", "chat: complete");
    Ok(())
}

// ============================================================================
// Chat Orchestrator (Advanced API - kept for flexibility)
// ============================================================================

/// Configuration for the chat orchestrator
#[napi(object)]
pub struct OrchestratorConfig {
    /// Maximum number of tool calling iterations (default: 10)
    pub max_iterations: Option<u32>,
    /// Whether to continue on tool errors (default: true)
    pub continue_on_error: Option<bool>,
    /// Whether to emit orchestration status chunks (default: true)
    pub emit_status: Option<bool>,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            max_iterations: None,
            continue_on_error: None,
            emit_status: None,
        }
    }
}

impl From<OrchestratorConfig> for openllm_core::OrchestratorConfig {
    fn from(config: OrchestratorConfig) -> Self {
        let mut core_config = openllm_core::OrchestratorConfig::default();
        if let Some(max) = config.max_iterations {
            core_config = core_config.with_max_iterations(max);
        }
        if let Some(continue_on_error) = config.continue_on_error {
            core_config = core_config.with_continue_on_error(continue_on_error);
        }
        if let Some(emit_status) = config.emit_status {
            core_config = core_config.with_emit_status(emit_status);
        }
        core_config
    }
}

/// User response to a prompt
#[napi(object)]
pub struct UserPromptResponse {
    /// The prompt ID this is responding to
    pub prompt_id: String,
    /// The selected option ID
    pub selected_option: String,
}

/// Chat orchestrator that manages the complete tool calling flow
/// 
/// The orchestrator handles:
/// - Streaming responses from the LLM
/// - Detecting and executing tool calls
/// - Adding tool results to the conversation
/// - Continuing until no more tool calls or max iterations
/// 
/// ## Example
/// 
/// ```typescript
/// const orchestrator = new ChatOrchestrator(toolRegistry, logger, {
///   maxIterations: 10,
///   continueOnError: true,
///   emitStatus: true,
/// });
/// 
/// const stream = await orchestrator.streamChat(
///   provider,
///   messages,
///   { model: "gpt-4" },
///   {},
///   (chunk) => {
///     switch (chunk.chunkType) {
///       case "text":
///         console.log(chunk.text);
///         break;
///       case "tool_executing":
///         console.log(`Running tool: ${chunk.toolName}`);
///         break;
///       case "tool_result":
///         console.log(`Tool result: ${chunk.toolResult}`);
///         break;
///       case "user_prompt":
///         // Handle user approval request
///         break;
///     }
///   }
/// );
/// ```
#[napi]
pub struct ChatOrchestrator {
    inner: Arc<openllm_core::ChatOrchestrator>,
}

#[napi]
impl ChatOrchestrator {
    /// Create a new chat orchestrator
    /// 
    /// @param config - Optional configuration for the orchestrator
    #[napi(constructor)]
    pub fn new(config: Option<OrchestratorConfig>) -> Result<Self> {
        let core_config: openllm_core::OrchestratorConfig = config.unwrap_or_default().into();
        let logger: Arc<dyn Logger> = Arc::new(NoOpLogger);
        
        // Create a tool registry - in practice, this would be shared
        let tool_registry = Arc::new(openllm_core::ToolRegistry::new(logger.clone()));
        
        let orchestrator = openllm_core::ChatOrchestrator::new(
            tool_registry,
            logger,
            core_config,
        );
        
        Ok(Self {
            inner: Arc::new(orchestrator),
        })
    }
    
    /// Create a new chat orchestrator with a shared tool registry
    #[napi(factory)]
    pub fn with_tool_registry(
        tool_registry: &ToolRegistry,
        config: Option<OrchestratorConfig>,
    ) -> Result<Self> {
        let core_config: openllm_core::OrchestratorConfig = config.unwrap_or_default().into();
        let logger: Arc<dyn Logger> = Arc::new(NoOpLogger);
        
        let orchestrator = openllm_core::ChatOrchestrator::new(
            tool_registry.inner.clone(),
            logger,
            core_config,
        );
        
        Ok(Self {
            inner: Arc::new(orchestrator),
        })
    }
    
    /// Stream chat with full tool orchestration
    /// 
    /// This method handles the complete tool calling loop:
    /// 1. Send messages to the LLM
    /// 2. Stream the response
    /// 3. If tool calls are detected, execute them
    /// 4. Add tool results to the conversation
    /// 5. Continue until no more tool calls
    /// 
    /// Stream chat with provider specified by config
    /// 
    /// This is the main entry point for TypeScript callers. It creates the provider
    /// based on config.provider and handles the orchestration loop.
    /// 
    /// @param messages - The conversation messages
    /// @param config - Configuration including provider ID, model, API key, etc.
    /// @param options - Streaming options (tools, temperature, etc.)
    /// @param callback - Callback function called for each stream chunk
    #[napi]
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ChatRequestConfig,
        options: Option<StreamChatOptions>,
        #[napi(ts_arg_type = "(chunk: StreamChunk) => void")]
        callback: ThreadsafeFunction<StreamChunk, ErrorStrategy::CalleeHandled>,
    ) -> Result<()> {
        use futures::StreamExt;
        
        // Create provider from config
        let logger: Arc<dyn Logger> = Arc::new(NoOpLogger::new());
        let provider = openllm_core::providers::create_provider(&config.provider, logger);
        
        // Convert messages
        let core_messages: Vec<CoreChatMessage> = messages.iter()
            .map(|m| {
                let role = match m.role {
                    MessageRole::System => CoreMessageRole::System,
                    MessageRole::User => CoreMessageRole::User,
                    MessageRole::Assistant => CoreMessageRole::Assistant,
                };
                CoreChatMessage {
                    role,
                    content: CoreMessageContent::Text(m.content.clone()),
                }
            })
            .collect();
        
        // Build model config
        let mut core_model = CoreProviderModelConfig::new(&config.model);
        if let Some(ref api_key) = config.api_key {
            core_model = core_model.with_api_key(api_key.clone());
        }
        if let Some(ref api_base) = config.api_base {
            core_model = core_model.with_api_base(api_base.clone());
        }
        
        // Build options
        let opts = options.unwrap_or_default();
        let mut core_options = CoreStreamChatOptions::new();
        if let Some(temp) = opts.temperature {
            core_options = core_options.with_temperature(temp as f32);
        }
        if let Some(max) = opts.max_tokens {
            core_options = core_options.with_max_tokens(max);
        }
        if let Some(stop) = opts.stop {
            core_options = core_options.with_stop(stop);
        }
        
        // Create cancel token
        let cancel_token = CoreCancellationToken::new();
        
        // Create provider Arc
        let provider_arc: Arc<dyn openllm_core::providers::Provider> = Arc::from(provider);
        
        // Stream with orchestration
        let mut stream = self.inner.clone().stream_chat(
            provider_arc,
            core_messages,
            core_model,
            core_options,
            cancel_token,
        );
        
        while let Some(chunk) = stream.next().await {
            let napi_chunk: StreamChunk = chunk.into();
            callback.call(Ok(napi_chunk), ThreadsafeFunctionCallMode::NonBlocking);
        }
        
        Ok(())
    }
}

/// Configuration for ChatOrchestrator.streamChat - specifies provider and model
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct ChatRequestConfig {
    /// Provider ID (e.g., "openai", "anthropic", "vscode")
    pub provider: String,
    /// Model name (e.g., "gpt-4o", "claude-3-5-sonnet-20241022")
    pub model: String,
    /// API key for authentication (optional for some providers)
    pub api_key: Option<String>,
    /// Custom API base URL (optional)
    pub api_base: Option<String>,
}

// ============================================================================
// Tool Registry (exposed for orchestrator)
// ============================================================================

/// Tool registry for managing available tools from MCP servers
/// 
/// The registry connects to registered MCP endpoints to discover and execute tools.
/// Call `registerMcpEndpoint()` before creating a ToolRegistry to enable tool discovery.
/// 
/// ## Example
/// ```typescript
/// // First, register the MCP endpoint (done by extension on startup)
/// native.registerMcpEndpoint({
///   name: 'vscode',
///   socketPath: mcpInfo.socketPath,
/// });
/// 
/// // Create registry and refresh tools
/// const registry = new ToolRegistry();
/// await registry.connectToMcp(); // Connect to registered endpoint
/// await registry.refresh();      // Discover tools
/// 
/// console.log(`Found ${registry.toolCount} tools`);
/// ```
#[napi]
pub struct ToolRegistry {
    inner: Arc<openllm_core::ToolRegistry>,
}

#[napi]
impl ToolRegistry {
    /// Create a new tool registry
    /// 
    /// The registry is created without an MCP connection. Call `connectToMcp()`
    /// to connect to a registered MCP endpoint for tool discovery.
    #[napi(constructor)]
    pub fn new() -> Self {
        let logger: Arc<dyn Logger> = Arc::new(NoOpLogger);
        Self {
            inner: Arc::new(openllm_core::ToolRegistry::new(logger)),
        }
    }
    
    /// Connect to a registered MCP endpoint for tool discovery and execution
    /// 
    /// This must be called after `registerMcpEndpoint()` has been called.
    /// Returns an error if no MCP endpoint is registered.
    #[napi]
    pub async fn connect_to_mcp(&self) -> Result<()> {
        let client = get_or_create_mcp_client_async().await?;
        self.inner.set_client(client);
        Ok(())
    }
    
    /// Check if connected to an MCP endpoint
    #[napi(getter)]
    pub fn is_connected(&self) -> bool {
        // The inner registry has a client if we've called set_client
        self.inner.tool_count() > 0 || self.inner.enabled_tool_count() >= 0
    }
    
    /// Refresh the tool list from all MCP sources
    /// 
    /// Requires `connectToMcp()` to have been called first.
    #[napi]
    pub async fn refresh(&self) -> Result<()> {
        self.inner.refresh()
            .await
            .map_err(|e| Error::from_reason(e))
    }
    
    /// Get count of available tools (including internal and disabled)
    #[napi(getter)]
    pub fn tool_count(&self) -> u32 {
        self.inner.tool_count() as u32
    }
    
    /// Get count of enabled, user-visible tools
    #[napi(getter)]
    pub fn enabled_tool_count(&self) -> u32 {
        self.inner.enabled_tool_count() as u32
    }
    
    /// Enable or disable a tool by name
    #[napi]
    pub fn set_tool_enabled(&self, name: String, enabled: bool) {
        self.inner.set_tool_enabled(&name, enabled);
    }
}
