//! Node.js bindings for OpenLLM via napi-rs

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
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
use openllm_core::rpc::{
    RpcEndpoint as CoreRpcEndpoint,
    register_rpc_endpoint as core_register_rpc_endpoint,
    get_rpc_endpoint as core_get_rpc_endpoint,
    RpcSecretStore as CoreRpcSecretStore,
    RpcConfigProvider as CoreRpcConfigProvider,
};
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
    Provider,
    ProviderModelConfig as CoreProviderModelConfig,
    StreamChatOptions as CoreStreamChatOptions,
    MockProvider as CoreMockProvider,
    MockConfig as CoreMockConfig,
    MockMode as CoreMockMode,
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

#[napi]
pub fn create_system_message(content: String) -> ChatMessage {
    ChatMessage { role: MessageRole::System, content }
}

#[napi]
pub fn create_user_message(content: String) -> ChatMessage {
    ChatMessage { role: MessageRole::User, content }
}

#[napi]
pub fn create_assistant_message(content: String) -> ChatMessage {
    ChatMessage { role: MessageRole::Assistant, content }
}

// ============================================================================
// Tool Types
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

#[napi]
pub fn create_tool_result(call_id: String, content: String) -> ToolResult {
    ToolResult { call_id, content, is_error: false }
}

#[napi]
pub fn create_tool_error(call_id: String, content: String) -> ToolResult {
    ToolResult { call_id, content, is_error: true }
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

/// A chunk from a streaming response
#[napi(object)]
pub struct StreamChunk {
    /// Chunk type: "text", "tool_call", or "tool_call_delta"
    pub chunk_type: String,
    /// Text content (for text chunks)
    pub text: Option<String>,
    /// Tool call (for tool_call chunks)
    pub tool_call: Option<ToolCall>,
    /// Tool call ID (for tool_call_delta chunks)
    pub tool_call_id: Option<String>,
    /// Tool name (for tool_call_delta chunks)
    pub tool_name: Option<String>,
    /// Tool input delta (for tool_call_delta chunks)
    pub tool_input_delta: Option<String>,
}

impl From<CoreStreamChunk> for StreamChunk {
    fn from(chunk: CoreStreamChunk) -> Self {
        match chunk {
            CoreStreamChunk::Text { text } => Self {
                chunk_type: "text".to_string(),
                text: Some(text),
                tool_call: None,
                tool_call_id: None,
                tool_name: None,
                tool_input_delta: None,
            },
            CoreStreamChunk::ToolCall { tool_call } => Self {
                chunk_type: "tool_call".to_string(),
                text: None,
                tool_call: Some(ToolCall {
                    id: tool_call.id,
                    name: tool_call.name,
                    input: tool_call.input.to_string(),
                }),
                tool_call_id: None,
                tool_name: None,
                tool_input_delta: None,
            },
            CoreStreamChunk::ToolCallDelta { id, name, input_delta } => Self {
                chunk_type: "tool_call_delta".to_string(),
                text: None,
                tool_call: None,
                tool_call_id: Some(id),
                tool_name: name,
                tool_input_delta: input_delta,
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

// ============================================================================
// Legacy Provider Aliases (for backwards compatibility)
// These are thin wrappers around LlmProvider for existing code
// ============================================================================

/// OpenAI provider (alias for LlmProvider("openai"))
#[napi]
pub struct OpenAIProvider {
    inner: LlmProvider,
}

#[napi]
impl OpenAIProvider {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: LlmProvider::new("openai".to_string()) }
    }

    #[napi(getter)]
    pub fn name(&self) -> String { self.inner.name() }

    #[napi]
    pub fn metadata(&self) -> ProviderMetadata { self.inner.metadata() }

    #[napi]
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderRequestConfig,
        options: Option<StreamChatOptions>,
        #[napi(ts_arg_type = "(err: Error | null, chunk: StreamChunk | null) => void")]
        callback: ThreadsafeFunction<StreamChunk>,
    ) -> Result<()> {
        self.inner.stream_chat(messages, config, options, callback).await
    }
}

/// Anthropic provider (alias for LlmProvider("anthropic"))
#[napi]
pub struct AnthropicProvider {
    inner: LlmProvider,
}

#[napi]
impl AnthropicProvider {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: LlmProvider::new("anthropic".to_string()) }
    }

    #[napi(getter)]
    pub fn name(&self) -> String { self.inner.name() }

    #[napi]
    pub fn metadata(&self) -> ProviderMetadata { self.inner.metadata() }

    #[napi]
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderRequestConfig,
        options: Option<StreamChatOptions>,
        #[napi(ts_arg_type = "(err: Error | null, chunk: StreamChunk | null) => void")]
        callback: ThreadsafeFunction<StreamChunk>,
    ) -> Result<()> {
        self.inner.stream_chat(messages, config, options, callback).await
    }
}

