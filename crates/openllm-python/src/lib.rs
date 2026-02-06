//! Python bindings for OpenLLM via PyO3

use pyo3::prelude::*;
use pyo3::exceptions::PyRuntimeError;
use std::sync::Arc;

use openllm_core::secrets::{
    SecretStore as CoreSecretStore,
    EnvSecretStore as CoreEnvSecretStore,
    MemorySecretStore as CoreMemorySecretStore,
    KeychainSecretStore as CoreKeychainSecretStore,
    list_secret_stores as core_list_secret_stores,
};
use openllm_core::config::{
    FileConfigProvider as CoreFileConfigProvider,
    ConfigLevel as CoreConfigLevel,
    ConfigProvider as CoreConfigProvider,
};
use openllm_core::types::{ProviderMetadata as CoreProviderMetadata, ProviderConfig as CoreProviderConfig};

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
// Module Functions
// ============================================================================

#[pyfunction]
pub fn list_secret_stores() -> Vec<StoreInfo> {
    core_list_secret_stores()
        .into_iter()
        .map(|(name, description, is_plugin)| StoreInfo { name, description, is_plugin })
        .collect()
}

/// List all available providers
#[pyfunction]
pub fn list_providers() -> Vec<ProviderMetadata> {
    use openllm_core::providers::{create_provider, supported_providers};
    use openllm_core::logging::{Logger, NoOpLogger};
    
    let logger: Arc<dyn Logger> = Arc::new(NoOpLogger::new());
    
    // Get all supported provider IDs and create metadata for each
    supported_providers()
        .iter()
        .filter(|&id| *id != "mock") // Exclude mock from public list
        .map(|&id| {
            create_provider(id, Arc::clone(&logger)).metadata().into()
        })
        .collect()
}

// ============================================================================
// Module Definition
// ============================================================================

#[pymodule]
fn openllm(m: &Bound<'_, PyModule>) -> PyResult<()> {
    // Secret Store Types
    m.add_class::<SecretInfo>()?;
    m.add_class::<StoreInfo>()?;
    m.add_class::<EnvSecretStore>()?;
    m.add_class::<MemorySecretStore>()?;
    m.add_class::<KeychainSecretStore>()?;
    
    // Config Types
    m.add_class::<ConfigLevel>()?;
    m.add_class::<ProviderConfig>()?;
    m.add_class::<FileConfigProvider>()?;
    
    // Chat Types
    m.add_class::<MessageRole>()?;
    m.add_class::<ChatMessage>()?;
    
    // Tool Types
    m.add_class::<Tool>()?;
    m.add_class::<ToolCall>()?;
    m.add_class::<ToolResult>()?;
    
    // Model Types
    m.add_class::<ModelCapabilities>()?;
    m.add_class::<ModelConfig>()?;
    m.add_class::<ProviderMetadata>()?;
    
    // Functions
    m.add_function(wrap_pyfunction!(list_secret_stores, m)?)?;
    m.add_function(wrap_pyfunction!(list_providers, m)?)?;
    
    Ok(())
}
