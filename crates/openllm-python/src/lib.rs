//! Python bindings for OpenLLM via PyO3

use pyo3::prelude::*;
use pyo3::exceptions::PyRuntimeError;
use std::sync::Arc;

use parking_lot::RwLock;
use once_cell::sync::Lazy;

use openllm_core::secrets::{
    SecretStore as CoreSecretStore,
    EnvSecretStore as CoreEnvSecretStore,
    MemorySecretStore as CoreMemorySecretStore,
    KeychainSecretStore as CoreKeychainSecretStore,
    ChainSecretStore as CoreChainSecretStore,
    list_secret_stores as core_list_secret_stores,
};
use openllm_core::config::{
    FileConfigProvider as CoreFileConfigProvider,
    MemoryConfigProvider as CoreMemoryConfigProvider,
    ConfigLevel as CoreConfigLevel,
    ConfigProvider as CoreConfigProvider,
};
use openllm_core::providers::{
    Provider,
    ProviderModelConfig as CoreProviderModelConfig,
    StreamChatOptions as CoreStreamChatOptions,
    create_provider as core_create_provider,
    supported_providers as core_supported_providers,
};
use openllm_core::types::{
    ProviderMetadata as CoreProviderMetadata, 
    ProviderConfig as CoreProviderConfig,
    ChatMessage as CoreChatMessage,
    MessageContent as CoreMessageContent,
    MessageRole as CoreMessageRole,
    CancellationToken as CoreCancellationToken,
    StreamChunk as CoreStreamChunk,
    DefaultModel as CoreDefaultModel,
};
use openllm_core::logging::{NoOpLogger, Logger};
use openllm_core::mcp::McpClient as CoreMcpClient;

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
static MCP_ENDPOINTS: Lazy<RwLock<Vec<McpEndpointInfo>>> = Lazy::new(|| RwLock::new(Vec::new()));

/// Global MCP client (lazily created when first needed)
static MCP_CLIENT: Lazy<RwLock<Option<Arc<CoreMcpClient>>>> = Lazy::new(|| RwLock::new(None));

/// MCP endpoint configuration for registration
#[pyclass]
#[derive(Clone)]
pub struct McpEndpoint {
    #[pyo3(get, set)]
    pub name: String,
    #[pyo3(get, set)]
    pub socket_path: String,
    #[pyo3(get, set)]
    pub http_url: Option<String>,
}

#[pymethods]
impl McpEndpoint {
    #[new]
    #[pyo3(signature = (name, socket_path, http_url=None))]
    pub fn new(name: String, socket_path: String, http_url: Option<String>) -> Self {
        Self { name, socket_path, http_url }
    }

    fn __repr__(&self) -> String {
        format!("McpEndpoint(name='{}', socket_path='{}')", self.name, self.socket_path)
    }
}

/// Register an MCP endpoint that the Rust core can connect to
/// 
/// This should be called by a host application after starting its MCP server,
/// so that the Rust ToolRegistry can discover and execute tools.
/// 
/// ## Example
/// ```python
/// import openllm
/// 
/// # Register the MCP endpoint
/// openllm.register_mcp_endpoint(openllm.McpEndpoint(
///     name="my-app",
///     socket_path="/tmp/my-app-mcp.sock",
/// ))
/// 
/// # Now create a ToolRegistry that will connect to this endpoint
/// registry = openllm.ToolRegistry()
/// registry.connect_to_mcp()
/// registry.refresh()
/// print(f"Found {registry.tool_count} tools")
/// ```
#[pyfunction]
pub fn register_mcp_endpoint(endpoint: McpEndpoint) -> PyResult<()> {
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
#[pyfunction]
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
#[pyfunction]
pub fn has_mcp_endpoint(name: String) -> bool {
    MCP_ENDPOINTS.read().iter().any(|e| e.name == name)
}

/// Get the socket path for a registered MCP endpoint
#[pyfunction]
pub fn get_mcp_socket_path(name: String) -> Option<String> {
    MCP_ENDPOINTS.read()
        .iter()
        .find(|e| e.name == name)
        .map(|e| e.socket_path.clone())
}

/// Get the socket path for the first registered MCP endpoint
fn get_first_mcp_socket_path() -> PyResult<String> {
    let endpoints = MCP_ENDPOINTS.read();
    endpoints.first()
        .map(|e| e.socket_path.clone())
        .ok_or_else(|| PyRuntimeError::new_err("No MCP endpoint registered. Call register_mcp_endpoint() first."))
}

/// Get or create the global MCP client (async version)
async fn get_or_create_mcp_client_async() -> PyResult<Arc<CoreMcpClient>> {
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
        .map_err(|e| PyRuntimeError::new_err(format!("Failed to connect to MCP server: {}", e)))?;
    
    #[cfg(windows)]
    let client = CoreMcpClient::connect_named_pipe(&socket_path, logger)
        .await
        .map_err(|e| PyRuntimeError::new_err(format!("Failed to connect to MCP server: {}", e)))?;
    
    let client = Arc::new(client);
    
    // Store it
    {
        let mut stored = MCP_CLIENT.write();
        *stored = Some(client.clone());
    }
    
    Ok(client)
}

// ============================================================================
// Tool Registry
// ============================================================================

/// Tool registry for managing available tools from MCP servers
/// 
/// The registry connects to registered MCP endpoints to discover and execute tools.
/// Call `register_mcp_endpoint()` before creating a ToolRegistry to enable tool discovery.
#[pyclass]
pub struct ToolRegistry {
    inner: Arc<openllm_core::ToolRegistry>,
}

#[pymethods]
impl ToolRegistry {
    /// Create a new tool registry
    #[new]
    pub fn new() -> Self {
        let logger: Arc<dyn Logger> = Arc::new(NoOpLogger);
        Self {
            inner: Arc::new(openllm_core::ToolRegistry::new(logger)),
        }
    }

    /// Connect to a registered MCP endpoint for tool discovery and execution
    pub fn connect_to_mcp(&self, py: Python<'_>) -> PyResult<()> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        
        let inner = self.inner.clone();
        py.allow_threads(|| {
            rt.block_on(async {
                let client = get_or_create_mcp_client_async().await?;
                inner.set_client(client);
                Ok(())
            })
        })
    }

    /// Refresh the tool list from all MCP sources
    pub fn refresh(&self) -> PyResult<()> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        rt.block_on(async {
            self.inner.refresh().await
        }).map_err(|e| PyRuntimeError::new_err(e))
    }

    /// Get count of available tools
    #[getter]
    pub fn tool_count(&self) -> u32 {
        self.inner.tool_count() as u32
    }

    /// Get count of enabled, user-visible tools
    #[getter]
    pub fn enabled_tool_count(&self) -> u32 {
        self.inner.enabled_tool_count() as u32
    }

    /// Enable or disable a tool by name
    pub fn set_tool_enabled(&self, name: String, enabled: bool) {
        self.inner.set_tool_enabled(&name, enabled);
    }

    fn __repr__(&self) -> String {
        format!("ToolRegistry(tool_count={}, enabled_count={})", 
                self.inner.tool_count(), self.inner.enabled_tool_count())
    }
}