/// Gemini provider (alias for LlmProvider("gemini"))
#[napi]
pub struct GeminiProvider {
    inner: LlmProvider,
}

#[napi]
impl GeminiProvider {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: LlmProvider::new("gemini".to_string()) }
    }

    #[napi(getter)]
    pub fn name(&self) -> String { self.inner.name() }

    #[napi]
    pub fn metadata(&self) -> ProviderMetadata { self.inner.metadata() }

    #[napi]
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderRequestConfig,
        options: Option<StreamChatOptions>,
        #[napi(ts_arg_type = "(err: Error | null, chunk: StreamChunk | null) => void")]
        callback: ThreadsafeFunction<StreamChunk>,
    ) -> Result<()> {
        self.inner.stream_chat(messages, config, options, callback).await
    }
}

/// Ollama provider (alias for LlmProvider("ollama"))
#[napi]
pub struct OllamaProvider {
    inner: LlmProvider,
}

#[napi]
impl OllamaProvider {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: LlmProvider::new("ollama".to_string()) }
    }

    #[napi(getter)]
    pub fn name(&self) -> String { self.inner.name() }

    #[napi]
    pub fn metadata(&self) -> ProviderMetadata { self.inner.metadata() }

    #[napi]
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderRequestConfig,
        options: Option<StreamChatOptions>,
        #[napi(ts_arg_type = "(err: Error | null, chunk: StreamChunk | null) => void")]
        callback: ThreadsafeFunction<StreamChunk>,
    ) -> Result<()> {
        self.inner.stream_chat(messages, config, options, callback).await
    }
}

/// Mistral provider (alias for LlmProvider("mistral"))
#[napi]
pub struct MistralProvider {
    inner: LlmProvider,
}

#[napi]
impl MistralProvider {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: LlmProvider::new("mistral".to_string()) }
    }

    #[napi(getter)]
    pub fn name(&self) -> String { self.inner.name() }

    #[napi]
    pub fn metadata(&self) -> ProviderMetadata { self.inner.metadata() }

    #[napi]
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderRequestConfig,
        options: Option<StreamChatOptions>,
        #[napi(ts_arg_type = "(err: Error | null, chunk: StreamChunk | null) => void")]
        callback: ThreadsafeFunction<StreamChunk>,
    ) -> Result<()> {
        self.inner.stream_chat(messages, config, options, callback).await
    }
}

/// Azure OpenAI provider (alias for LlmProvider("azure"))
#[napi]
pub struct AzureOpenAIProvider {
    inner: LlmProvider,
}

#[napi]
impl AzureOpenAIProvider {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: LlmProvider::new("azure".to_string()) }
    }

    #[napi(getter)]
    pub fn name(&self) -> String { self.inner.name() }

    #[napi]
    pub fn metadata(&self) -> ProviderMetadata { self.inner.metadata() }

    #[napi]
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderRequestConfig,
        options: Option<StreamChatOptions>,
        #[napi(ts_arg_type = "(err: Error | null, chunk: StreamChunk | null) => void")]
        callback: ThreadsafeFunction<StreamChunk>,
    ) -> Result<()> {
        self.inner.stream_chat(messages, config, options, callback).await
    }
}

/// OpenRouter provider (alias for LlmProvider("openrouter"))
#[napi]
pub struct OpenRouterProvider {
    inner: LlmProvider,
}