// ============================================================================
// Secret Store Types (existing)
// ============================================================================

#[pyclass]
#[derive(Clone)]
pub struct SecretInfo {
    #[pyo3(get)]
    pub available: bool,
    #[pyo3(get)]
    pub source: String,
}

#[pymethods]
impl SecretInfo {
    fn __repr__(&self) -> String {
        format!("SecretInfo(available={}, source='{}')", self.available, self.source)
    }
}

impl From<openllm_core::SecretInfo> for SecretInfo {
    fn from(info: openllm_core::SecretInfo) -> Self {
        Self { available: info.available, source: info.source }
    }
}

#[pyclass]
#[derive(Clone)]
pub struct StoreInfo {
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub description: String,
    #[pyo3(get)]
    pub is_plugin: bool,
}

#[pymethods]
impl StoreInfo {
    fn __repr__(&self) -> String {
        format!("StoreInfo(name='{}', description='{}', is_plugin={})", 
                self.name, self.description, self.is_plugin)
    }
}

// ============================================================================
// EnvSecretStore
// ============================================================================

#[pyclass]
pub struct EnvSecretStore {
    inner: Arc<CoreEnvSecretStore>,
}

#[pymethods]
impl EnvSecretStore {
    #[new]
    pub fn new() -> Self {
        Self { inner: Arc::new(CoreEnvSecretStore::new()) }
    }

    #[getter]
    pub fn name(&self) -> String { self.inner.name().to_string() }

    pub fn is_available(&self) -> bool { self.inner.is_available() }

    pub fn get(&self, key: &str) -> Option<String> { self.inner.get(key) }