#[napi]
impl OpenRouterProvider {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self { inner: LlmProvider::new("openrouter".to_string()) }
    }

    #[napi(getter)]
    pub fn name(&self) -> String { self.inner.name() }

    #[napi]
    pub fn metadata(&self) -> ProviderMetadata { self.inner.metadata() }

    #[napi]
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderRequestConfig,
        options: Option<StreamChatOptions>,
        #[napi(ts_arg_type = "(err: Error | null, chunk: StreamChunk | null) => void")]
        callback: ThreadsafeFunction<StreamChunk>,
    ) -> Result<()> {
        self.inner.stream_chat(messages, config, options, callback).await
    }
}

// ============================================================================
// Mock Provider (for testing)
// ============================================================================

/// Mock mode for testing
#[napi(string_enum)]
pub enum MockModeEnum {
    /// Echo back the last user message
    Echo,
    /// Return a fixed response (set via fixed_response)
    Fixed,
    /// Return nothing
    Empty,
    /// Return an error (set via error_message)
    Error,
}

/// Configuration for mock provider
#[napi(object)]
pub struct MockProviderConfig {
    /// Response mode
    pub mode: MockModeEnum,
    /// Delay between chunks in milliseconds
    pub chunk_delay_ms: Option<u32>,
    /// Size of each chunk
    pub chunk_size: Option<u32>,
    /// Fixed response (for Fixed mode)
    pub fixed_response: Option<String>,
    /// Error message (for Error mode)
    pub error_message: Option<String>,
    /// Custom chunks (for explicit chunk control)
    pub chunks: Option<Vec<String>>,
}

/// Mock provider for testing streaming without network calls
#[napi]
pub struct MockProvider {
    inner: CoreMockProvider,
}

#[napi]
impl MockProvider {
    /// Create a new mock provider with default echo mode
    #[napi(constructor)]
    pub fn new() -> Self {
        let logger = Arc::new(NoOpLogger::new());
        Self {
            inner: CoreMockProvider::echo(logger),
        }
    }

    /// Create with configuration
    #[napi(factory)]
    pub fn with_config(config: MockProviderConfig) -> Self {
        let logger: Arc<dyn Logger> = Arc::new(NoOpLogger::new());
        
        let mode = match config.mode {
            MockModeEnum::Echo => CoreMockMode::Echo,
            MockModeEnum::Fixed => {
                CoreMockMode::Fixed(config.fixed_response.unwrap_or_else(|| "Mock response".to_string()))
            }
            MockModeEnum::Empty => CoreMockMode::Empty,
            MockModeEnum::Error => CoreMockMode::Error {
                message: config.error_message.unwrap_or_else(|| "Mock error".to_string()),
                delay_chunks: 0,
            },
        };
        
        let core_config = CoreMockConfig {
            mode,
            chunk_delay_ms: config.chunk_delay_ms.unwrap_or(0) as u64,
            chunk_size: config.chunk_size.unwrap_or(10) as usize,
        };
        
        Self {
            inner: CoreMockProvider::with_config(core_config, logger),
        }
    }

    /// Create an echo provider
    #[napi(factory)]
    pub fn echo() -> Self {
        let logger = Arc::new(NoOpLogger::new());
        Self {
            inner: CoreMockProvider::echo(logger),
        }
    }

    /// Create a fixed response provider
    #[napi(factory)]
    pub fn fixed(response: String) -> Self {
        let logger = Arc::new(NoOpLogger::new());
        Self {
            inner: CoreMockProvider::fixed(response, logger),
        }
    }

    /// Create a chunked response provider
    #[napi(factory)]
    pub fn chunked(chunks: Vec<String>, delay_ms: u32) -> Self {
        let logger = Arc::new(NoOpLogger::new());
        Self {
            inner: CoreMockProvider::chunked(chunks, delay_ms as u64, logger),
        }
    }

    /// Create an error provider
    #[napi(factory)]
    pub fn error(message: String) -> Self {
        let logger = Arc::new(NoOpLogger::new());
        Self {
            inner: CoreMockProvider::error(message, logger),
        }
    }

    #[napi(getter)]
    pub fn name(&self) -> String {
        self.inner.name().to_string()
    }

    #[napi]
    pub fn metadata(&self) -> ProviderMetadata {
        self.inner.metadata().into()
    }

    #[napi]
    pub async fn stream_chat(
        &self,
        messages: Vec<ChatMessage>,
        config: ProviderRequestConfig,
        options: Option<StreamChatOptions>,
        #[napi(ts_arg_type = "(err: Error | null, chunk: StreamChunk | null) => void")]
        callback: ThreadsafeFunction<StreamChunk>,
    ) -> Result<()> {
        openllm_core::logging::info("napi", "MockProvider.stream_chat called");
        
        let core_messages = convert_messages_to_core(messages);
        let core_config = CoreProviderModelConfig {
            model: config.model,
            api_key: config.api_key,
            api_base: config.api_base,
        };
        let core_options = convert_options_to_core(options);
        let cancel_token = CoreCancellationToken::new();

        openllm_core::logging::info("napi", "MockProvider: calling inner.stream_chat");
        
        let stream_result = self.inner
            .stream_chat(core_messages, core_config, core_options, cancel_token)
            .await
            .map_err(|e| {
                openllm_core::logging::error("napi", &format!("MockProvider: stream_chat error: {}", e));
                Error::from_reason(e.to_string())
            })?;

        openllm_core::logging::info("napi", "MockProvider: got stream, iterating chunks");
        
        let mut stream = stream_result;
        let mut chunk_count = 0;
        while let Some(chunk_result) = stream.next().await {
            match chunk_result {
                Ok(chunk) => {
                    chunk_count += 1;
                    openllm_core::logging::debug("napi", &format!("MockProvider: chunk {}", chunk_count));
                    let js_chunk: StreamChunk = chunk.into();
                    callback.call(Ok(js_chunk), ThreadsafeFunctionCallMode::Blocking);
                }
                Err(e) => {
                    openllm_core::logging::error("napi", &format!("MockProvider: chunk error: {}", e));
                    callback.call(
                        Err(Error::from_reason(e.to_string())),
                        ThreadsafeFunctionCallMode::Blocking,
                    );
                    break;
                }
            }
        }

        openllm_core::logging::info("napi", &format!("MockProvider: stream complete, {} chunks", chunk_count));
        Ok(())
    }
}

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
// RPC Endpoint Registration
// ============================================================================

/// Configuration for registering an RPC endpoint
#[napi(object)]
pub struct RpcEndpointConfig {
    /// Name of the endpoint (e.g., "vscode")
    pub name: String,
    /// Path to the Unix socket or named pipe
    pub socket_path: String,
    /// Authentication token
    pub auth_token: String,
    /// Capabilities this endpoint supports (e.g., ["secrets", "config"])
    pub capabilities: Vec<String>,
}

/// Register an RPC endpoint for external secret/config access
/// 
/// This is called by VS Code or other IDEs to register their JSON-RPC server
/// so that openllm-core can access their secrets and config.
#[napi]
pub fn register_rpc_endpoint(config: RpcEndpointConfig) -> Result<()> {
    let endpoint = CoreRpcEndpoint::new(
        config.name,
        config.socket_path,
        config.auth_token,
        config.capabilities,
    );
    core_register_rpc_endpoint(endpoint);
    Ok(())
}

/// Unregister an RPC endpoint by name
#[napi]
pub fn unregister_rpc_endpoint(name: String) -> Result<bool> {
    use openllm_core::rpc::endpoint::unregister_rpc_endpoint;
    Ok(unregister_rpc_endpoint(&name).is_some())
}

/// List all registered RPC endpoints
#[napi]
pub fn list_rpc_endpoints() -> Vec<String> {
    use openllm_core::rpc::endpoint::list_rpc_endpoints;
    list_rpc_endpoints()
}

/// Check if an RPC endpoint is registered and reachable
#[napi]
pub fn is_rpc_endpoint_available(name: String) -> bool {
    if let Some(endpoint) = core_get_rpc_endpoint(&name) {
        let store = CoreRpcSecretStore::new(&endpoint);
        store.is_reachable()
    } else {
        false
    }
}