    pub fn store(&self, key: &str, value: &str) -> PyResult<()> {
        self.inner.store(key, value).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn delete(&self, key: &str) -> PyResult<()> {
        self.inner.delete(key).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn has(&self, key: &str) -> bool { self.inner.has(key) }

    pub fn get_info(&self, key: &str) -> SecretInfo { self.inner.get_info(key).into() }

    fn __repr__(&self) -> String { format!("EnvSecretStore(name='{}')", self.inner.name()) }
}

// ============================================================================
// MemorySecretStore
// ============================================================================

#[pyclass]
pub struct MemorySecretStore {
    inner: Arc<CoreMemorySecretStore>,
}

#[pymethods]
impl MemorySecretStore {
    #[new]
    pub fn new() -> Self {
        Self { inner: Arc::new(CoreMemorySecretStore::new()) }
    }

    #[getter]
    pub fn name(&self) -> String { self.inner.name().to_string() }

    pub fn is_available(&self) -> bool { self.inner.is_available() }

    pub fn get(&self, key: &str) -> Option<String> { self.inner.get(key) }

    pub fn store(&self, key: &str, value: &str) -> PyResult<()> {
        self.inner.store(key, value).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn delete(&self, key: &str) -> PyResult<()> {
        self.inner.delete(key).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn has(&self, key: &str) -> bool { self.inner.has(key) }

    pub fn get_info(&self, key: &str) -> SecretInfo { self.inner.get_info(key).into() }

    pub fn clear(&self) { self.inner.clear(); }

    pub fn __len__(&self) -> usize { self.inner.len() }

    pub fn is_empty(&self) -> bool { self.inner.is_empty() }

    fn __repr__(&self) -> String {
        format!("MemorySecretStore(name='{}', len={})", self.inner.name(), self.inner.len())
    }
}

// ============================================================================
// KeychainSecretStore
// ============================================================================

/// System keychain secret store (macOS Keychain, Windows Credential Manager, Linux Secret Service)
#[pyclass]
pub struct KeychainSecretStore {
    inner: Arc<CoreKeychainSecretStore>,
}

#[pymethods]
impl KeychainSecretStore {
    #[new]
    #[pyo3(signature = (service=None))]
    pub fn new(service: Option<&str>) -> Self {
        let store = match service {
            Some(s) => CoreKeychainSecretStore::with_service(s),
            None => CoreKeychainSecretStore::new(),
        };
        Self { inner: Arc::new(store) }
    }

    #[getter]
    pub fn name(&self) -> String { self.inner.name().to_string() }

    pub fn is_available(&self) -> bool { self.inner.is_available() }

    pub fn get(&self, key: &str) -> Option<String> { self.inner.get(key) }

    pub fn store(&self, key: &str, value: &str) -> PyResult<()> {
        self.inner.store(key, value).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn delete(&self, key: &str) -> PyResult<()> {
        self.inner.delete(key).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn has(&self, key: &str) -> bool { self.inner.has(key) }

    pub fn get_info(&self, key: &str) -> SecretInfo { self.inner.get_info(key).into() }

    fn __repr__(&self) -> String {
        format!("KeychainSecretStore(name='{}')", self.inner.name())
    }
}

// ============================================================================
// ChainSecretStore
// ============================================================================

/// Chain of secret stores with fallback
#[pyclass]
pub struct ChainSecretStore {
    inner: Arc<CoreChainSecretStore>,
}

#[pymethods]
impl ChainSecretStore {
    #[new]
    pub fn new(stores: Vec<PyObject>, py: Python<'_>) -> PyResult<Self> {
        let mut core_stores: Vec<Arc<dyn CoreSecretStore>> = Vec::new();
        
        for store in stores {
            // Try to extract each store type
            if let Ok(env) = store.extract::<PyRef<EnvSecretStore>>(py) {
                core_stores.push(env.inner.clone());
            } else if let Ok(mem) = store.extract::<PyRef<MemorySecretStore>>(py) {
                core_stores.push(mem.inner.clone());
            } else if let Ok(kc) = store.extract::<PyRef<KeychainSecretStore>>(py) {
                core_stores.push(kc.inner.clone());
            } else {
                return Err(PyRuntimeError::new_err("Unknown store type in chain"));
            }
        }
        
        Ok(Self { inner: Arc::new(CoreChainSecretStore::new(core_stores)) })
    }

    #[getter]
    pub fn name(&self) -> String { self.inner.name().to_string() }

    pub fn is_available(&self) -> bool { self.inner.is_available() }

    pub fn get(&self, key: &str) -> Option<String> { self.inner.get(key) }

    pub fn store(&self, key: &str, value: &str) -> PyResult<()> {
        self.inner.store(key, value).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn delete(&self, key: &str) -> PyResult<()> {
        self.inner.delete(key).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn has(&self, key: &str) -> bool { self.inner.has(key) }

    pub fn get_info(&self, key: &str) -> SecretInfo { self.inner.get_info(key).into() }

    fn __repr__(&self) -> String {
        format!("ChainSecretStore(name='{}')", self.inner.name())
    }
}

// ============================================================================
// Config Types
// ============================================================================

/// Config level enum
#[pyclass(eq, eq_int)]
#[derive(Clone, Debug, PartialEq)]
pub enum ConfigLevel {
    User,
    Workspace,
}

#[pymethods]
impl ConfigLevel {
    fn __repr__(&self) -> String {
        match self {
            ConfigLevel::User => "ConfigLevel.User".to_string(),
            ConfigLevel::Workspace => "ConfigLevel.Workspace".to_string(),
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

impl From<ConfigLevel> for CoreConfigLevel {
    fn from(level: ConfigLevel) -> Self {
        match level {
            ConfigLevel::User => CoreConfigLevel::User,
            ConfigLevel::Workspace => CoreConfigLevel::Workspace,
        }
    }
}

/// Provider configuration
#[pyclass]
#[derive(Clone)]
pub struct ProviderConfig {
    #[pyo3(get, set)]
    pub name: String,
    #[pyo3(get, set)]
    pub enabled: bool,
    #[pyo3(get, set)]
    pub api_base: Option<String>,
    #[pyo3(get, set)]
    pub models: Vec<String>,
}

#[pymethods]
impl ProviderConfig {
    #[new]
    #[pyo3(signature = (name, enabled=true, api_base=None, models=None))]
    pub fn new(
        name: String,
        enabled: bool,
        api_base: Option<String>,
        models: Option<Vec<String>>,
    ) -> Self {
        Self {
            name,
            enabled,
            api_base,
            models: models.unwrap_or_default(),
        }
    }

    fn __repr__(&self) -> String {
        format!(
            "ProviderConfig(name='{}', enabled={}, models={})",
            self.name, self.enabled, self.models.len()
        )
    }
}

impl From<CoreProviderConfig> for ProviderConfig {
    fn from(config: CoreProviderConfig) -> Self {
        Self {
            name: config.name,
            enabled: config.enabled,
            api_base: config.api_base,
            models: config.models,
        }
    }
}

impl From<ProviderConfig> for CoreProviderConfig {
    fn from(config: ProviderConfig) -> Self {
        CoreProviderConfig {
            name: config.name,
            enabled: config.enabled,
            api_base: config.api_base,
            models: config.models,
            source: openllm_core::types::ConfigSource::Runtime,
        }
    }
}

/// File-based configuration provider (YAML)
#[pyclass]
pub struct FileConfigProvider {
    inner: Arc<CoreFileConfigProvider>,
}

#[pymethods]
impl FileConfigProvider {
    #[new]
    #[pyo3(signature = (path=None, level=ConfigLevel::User, workspace_root=None))]
    pub fn new(path: Option<String>, level: ConfigLevel, workspace_root: Option<String>) -> Self {
        let provider = if let Some(p) = path {
            CoreFileConfigProvider::new(p, level.into())
        } else if level == ConfigLevel::Workspace {
            let root = workspace_root.unwrap_or_else(|| ".".to_string());
            CoreFileConfigProvider::workspace(root)
        } else {
            CoreFileConfigProvider::user()
        };
        Self { inner: Arc::new(provider) }
    }

    #[staticmethod]
    pub fn user() -> Self {
        Self { inner: Arc::new(CoreFileConfigProvider::user()) }
    }

    #[staticmethod]
    pub fn workspace(workspace_root: String) -> Self {
        Self { inner: Arc::new(CoreFileConfigProvider::workspace(workspace_root)) }
    }

    #[getter]
    pub fn path(&self) -> String {
        self.inner.path().to_string_lossy().to_string()
    }

    #[getter]
    pub fn level(&self) -> ConfigLevel {
        self.inner.level().into()
    }

    pub fn exists(&self) -> bool {
        self.inner.exists()
    }

    pub fn get_providers(&self) -> PyResult<Vec<ProviderConfig>> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        let result = rt.block_on(async {
            self.inner.get_providers().await
        });
        Ok(result.into_iter().map(|p| p.into()).collect())
    }

    pub fn add_provider(&self, config: ProviderConfig) -> PyResult<()> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        rt.block_on(async {
            self.inner.add_provider(config.into()).await
        }).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn update_provider(&self, name: String, config: ProviderConfig) -> PyResult<()> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        rt.block_on(async {
            self.inner.update_provider(&name, config.into()).await
        }).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn remove_provider(&self, name: String) -> PyResult<()> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        rt.block_on(async {
            self.inner.remove_provider(&name).await
        }).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn reload(&self) -> PyResult<()> {
        self.inner.reload()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        Ok(())
    }

    pub fn backup(&self) -> PyResult<Option<String>> {
        let backup_path = self.inner.backup()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        Ok(backup_path.map(|p| p.to_string_lossy().to_string()))
    }

    pub fn export_json(&self) -> PyResult<String> {
        self.inner.export_json()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn import_json(&self, json: String) -> PyResult<()> {
        self.inner.import_json(&json)
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn import_providers(&self, providers: Vec<ProviderConfig>) -> PyResult<()> {
        let core_providers: Vec<CoreProviderConfig> = providers.into_iter().map(|p| p.into()).collect();
        self.inner.import_providers(core_providers)
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    fn __repr__(&self) -> String {
        format!(
            "FileConfigProvider(level={:?}, path='{}', exists={})",
            self.level(),
            self.path(),
            self.exists()
        )
    }
}

// ============================================================================
// MemoryConfigProvider
// ============================================================================

/// In-memory configuration provider (for testing)
#[pyclass]
pub struct MemoryConfigProvider {
    inner: Arc<CoreMemoryConfigProvider>,
}

#[pymethods]
impl MemoryConfigProvider {
    #[new]
    pub fn new() -> Self {
        Self { inner: Arc::new(CoreMemoryConfigProvider::new()) }
    }

    pub fn get_providers(&self) -> PyResult<Vec<ProviderConfig>> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        let result = rt.block_on(async {
            self.inner.get_providers().await
        });
        Ok(result.into_iter().map(|p| p.into()).collect())
    }

    pub fn add_provider(&self, config: ProviderConfig) -> PyResult<()> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        rt.block_on(async {
            self.inner.add_provider(config.into()).await
        }).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn update_provider(&self, name: String, config: ProviderConfig) -> PyResult<()> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        rt.block_on(async {
            self.inner.update_provider(&name, config.into()).await
        }).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn remove_provider(&self, name: String) -> PyResult<()> {
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        rt.block_on(async {
            self.inner.remove_provider(&name).await
        }).map_err(|e| PyRuntimeError::new_err(e.to_string()))
    }

    pub fn clear(&self) {
        self.inner.clear();
    }

    fn __repr__(&self) -> String {
        "MemoryConfigProvider()".to_string()
    }
}

// ============================================================================
// Chat Message Types
// ============================================================================

/// Message role enum
#[pyclass(eq, eq_int)]
#[derive(Clone, Debug, PartialEq)]
pub enum MessageRole {
    System,
    User,
    Assistant,
}

#[pymethods]
impl MessageRole {
    fn __repr__(&self) -> String {
        match self {
            MessageRole::System => "MessageRole.System".to_string(),
            MessageRole::User => "MessageRole.User".to_string(),
            MessageRole::Assistant => "MessageRole.Assistant".to_string(),
        }
    }
}

/// Chat message
#[pyclass]
#[derive(Clone)]
pub struct ChatMessage {
    #[pyo3(get)]
    pub role: MessageRole,
    #[pyo3(get)]
    pub content: String,
}

#[pymethods]
impl ChatMessage {
    #[new]
    pub fn new(role: MessageRole, content: String) -> Self {
        Self { role, content }
    }

    #[staticmethod]
    pub fn system(content: String) -> Self {
        Self { role: MessageRole::System, content }
    }

    #[staticmethod]
    pub fn user(content: String) -> Self {
        Self { role: MessageRole::User, content }
    }

    #[staticmethod]
    pub fn assistant(content: String) -> Self {
        Self { role: MessageRole::Assistant, content }
    }

    fn __repr__(&self) -> String {
        format!("ChatMessage(role={:?}, content='{}')", self.role, 
                if self.content.len() > 50 { format!("{}...", &self.content[..50]) } else { self.content.clone() })
    }
}


// ============================================================================
// Tool Types
// ============================================================================

/// Tool definition
#[pyclass]
#[derive(Clone)]
pub struct Tool {
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub description: String,
    #[pyo3(get)]
    pub input_schema: Option<String>,
}

#[pymethods]
impl Tool {
    #[new]
    pub fn new(name: String, description: String, input_schema: Option<String>) -> Self {
        Self { name, description, input_schema }
    }

    fn __repr__(&self) -> String {
        format!("Tool(name='{}', description='{}')", self.name, self.description)
    }
}

/// Tool call from LLM
#[pyclass]
#[derive(Clone)]
pub struct ToolCall {
    #[pyo3(get)]
    pub id: String,
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub input: String,  // JSON string
}

#[pymethods]
impl ToolCall {
    #[new]
    pub fn new(id: String, name: String, input: String) -> Self {
        Self { id, name, input }
    }

    fn __repr__(&self) -> String {
        format!("ToolCall(id='{}', name='{}', input='{}')", self.id, self.name, self.input)
    }
}

/// Tool result
#[pyclass]
#[derive(Clone)]
pub struct ToolResult {
    #[pyo3(get)]
    pub call_id: String,
    #[pyo3(get)]
    pub content: String,
    #[pyo3(get)]
    pub is_error: bool,
}

#[pymethods]
impl ToolResult {
    #[new]
    #[pyo3(signature = (call_id, content, is_error=false))]
    pub fn new(call_id: String, content: String, is_error: bool) -> Self {
        Self { call_id, content, is_error }
    }

    #[staticmethod]
    pub fn success(call_id: String, content: String) -> Self {
        Self { call_id, content, is_error: false }
    }

    #[staticmethod]
    pub fn error(call_id: String, content: String) -> Self {
        Self { call_id, content, is_error: true }
    }

    fn __repr__(&self) -> String {
        format!("ToolResult(call_id='{}', is_error={})", self.call_id, self.is_error)
    }
}

// ============================================================================
// Model Configuration
// ============================================================================

/// Model capabilities
#[pyclass]
#[derive(Clone)]
pub struct ModelCapabilities {
    #[pyo3(get)]
    pub image_input: bool,
    #[pyo3(get)]
    pub tool_calling: bool,
    #[pyo3(get)]
    pub streaming: bool,
}

#[pymethods]
impl ModelCapabilities {
    #[new]
    #[pyo3(signature = (image_input=false, tool_calling=false, streaming=true))]
    pub fn new(image_input: bool, tool_calling: bool, streaming: bool) -> Self {
        Self { image_input, tool_calling, streaming }
    }

    #[staticmethod]
    pub fn full() -> Self {
        Self { image_input: true, tool_calling: true, streaming: true }
    }

    fn __repr__(&self) -> String {
        format!("ModelCapabilities(image={}, tools={}, streaming={})", 
                self.image_input, self.tool_calling, self.streaming)
    }
}

/// Model configuration
#[pyclass]
#[derive(Clone)]
pub struct ModelConfig {
    #[pyo3(get, set)]
    pub id: String,
    #[pyo3(get, set)]
    pub name: String,
    #[pyo3(get, set)]
    pub provider: String,
    #[pyo3(get, set)]
    pub model: String,
    #[pyo3(get, set)]
    pub api_key: Option<String>,
    #[pyo3(get, set)]
    pub api_base: Option<String>,
    #[pyo3(get, set)]
    pub context_length: Option<u32>,
}

#[pymethods]
impl ModelConfig {
    #[new]
    #[pyo3(signature = (id, provider, model, api_key=None, api_base=None, context_length=None))]
    pub fn new(
        id: String,
        provider: String,
        model: String,
        api_key: Option<String>,
        api_base: Option<String>,
        context_length: Option<u32>,
    ) -> Self {
        Self {
            name: model.clone(),
            id, provider, model, api_key, api_base, context_length,
        }
    }

    fn __repr__(&self) -> String {
        format!("ModelConfig(id='{}', provider='{}', model='{}')", self.id, self.provider, self.model)
    }
}

// ============================================================================
// Provider Metadata
// ============================================================================

/// Provider metadata
#[pyclass]
#[derive(Clone)]
pub struct ProviderMetadata {
    #[pyo3(get)]
    pub id: String,
    #[pyo3(get)]
    pub display_name: String,
    #[pyo3(get)]
    pub default_api_base: String,
    #[pyo3(get)]
    pub requires_api_key: bool,
}

#[pymethods]
impl ProviderMetadata {
    fn __repr__(&self) -> String {
        format!("ProviderMetadata(id='{}', display_name='{}')", self.id, self.display_name)
    }
}

impl From<CoreProviderMetadata> for ProviderMetadata {
    fn from(m: CoreProviderMetadata) -> Self {
        Self {
            id: m.id,
            display_name: m.display_name,
            default_api_base: m.default_api_base,
            requires_api_key: m.requires_api_key,
        }
    }
}

// ============================================================================
// Default Model (for provider metadata)
// ============================================================================

/// Default model definition
#[pyclass]
#[derive(Clone)]
pub struct DefaultModel {
    #[pyo3(get)]
    pub id: String,
    #[pyo3(get)]
    pub name: String,
    #[pyo3(get)]
    pub context_length: u32,
    #[pyo3(get)]
    pub capabilities: ModelCapabilities,
}

#[pymethods]
impl DefaultModel {
    fn __repr__(&self) -> String {
        format!("DefaultModel(id='{}', name='{}')", self.id, self.name)
    }
}

impl From<CoreDefaultModel> for DefaultModel {
    fn from(m: CoreDefaultModel) -> Self {
        Self {
            id: m.id,
            name: m.name,
            context_length: m.context_length,
            capabilities: ModelCapabilities {
                image_input: m.capabilities.image_input,
                tool_calling: m.capabilities.tool_calling,
                streaming: m.capabilities.streaming,
            },
        }
    }
}

// ============================================================================
// Stream Chunk Types
// ============================================================================

/// Option for a user prompt
#[pyclass]
#[derive(Clone)]
pub struct PromptOption {
    #[pyo3(get)]
    pub id: String,
    #[pyo3(get)]
    pub label: String,
    #[pyo3(get)]
    pub is_default: bool,
}

#[pymethods]
impl PromptOption {
    #[new]
    #[pyo3(signature = (id, label, is_default=false))]
    pub fn new(id: String, label: String, is_default: bool) -> Self {
        Self { id, label, is_default }
    }

    fn __repr__(&self) -> String {
        format!("PromptOption(id='{}', label='{}', is_default={})", self.id, self.label, self.is_default)
    }
}

/// Stream chunk from LLM response or orchestration event
/// 
/// Chunk types:
/// - "text": Text content from LLM
/// - "tool_call": Complete tool call from LLM
/// - "tool_call_delta": Partial tool call (for streaming)
/// - "tool_executing": Tool is about to be executed
/// - "tool_result": Tool execution completed
/// - "orchestration_status": Status of the orchestration loop
/// - "user_prompt": Request user input/approval
/// - "done": Stream completed
/// - "error": Error occurred
#[pyclass]
#[derive(Clone)]
pub struct StreamChunk {
    #[pyo3(get)]
    pub chunk_type: String,
    
    // Text chunk fields
    #[pyo3(get)]
    pub text: Option<String>,
    
    // Tool fields
    #[pyo3(get)]
    pub tool_id: Option<String>,
    #[pyo3(get)]
    pub tool_name: Option<String>,
    #[pyo3(get)]
    pub tool_arguments: Option<String>,
    #[pyo3(get)]
    pub tool_result: Option<String>,
    #[pyo3(get)]
    pub is_error: Option<bool>,
    
    // Orchestration status fields
    #[pyo3(get)]
    pub iteration: Option<u32>,
    #[pyo3(get)]
    pub max_iterations: Option<u32>,
    
    // User prompt fields
    #[pyo3(get)]
    pub prompt_id: Option<String>,
    #[pyo3(get)]
    pub prompt_type: Option<String>,
    #[pyo3(get)]
    pub title: Option<String>,
    #[pyo3(get)]
    pub message: Option<String>,
    #[pyo3(get)]
    pub options: Option<Vec<PromptOption>>,
    #[pyo3(get)]
    pub context: Option<String>,
    
    // Done chunk fields
    #[pyo3(get)]
    pub summary: Option<String>,
    
    // Error chunk fields
    #[pyo3(get)]
    pub recoverable: Option<bool>,
}

#[pymethods]
impl StreamChunk {
    fn __repr__(&self) -> String {
        match self.chunk_type.as_str() {
            "text" => format!("StreamChunk(type='text', text='{}')", 
                self.text.as_deref().map(|t| if t.len() > 30 { format!("{}...", &t[..30]) } else { t.to_string() }).unwrap_or_default()),
            "tool_call" => format!("StreamChunk(type='tool_call', name='{}')", 
                self.tool_name.as_deref().unwrap_or("")),
            "tool_executing" => format!("StreamChunk(type='tool_executing', name='{}')", 
                self.tool_name.as_deref().unwrap_or("")),
            "tool_result" => format!("StreamChunk(type='tool_result', name='{}', is_error={})", 
                self.tool_name.as_deref().unwrap_or(""), self.is_error.unwrap_or(false)),
            "user_prompt" => format!("StreamChunk(type='user_prompt', title='{}')", 
                self.title.as_deref().unwrap_or("")),
            "done" => "StreamChunk(type='done')".to_string(),
            "error" => format!("StreamChunk(type='error', message='{}')", 
                self.message.as_deref().unwrap_or("")),
            _ => format!("StreamChunk(type='{}')", self.chunk_type),
        }
    }
}

impl From<CoreStreamChunk> for StreamChunk {
    fn from(chunk: CoreStreamChunk) -> Self {
        let default = StreamChunk {
            chunk_type: String::new(),
            text: None,
            tool_id: None,
            tool_name: None,
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
            CoreStreamChunk::Text { text } => StreamChunk {
                chunk_type: "text".to_string(),
                text: Some(text),
                ..default
            },
            CoreStreamChunk::ToolCall { tool_call } => StreamChunk {
                chunk_type: "tool_call".to_string(),
                tool_id: Some(tool_call.id),
                tool_name: Some(tool_call.name),
                tool_arguments: Some(tool_call.input.to_string()),
                ..default
            },
            CoreStreamChunk::ToolCallDelta { id, name, input_delta } => StreamChunk {
                chunk_type: "tool_call_delta".to_string(),
                tool_id: Some(id),
                tool_name: name,
                tool_arguments: input_delta,
                ..default
            },
            CoreStreamChunk::ToolExecuting { id, name, arguments } => StreamChunk {
                chunk_type: "tool_executing".to_string(),
                tool_id: Some(id),
                tool_name: Some(name),
                tool_arguments: Some(arguments),
                ..default
            },
            CoreStreamChunk::ToolResult { id, name, result, is_error } => StreamChunk {
                chunk_type: "tool_result".to_string(),
                tool_id: Some(id),
                tool_name: Some(name),
                tool_result: Some(result),
                is_error: Some(is_error),
                ..default
            },
            CoreStreamChunk::OrchestrationStatus { iteration, max_iterations, message } => StreamChunk {
                chunk_type: "orchestration_status".to_string(),
                iteration: Some(iteration),
                max_iterations: Some(max_iterations),
                message: Some(message),
                ..default
            },
            CoreStreamChunk::UserPrompt { prompt_id, prompt_type, title, message, options, context } => StreamChunk {
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
            CoreStreamChunk::Done { summary } => StreamChunk {
                chunk_type: "done".to_string(),
                summary,
                ..default
            },
            CoreStreamChunk::Error { message, recoverable } => StreamChunk {
                chunk_type: "error".to_string(),
                message: Some(message),
                recoverable: Some(recoverable),
                ..default
            },
        }
    }
}

// ============================================================================
// Provider Request Config
// ============================================================================

/// Configuration for a provider request
#[pyclass]
#[derive(Clone)]
pub struct ProviderRequestConfig {
    #[pyo3(get, set)]
    pub model: String,
    #[pyo3(get, set)]
    pub api_key: Option<String>,
    #[pyo3(get, set)]
    pub api_base: Option<String>,
}

#[pymethods]
impl ProviderRequestConfig {
    #[new]
    #[pyo3(signature = (model, api_key=None, api_base=None))]
    pub fn new(model: String, api_key: Option<String>, api_base: Option<String>) -> Self {
        Self { model, api_key, api_base }
    }

    fn __repr__(&self) -> String {
        format!("ProviderRequestConfig(model='{}')", self.model)
    }
}

/// Stream chat options
#[pyclass]
#[derive(Clone)]
pub struct StreamChatOptions {
    #[pyo3(get, set)]
    pub temperature: Option<f64>,
    #[pyo3(get, set)]
    pub max_tokens: Option<u32>,
    #[pyo3(get, set)]
    pub stop: Option<Vec<String>>,
}

#[pymethods]
impl StreamChatOptions {
    #[new]
    #[pyo3(signature = (temperature=None, max_tokens=None, stop=None))]
    pub fn new(
        temperature: Option<f64>,
        max_tokens: Option<u32>,
        stop: Option<Vec<String>>,
    ) -> Self {
        Self { temperature, max_tokens, stop }
    }

    fn __repr__(&self) -> String {
        format!("StreamChatOptions(temperature={:?})", self.temperature)
    }
}

// ============================================================================
// Unified LLM Provider
// ============================================================================

/// Unified LLM provider that supports all providers
/// 
/// Supported providers: openai, anthropic, gemini, ollama, groq, xai, deepseek,
/// cohere, fireworks, together, azure, openrouter, mistral, redhat, mock
/// 
/// For mock provider, the model parameter configures the behavior:
/// - "echo" or "mock-echo": Echoes back the user's message
/// - "fixed" or "fixed:response text": Returns a fixed response
/// - "error" or "error:message": Simulates an error
/// - "empty": Returns an empty response
#[pyclass]
pub struct LlmProvider {
    inner: Box<dyn Provider>,
    provider_id: String,
}

#[pymethods]
impl LlmProvider {
    /// Create a new provider for the given provider ID
    #[new]
    pub fn new(provider_id: String) -> Self {
        let logger: Arc<dyn Logger> = Arc::new(NoOpLogger::new());
        let inner = core_create_provider(&provider_id, logger);
        Self { inner, provider_id }
    }

    /// Get the provider ID
    #[getter]
    pub fn provider_id(&self) -> String {
        self.provider_id.clone()
    }

    /// Get provider metadata
    pub fn metadata(&self) -> ProviderMetadata {
        self.inner.metadata().into()
    }

    /// Get provider's default models
    pub fn default_models(&self) -> Vec<DefaultModel> {
        self.inner.metadata().default_models.into_iter().map(|m| m.into()).collect()
    }

    /// Stream chat with the provider
    /// 
    /// Returns a list of StreamChunk objects
    pub fn stream_chat(
        &self,
        py: Python<'_>,
        messages: Vec<ChatMessage>,
        config: ProviderRequestConfig,
        options: Option<StreamChatOptions>,
    ) -> PyResult<Vec<StreamChunk>> {
        let core_messages = convert_messages_to_core(messages);
        let core_config = CoreProviderModelConfig {
            model: config.model,
            api_key: config.api_key,
            api_base: config.api_base,
        };
        let core_options = convert_options_to_core(options);
        let cancel_token = CoreCancellationToken::new();

        // Run the async operation
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;

        let result: Result<Vec<StreamChunk>, String> = py.allow_threads(|| {
            rt.block_on(async {
                use futures::StreamExt as _;
                
                let stream_result = self.inner
                    .stream_chat(core_messages, core_config, core_options, cancel_token)
                    .await
                    .map_err(|e| e.to_string())?;

                let mut chunks: Vec<StreamChunk> = Vec::new();
                let mut stream = stream_result;
                while let Some(chunk_result) = stream.next().await {
                    match chunk_result {
                        Ok(chunk) => {
                            let py_chunk: StreamChunk = chunk.into();
                            chunks.push(py_chunk);
                        }
                        Err(e) => return Err(e.to_string()),
                    }
                }
                Ok(chunks)
            })
        });

        result.map_err(|e| PyRuntimeError::new_err(e))
    }

    // Note: For real-time streaming with callbacks, Python users should use
    // the stream_chat method and iterate over chunks, or use async Python
    // libraries. PyO3 callback handling with async Rust is complex.

    fn __repr__(&self) -> String {
        format!("LlmProvider(id='{}')", self.provider_id)
    }
}

// Helper functions for converting Python types to core types
fn convert_messages_to_core(messages: Vec<ChatMessage>) -> Vec<CoreChatMessage> {
    messages.into_iter().map(|m| {
        let role = match m.role {
            MessageRole::System => CoreMessageRole::System,
            MessageRole::User => CoreMessageRole::User,
            MessageRole::Assistant => CoreMessageRole::Assistant,
        };
        CoreChatMessage {
            role,
            content: CoreMessageContent::Text(m.content),
        }
    }).collect()
}

fn convert_options_to_core(options: Option<StreamChatOptions>) -> CoreStreamChatOptions {
    match options {
        Some(opts) => CoreStreamChatOptions {
            temperature: opts.temperature.map(|t| t as f32),
            max_tokens: opts.max_tokens,
            stop: opts.stop,
            tools: None,
            tool_choice: None,
        },
        None => CoreStreamChatOptions::default(),
    }
}

// ============================================================================
// Module Functions
// ============================================================================

/// List all available secret stores
#[pyfunction]
pub fn list_secret_stores() -> Vec<StoreInfo> {
    core_list_secret_stores()
        .into_iter()
        .map(|(name, description, is_plugin)| StoreInfo { name, description, is_plugin })
        .collect()
}

/// Get list of supported provider IDs
#[pyfunction]
pub fn supported_providers() -> Vec<String> {
    core_supported_providers()
        .iter()
        .map(|&s| s.to_string())
        .collect()
}

/// List all available providers with metadata
#[pyfunction]
pub fn list_providers() -> Vec<ProviderMetadata> {
    let logger: Arc<dyn Logger> = Arc::new(NoOpLogger::new());
    
    // Get all supported provider IDs and create metadata for each
    core_supported_providers()
        .iter()
        .map(|&id| {
            core_create_provider(id, Arc::clone(&logger)).metadata().into()
        })
        .collect()
}

// ============================================================================
// Module Definition
// ============================================================================

#[pymodule]
fn openllm(m: &Bound<'_, PyModule>) -> PyResult<()> {
    // MCP Types
    m.add_class::<McpEndpoint>()?;
    m.add_class::<ToolRegistry>()?;
    m.add_function(wrap_pyfunction!(register_mcp_endpoint, m)?)?;
    m.add_function(wrap_pyfunction!(unregister_mcp_endpoint, m)?)?;
    m.add_function(wrap_pyfunction!(has_mcp_endpoint, m)?)?;
    m.add_function(wrap_pyfunction!(get_mcp_socket_path, m)?)?;
    
    // Secret Store Types
    m.add_class::<SecretInfo>()?;
    m.add_class::<StoreInfo>()?;
    m.add_class::<EnvSecretStore>()?;
    m.add_class::<MemorySecretStore>()?;
    m.add_class::<KeychainSecretStore>()?;
    m.add_class::<ChainSecretStore>()?;
    
    // Config Types
    m.add_class::<ConfigLevel>()?;
    m.add_class::<ProviderConfig>()?;
    m.add_class::<FileConfigProvider>()?;
    m.add_class::<MemoryConfigProvider>()?;
    
    // Chat Types
    m.add_class::<MessageRole>()?;
    m.add_class::<ChatMessage>()?;
    
    // Stream Types
    m.add_class::<StreamChunk>()?;
    m.add_class::<PromptOption>()?;
    m.add_class::<ProviderRequestConfig>()?;
    m.add_class::<StreamChatOptions>()?;
    
    // Tool Types
    m.add_class::<Tool>()?;
    m.add_class::<ToolCall>()?;
    m.add_class::<ToolResult>()?;
    
    // Model Types
    m.add_class::<ModelCapabilities>()?;
    m.add_class::<ModelConfig>()?;
    m.add_class::<ProviderMetadata>()?;
    m.add_class::<DefaultModel>()?;
    
    // Provider
    m.add_class::<LlmProvider>()?;
    
    // Functions
    m.add_function(wrap_pyfunction!(list_secret_stores, m)?)?;
    m.add_function(wrap_pyfunction!(supported_providers, m)?)?;
    m.add_function(wrap_pyfunction!(list_providers, m)?)?;
    
    Ok(())
}