/// RPC-backed secret store for accessing secrets from external providers
#[napi]
pub struct RpcSecretStore {
    inner: Arc<CoreRpcSecretStore>,
}

#[napi]
impl RpcSecretStore {
    /// Create an RPC secret store from a registered endpoint
    #[napi(factory)]
    pub fn from_endpoint(endpoint_name: String) -> Result<Self> {
        let endpoint = core_get_rpc_endpoint(&endpoint_name)
            .ok_or_else(|| Error::from_reason(format!("Endpoint '{}' not registered", endpoint_name)))?;
        Ok(Self {
            inner: Arc::new(CoreRpcSecretStore::new(&endpoint)),
        })
    }

    #[napi(getter)]
    pub fn name(&self) -> String {
        self.inner.name().to_string()
    }

    #[napi]
    pub fn is_available(&self) -> bool {
        self.inner.is_reachable()
    }

    #[napi]
    pub async fn get(&self, key: String) -> Option<String> {
        self.inner.get(&key)
    }

    #[napi]
    pub async fn store(&self, key: String, value: String) -> Result<()> {
        self.inner.store(&key, &value).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn delete(&self, key: String) -> Result<()> {
        self.inner.delete(&key).map_err(|e| Error::from_reason(e.to_string()))
    }

    #[napi]
    pub async fn has(&self, key: String) -> bool {
        self.inner.has(&key)
    }

    #[napi]
    pub async fn get_info(&self, key: String) -> SecretInfo {
        self.inner.get_info(&key).into()
    }

    #[napi]
    pub fn list_keys(&self) -> Result<Vec<String>> {
        self.inner.list_keys().map_err(|e| Error::from_reason(e.to_string()))
    }
}

/// RPC config provider result
#[napi(object)]
pub struct RpcProviderConfig {
    pub name: String,
    pub enabled: bool,
    pub models: Vec<String>,
    pub api_base: Option<String>,
    pub source: String,
    pub source_detail: String,
}

/// RPC-backed config provider for accessing config from external providers
#[napi]
pub struct RpcConfigProvider {
    inner: CoreRpcConfigProvider,
}

#[napi]
impl RpcConfigProvider {
    /// Create an RPC config provider from a registered endpoint
    #[napi(factory)]
    pub fn from_endpoint(endpoint_name: String) -> Result<Self> {
        let endpoint = core_get_rpc_endpoint(&endpoint_name)
            .ok_or_else(|| Error::from_reason(format!("Endpoint '{}' not registered", endpoint_name)))?;
        Ok(Self {
            inner: CoreRpcConfigProvider::new(&endpoint),
        })
    }

    #[napi(getter)]
    pub fn name(&self) -> String {
        self.inner.name().to_string()
    }

    #[napi]
    pub fn is_available(&self) -> bool {
        self.inner.is_reachable()
    }

    #[napi]
    pub fn get_providers(&self, scope: String, workspace_path: Option<String>) -> Result<Vec<RpcProviderConfig>> {
        let path = workspace_path.map(std::path::PathBuf::from);
        let providers = self.inner.get_providers(&scope, path.as_deref())
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(providers.into_iter().map(|p| RpcProviderConfig {
            name: p.name,
            enabled: p.enabled,
            models: p.models,
            api_base: p.api_base,
            source: p.source,
            source_detail: p.source_detail,
        }).collect())
    }

    #[napi]
    pub fn get_provider(&self, provider: String, scope: String, workspace_path: Option<String>) -> Result<Option<RpcProviderConfig>> {
        let path = workspace_path.map(std::path::PathBuf::from);
        let provider_config = self.inner.get_provider(&provider, &scope, path.as_deref())
            .map_err(|e| Error::from_reason(e.to_string()))?;
        Ok(provider_config.map(|p| RpcProviderConfig {
            name: p.name,
            enabled: p.enabled,
            models: p.models,
            api_base: p.api_base,
            source: p.source,
            source_detail: p.source_detail,
        }))
    }

    #[napi]
    pub fn get_workspace_root(&self) -> Result<Option<String>> {
        self.inner.get_workspace_root()
            .map_err(|e| Error::from_reason(e.to_string()))
    }
}

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
