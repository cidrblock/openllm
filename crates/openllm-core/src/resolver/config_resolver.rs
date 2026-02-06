//! Unified configuration resolution from multiple sources
//!
//! This resolver maintains a GLOBAL IN-MEMORY state of all providers, making reads
//! instant and eliminating race conditions with file writes.
//!
//! Architecture:
//! - Global memory is the source of truth during runtime (shared across all resolver instances)
//! - Changes update memory immediately, then persist async
//! - On startup, state is loaded from sources
//! - `reload()` re-syncs from disk if needed
//!
//! Source priority for initial load (later sources override earlier):
//! 1. Native YAML user config (~/.config/openllm/config.yaml)
//! 2. RPC user config (VS Code User Settings)
//! 3. Native YAML workspace config (.config/openllm/config.yaml)
//! 4. RPC workspace config (VS Code Workspace Settings)

use std::path::PathBuf;
use std::collections::HashMap;
use std::sync::{RwLock, OnceLock};
use crate::config::{FileConfigProvider, ConfigProvider};
use crate::types::{ProviderConfig, ConfigSource};
use crate::rpc::{RpcConfigProvider, get_rpc_endpoint};

// Global in-memory provider state - shared across all resolver instances
static GLOBAL_PROVIDERS: OnceLock<RwLock<HashMap<String, ResolvedProvider>>> = OnceLock::new();

fn get_global_providers() -> &'static RwLock<HashMap<String, ResolvedProvider>> {
    GLOBAL_PROVIDERS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Resolved configuration with source tracking
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    /// All resolved providers
    pub providers: Vec<ResolvedProvider>,
}

/// A provider configuration with source tracking
#[derive(Debug, Clone)]
pub struct ResolvedProvider {
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

/// Config source preference - where to store/read provider config
/// (Named "Preference" to avoid conflict with crate::types::ConfigSource)
#[derive(Debug, Clone, PartialEq)]
pub enum ConfigSourcePreference {
    /// Use native YAML files (~/.config/openllm/config.yaml)
    Native,
    /// Use VS Code settings via RPC
    VsCode,
}

impl Default for ConfigSourcePreference {
    fn default() -> Self {
        ConfigSourcePreference::Native  // Default to native when not in VS Code
    }
}

impl ConfigSourcePreference {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "vscode" | "vs_code" | "vs-code" => ConfigSourcePreference::VsCode,
            _ => ConfigSourcePreference::Native,
        }
    }
}

/// Unified config resolver with shared global in-memory state
/// 
/// All resolver instances share the same global memory state, so changes
/// made by one instance are immediately visible to all others.
/// Memory is the source of truth during runtime. Changes update memory
/// immediately, then persist to disk/RPC asynchronously.
#[derive(Clone)]
pub struct UnifiedConfigResolver {
    /// Workspace path for workspace-level config
    pub workspace_path: Option<PathBuf>,
    /// RPC endpoint names to check
    pub rpc_endpoints: Vec<String>,
    /// User's preferred config source (set by host application)
    pub config_source: ConfigSourcePreference,
    // Note: providers are stored in GLOBAL_PROVIDERS, not per-instance
}

impl UnifiedConfigResolver {
    /// Create a new resolver
    /// 
    /// Note: Does NOT auto-load from sources. Call set_config_source() to set
    /// preferences and trigger loading, or call load_from_sources() explicitly.
    /// This prevents loading with wrong defaults before preferences are set.
    pub fn new() -> Self {
        Self {
            workspace_path: None,
            rpc_endpoints: vec!["vscode".to_string()],
            config_source: ConfigSourcePreference::default(),
        }
    }

    /// Create with a workspace path
    /// 
    /// Note: Does NOT auto-load from sources. Call set_config_source() to set
    /// preferences and trigger loading, or call load_from_sources() explicitly.
    /// This prevents loading with wrong defaults before preferences are set.
    pub fn with_workspace(workspace_path: impl Into<PathBuf>) -> Self {
        Self {
            workspace_path: Some(workspace_path.into()),
            rpc_endpoints: vec!["vscode".to_string()],
            config_source: ConfigSourcePreference::default(),
        }
    }

    /// Set the workspace path and reload from sources
    pub fn set_workspace(&mut self, path: Option<PathBuf>) {
        self.workspace_path = path;
        self.load_from_sources();
    }
    
    /// Load/reload provider state from all sources into memory
    /// 
    /// This merges providers from all sources with proper priority.
    /// Call this on startup or when external config changes are detected.
    /// 
    /// Uses &self because providers is behind RwLock for thread safety.
    pub fn load_from_sources(&self) {
        let mut providers_map: HashMap<String, ResolvedProvider> = HashMap::new();

        // Load based on user's config source preference
        match self.config_source {
            ConfigSourcePreference::Native => {
                // Native mode: Only load from native YAML files, NO RPC calls
                
                // 1. Native YAML user config
                let user_yaml = FileConfigProvider::user();
                if user_yaml.exists() {
                    let providers = futures::executor::block_on(user_yaml.get_providers());
                    for p in providers {
                        providers_map.insert(p.name.to_lowercase(), ResolvedProvider {
                            name: p.name,
                            enabled: p.enabled,
                            api_base: p.api_base,
                            models: p.models,
                            source: "native:user".to_string(),
                            source_detail: "~/.config/openllm/config.yaml".to_string(),
                        });
                    }
                }

                // 2. Native YAML workspace config (overrides user)
                if let Some(ws_path) = &self.workspace_path {
                    let ws_yaml = FileConfigProvider::workspace(ws_path);
                    if ws_yaml.exists() {
                        let providers = futures::executor::block_on(ws_yaml.get_providers());
                        for p in providers {
                            providers_map.insert(p.name.to_lowercase(), ResolvedProvider {
                                name: p.name,
                                enabled: p.enabled,
                                api_base: p.api_base,
                                models: p.models,
                                source: "native:workspace".to_string(),
                                source_detail: ".config/openllm/config.yaml".to_string(),
                            });
                        }
                    }
                }
            }
            ConfigSourcePreference::VsCode => {
                // VS Code mode: Load from RPC (VS Code settings)
                for endpoint_name in &self.rpc_endpoints {
                    if let Some(endpoint) = get_rpc_endpoint(endpoint_name) {
                        let rpc_config = RpcConfigProvider::new(&endpoint);
                        
                        // Skip RPC entirely if not reachable
                        if !rpc_config.is_reachable() {
                            continue;
                        }
                        
                        // Get user settings
                        if let Ok(providers) = rpc_config.get_providers("user", None) {
                            for p in providers {
                                providers_map.insert(p.name.to_lowercase(), ResolvedProvider {
                                    name: p.name,
                                    enabled: p.enabled,
                                    api_base: p.api_base,
                                    models: p.models,
                                    source: format!("rpc:{}:user", endpoint_name),
                                    source_detail: format!("{} User Settings", endpoint_name),
                                });
                            }
                        }
                        
                        // Get workspace settings (overrides user)
                        if let Ok(providers) = rpc_config.get_providers(
                            "workspace",
                            self.workspace_path.as_deref(),
                        ) {
                            for p in providers {
                                providers_map.insert(p.name.to_lowercase(), ResolvedProvider {
                                    name: p.name,
                                    enabled: p.enabled,
                                    api_base: p.api_base,
                                    models: p.models,
                                    source: format!("rpc:{}:workspace", endpoint_name),
                                    source_detail: format!("{} Workspace Settings", endpoint_name),
                                });
                            }
                        }
                    }
                }
            }
        }

        // Update in-memory state
        if let Ok(mut providers) = get_global_providers().write() {
            *providers = providers_map;
        }
    }
    
    /// Reload from sources asynchronously (non-blocking)
    pub async fn load_from_sources_async(&self) {
        let mut providers_map: HashMap<String, ResolvedProvider> = HashMap::new();

        // Load based on user's config source preference
        match self.config_source {
            ConfigSourcePreference::Native => {
                // Native mode: Only load from native YAML files, NO RPC calls
                
                // 1. Native YAML user config
                let user_yaml = FileConfigProvider::user();
                if user_yaml.exists() {
                    let providers = user_yaml.get_providers().await;
                    for p in providers {
                        providers_map.insert(p.name.to_lowercase(), ResolvedProvider {
                            name: p.name,
                            enabled: p.enabled,
                            api_base: p.api_base,
                            models: p.models,
                            source: "native:user".to_string(),
                            source_detail: "~/.config/openllm/config.yaml".to_string(),
                        });
                    }
                }

                // 2. Native YAML workspace config (overrides user)
                if let Some(ws_path) = &self.workspace_path {
                    let ws_yaml = FileConfigProvider::workspace(ws_path);
                    if ws_yaml.exists() {
                        let providers = ws_yaml.get_providers().await;
                        for p in providers {
                            providers_map.insert(p.name.to_lowercase(), ResolvedProvider {
                                name: p.name,
                                enabled: p.enabled,
                                api_base: p.api_base,
                                models: p.models,
                                source: "native:workspace".to_string(),
                                source_detail: ".config/openllm/config.yaml".to_string(),
                            });
                        }
                    }
                }
            }
            ConfigSourcePreference::VsCode => {
                // VS Code mode: Load from RPC (VS Code settings)
                for endpoint_name in &self.rpc_endpoints {
                    if let Some(endpoint) = get_rpc_endpoint(endpoint_name) {
                        let rpc_config = RpcConfigProvider::new(&endpoint);
                        
                        if !rpc_config.is_reachable() {
                            continue;
                        }
                        
                        if let Ok(providers) = rpc_config.get_providers("user", None) {
                            for p in providers {
                                providers_map.insert(p.name.to_lowercase(), ResolvedProvider {
                                    name: p.name,
                                    enabled: p.enabled,
                                    api_base: p.api_base,
                                    models: p.models,
                                    source: format!("rpc:{}:user", endpoint_name),
                                    source_detail: format!("{} User Settings", endpoint_name),
                                });
                            }
                        }
                        
                        if let Ok(providers) = rpc_config.get_providers(
                            "workspace",
                            self.workspace_path.as_deref(),
                        ) {
                            for p in providers {
                                providers_map.insert(p.name.to_lowercase(), ResolvedProvider {
                                    name: p.name,
                                    enabled: p.enabled,
                                    api_base: p.api_base,
                                    models: p.models,
                                    source: format!("rpc:{}:workspace", endpoint_name),
                                    source_detail: format!("{} Workspace Settings", endpoint_name),
                                });
                            }
                        }
                    }
                }
            }
        }

        // Update in-memory state
        if let Ok(mut providers) = get_global_providers().write() {
            *providers = providers_map;
        }
    }

    /// Set the config source preference and load from sources
    /// 
    /// This should be called by the host application (e.g., VS Code extension)
    /// to inform the resolver where the user wants config stored.
    /// 
    /// This is the primary initialization method - call this after creating
    /// the resolver to load config from the correct sources.
    pub fn set_config_source(&mut self, source: ConfigSourcePreference) {
        self.config_source = source;
        // Load from the correct sources based on preference
        self.load_from_sources();
    }

    /// Set config source from string (convenience for NAPI)
    /// 
    /// This is the primary initialization method - call this after creating
    /// the resolver to load config from the correct sources.
    pub fn set_config_source_str(&mut self, source: &str) {
        let new_source = ConfigSourcePreference::from_str(source);
        self.set_config_source(new_source);
    }

    /// Get the current config source preference
    pub fn get_config_source(&self) -> &ConfigSourcePreference {
        &self.config_source
    }

    /// Add an RPC endpoint to check
    pub fn add_rpc_endpoint(&mut self, name: impl Into<String>) {
        self.rpc_endpoints.push(name.into());
    }

    /// Get all providers from in-memory state (instant, no I/O)
    ///
    /// Returns a clone of the current in-memory provider state.
    /// This is the primary read method - always returns immediately.
    pub fn get_all_providers(&self) -> ResolvedConfig {
        let providers = match get_global_providers().read() {
            Ok(guard) => {
                let result: Vec<ResolvedProvider> = guard.values().cloned().collect();
                crate::logging::debug("config_resolver", &format!("get_all_providers: Read {} providers from memory", result.len()));
                for p in &result {
                    crate::logging::trace("config_resolver", &format!("get_all_providers:   - {}: enabled={}", p.name, p.enabled));
                }
                result
            }
            Err(e) => {
                crate::logging::error("config_resolver", &format!("get_all_providers: Failed to read: {:?}", e));
                Vec::new()
            }
        };
        
        ResolvedConfig { providers }
    }
    
    /// Get all providers asynchronously (same as sync - memory read is instant)
    ///
    /// This exists for API compatibility but just returns from memory.
    pub async fn get_all_providers_async(&self) -> ResolvedConfig {
        self.get_all_providers()
    }
    
    /// Force reload from sources (for when external changes are detected)
    /// 
    /// This is async and non-blocking.
    pub async fn reload_async(&self) {
        self.load_from_sources_async().await;
    }
    
    /// Force reload from sources (blocking version)
    pub fn reload(&self) {
        self.load_from_sources();
    }
    
    /// Get a specific provider from in-memory state
    pub fn get_provider(&self, name: &str) -> Option<ResolvedProvider> {
        let all = self.get_all_providers();
        all.providers.into_iter().find(|p| p.name.eq_ignore_ascii_case(name))
    }

    /// Get providers at a specific scope only
    pub fn get_providers_at_scope(&self, scope: &str) -> Vec<ResolvedProvider> {
        let mut providers = Vec::new();

        match scope {
            "user" => {
                // Native YAML user
                let user_yaml = FileConfigProvider::user();
                if user_yaml.exists() {
                    let ps = futures::executor::block_on(user_yaml.get_providers());
                    for p in ps {
                        providers.push(ResolvedProvider {
                            name: p.name,
                            enabled: p.enabled,
                            api_base: p.api_base,
                            models: p.models,
                            source: "native:user".to_string(),
                            source_detail: "~/.config/openllm/config.yaml".to_string(),
                        });
                    }
                }

                // RPC user
                for endpoint_name in &self.rpc_endpoints {
                    if let Some(endpoint) = get_rpc_endpoint(endpoint_name) {
                        let rpc_config = RpcConfigProvider::new(&endpoint);
                        if rpc_config.is_reachable() {
                            if let Ok(ps) = rpc_config.get_providers("user", None) {
                                for p in ps {
                                    providers.push(ResolvedProvider {
                                        name: p.name,
                                        enabled: p.enabled,
                                        api_base: p.api_base,
                                        models: p.models,
                                        source: format!("rpc:{}:user", endpoint_name),
                                        source_detail: format!("{} User Settings", endpoint_name),
                                    });
                                }
                            }
                        }
                    }
                }
            }
            "workspace" => {
                // Native YAML workspace
                if let Some(ws_path) = &self.workspace_path {
                    let ws_yaml = FileConfigProvider::workspace(ws_path);
                    if ws_yaml.exists() {
                        let ps = futures::executor::block_on(ws_yaml.get_providers());
                        for p in ps {
                            providers.push(ResolvedProvider {
                                name: p.name,
                                enabled: p.enabled,
                                api_base: p.api_base,
                                models: p.models,
                                source: "native:workspace".to_string(),
                                source_detail: ".config/openllm/config.yaml".to_string(),
                            });
                        }
                    }
                }

                // RPC workspace
                for endpoint_name in &self.rpc_endpoints {
                    if let Some(endpoint) = get_rpc_endpoint(endpoint_name) {
                        let rpc_config = RpcConfigProvider::new(&endpoint);
                        if rpc_config.is_reachable() {
                            if let Ok(ps) = rpc_config.get_providers(
                                "workspace",
                                self.workspace_path.as_deref(),
                            ) {
                                for p in ps {
                                    providers.push(ResolvedProvider {
                                        name: p.name,
                                        enabled: p.enabled,
                                        api_base: p.api_base,
                                        models: p.models,
                                        source: format!("rpc:{}:workspace", endpoint_name),
                                        source_detail: format!("{} Workspace Settings", endpoint_name),
                                    });
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }

        providers
    }

    /// List all available config sources and their status
    /// List available config sources and their status
    /// 
    /// Only lists sources relevant to the current config_source preference
    /// to avoid unnecessary RPC calls.
    pub fn list_sources(&self) -> Vec<(String, bool, String)> {
        let mut sources = Vec::new();

        match self.config_source {
            ConfigSourcePreference::Native => {
                // Native mode: only list YAML file sources (no RPC checks)
                
                // Native YAML user
                let user_yaml = FileConfigProvider::user();
                sources.push((
                    "native:user".to_string(),
                    user_yaml.exists(),
                    user_yaml.path().to_string_lossy().to_string(),
                ));

                // Native YAML workspace
                if let Some(ws_path) = &self.workspace_path {
                    let ws_yaml = FileConfigProvider::workspace(ws_path);
                    sources.push((
                        "native:workspace".to_string(),
                        ws_yaml.exists(),
                        ws_yaml.path().to_string_lossy().to_string(),
                    ));
                }
            }
            ConfigSourcePreference::VsCode => {
                // VsCode mode: only list RPC sources
                
                // RPC user
                for endpoint_name in &self.rpc_endpoints {
                    let available = get_rpc_endpoint(endpoint_name)
                        .map(|e| RpcConfigProvider::new(&e).is_reachable())
                        .unwrap_or(false);
                    sources.push((
                        format!("rpc:{}:user", endpoint_name),
                        available,
                        format!("{} User Settings", endpoint_name),
                    ));
                }

                // RPC workspace
                for endpoint_name in &self.rpc_endpoints {
                    let available = get_rpc_endpoint(endpoint_name)
                        .map(|e| RpcConfigProvider::new(&e).is_reachable())
                        .unwrap_or(false);
                    sources.push((
                        format!("rpc:{}:workspace", endpoint_name),
                        available,
                        format!("{} Workspace Settings", endpoint_name),
                    ));
                }
            }
        }

        sources
    }

    // ========== WRITE OPERATIONS ==========
    //
    // The resolver intelligently routes writes based on what's available:
    // - If RPC (VS Code) is available → use it (preferred for VS Code users)
    // - Otherwise → fall back to native YAML files

    /// Determine the write destination based on user preference
    /// 
    /// This respects the user's config source setting rather than
    /// automatically detecting RPC availability.
    fn get_write_destination(&self, scope: &str) -> WriteDestination {
        match self.config_source {
            ConfigSourcePreference::Native => {
                // User wants native YAML files - write directly, no RPC
                WriteDestination::Native(scope.to_string())
            }
            ConfigSourcePreference::VsCode => {
                // User wants VS Code settings - use RPC
                // Find the first available RPC endpoint
                for endpoint_name in &self.rpc_endpoints {
                    if let Some(_endpoint) = get_rpc_endpoint(endpoint_name) {
                        return WriteDestination::Rpc(endpoint_name.clone(), scope.to_string());
                    }
                }
                // RPC requested but not available - fall back to native with warning
                // This shouldn't happen if extension properly registered the endpoint
                crate::logging::warn("config_resolver", "VS Code config source selected but no RPC endpoint available, falling back to native");
                WriteDestination::Native(scope.to_string())
            }
        }
    }

    /// Save a provider configuration
    ///
    /// This updates in-memory state FIRST (instant), then persists to disk.
    /// The scope determines user vs workspace:
    /// - "user" → user-level config (global)
    /// - "workspace" → workspace-level config (project-specific)
    pub fn save_provider(
        &self,
        provider: &ResolvedProvider,
        scope: &str,
    ) -> Result<String, String> {
        // 1. UPDATE MEMORY FIRST (instant, no I/O)
        let source_detail = self.compute_source_detail(scope);
        let provider_with_source = ResolvedProvider {
            name: provider.name.clone(),
            enabled: provider.enabled,
            api_base: provider.api_base.clone(),
            models: provider.models.clone(),
            source: format!("{}:{}", 
                if matches!(self.config_source, ConfigSourcePreference::VsCode) { "rpc:vscode" } else { "native" },
                scope
            ),
            source_detail: source_detail.clone(),
        };
        
        let key = provider.name.to_lowercase();
        crate::logging::info("config_resolver", &format!("save_provider: Updating memory: key={}, enabled={}", key, provider_with_source.enabled));
        
        // Update memory - this MUST succeed
        {
            let mut providers = get_global_providers().write()
                .map_err(|e| format!("Failed to acquire write lock: {:?}", e))?;
            providers.insert(key.clone(), provider_with_source);
            crate::logging::info("config_resolver", &format!("save_provider: Memory updated, now has {} providers. key={} enabled={}", 
                providers.len(), key, providers.get(&key).map(|p| p.enabled).unwrap_or(false)));
        } // Write lock released here
        
        // 2. PERSIST TO DISK/RPC (can be slow, but memory is already updated)
        let destination = self.get_write_destination(scope);
        
        match destination {
            WriteDestination::Rpc(endpoint_name, scope) => {
                crate::logging::info("config_resolver", &format!("save_provider: Using RPC destination: endpoint={}, scope={}", endpoint_name, scope));
                
                if let Some(endpoint) = get_rpc_endpoint(&endpoint_name) {
                    crate::logging::info("config_resolver", &format!("save_provider: RPC endpoint found: socket={}", endpoint.socket_path.display()));
                    let rpc_config = RpcConfigProvider::new(&endpoint);
                    
                    crate::logging::info("config_resolver", &format!("save_provider: Calling RPC set_provider: provider={}, scope={}, enabled={}, models_count={}",
                        provider.name, scope, provider.enabled, provider.models.len()));
                    
                    match rpc_config.set_provider(
                        &provider.name,
                        &scope,
                        self.workspace_path.as_deref(),
                        Some(provider.enabled),
                        Some(provider.models.clone()),
                        provider.api_base.clone(),
                    ) {
                        Ok(()) => {
                            crate::logging::info("config_resolver", "save_provider: RPC set_provider succeeded");
                            Ok(format!("{} {} Settings", endpoint_name, if scope == "user" { "User" } else { "Workspace" }))
                        }
                        Err(e) => {
                            crate::logging::error("config_resolver", &format!("save_provider: RPC set_provider FAILED: {:?}", e));
                            Err(format!("RPC write failed: {}", e))
                        }
                    }
                } else {
                    crate::logging::error("config_resolver", &format!("save_provider: RPC endpoint '{}' NOT FOUND!", endpoint_name));
                    Err(format!("RPC endpoint '{}' not found", endpoint_name))
                }
            }
            WriteDestination::Native(scope) => {
                let file_config = if scope == "workspace" {
                    if let Some(ws_path) = &self.workspace_path {
                        FileConfigProvider::workspace(ws_path)
                    } else {
                        return Err("No workspace path set for workspace-level config".to_string());
                    }
                } else {
                    FileConfigProvider::user()
                };
                
                // Get existing providers from FILE and merge (not from memory, to preserve other providers)
                let mut file_providers = if file_config.exists() {
                    futures::executor::block_on(file_config.get_providers())
                } else {
                    Vec::new()
                };
                
                // Find and update or add
                let existing_idx = file_providers.iter().position(|p| p.name.eq_ignore_ascii_case(&provider.name));
                let config = ProviderConfig {
                    name: provider.name.clone(),
                    enabled: provider.enabled,
                    api_base: provider.api_base.clone(),
                    models: provider.models.clone(),
                    source: if scope == "workspace" { ConfigSource::NativeWorkspace } else { ConfigSource::NativeUser },
                };
                
                if let Some(idx) = existing_idx {
                    file_providers[idx] = config;
                } else {
                    file_providers.push(config);
                }
                
                file_config.import_providers(file_providers)
                    .map_err(|e| format!("Failed to write config: {}", e))?;
                Ok(file_config.path().to_string_lossy().to_string())
            }
        }
    }
    
    /// Compute source detail string for a given scope
    fn compute_source_detail(&self, scope: &str) -> String {
        match self.config_source {
            ConfigSourcePreference::VsCode => {
                format!("vscode {} Settings", if scope == "user" { "User" } else { "Workspace" })
            }
            ConfigSourcePreference::Native => {
                if scope == "workspace" {
                    ".config/openllm/config.yaml".to_string()
                } else {
                    "~/.config/openllm/config.yaml".to_string()
                }
            }
        }
    }

    /// Update models for a provider
    pub fn update_provider_models(
        &self,
        provider_name: &str,
        models: Vec<String>,
        scope: &str,
    ) -> Result<String, String> {
        // Get existing provider or create new one
        let existing = self.get_provider(provider_name);
        
        let provider = ResolvedProvider {
            name: provider_name.to_string(),
            enabled: existing.as_ref().map(|p| p.enabled).unwrap_or(true),
            api_base: existing.as_ref().and_then(|p| p.api_base.clone()),
            models,
            source: "".to_string(),
            source_detail: "".to_string(),
        };
        
        self.save_provider(&provider, scope)
    }

    /// Toggle provider enabled state
    pub fn toggle_provider(
        &self,
        provider_name: &str,
        enabled: bool,
        scope: &str,
    ) -> Result<String, String> {
        crate::logging::info("config_resolver", &format!("toggle_provider: provider={}, enabled={}, scope={}", provider_name, enabled, scope));
        
        let existing = self.get_provider(provider_name);
        crate::logging::debug("config_resolver", &format!("toggle_provider: existing.enabled={:?}", existing.as_ref().map(|p| p.enabled)));
        
        let provider = ResolvedProvider {
            name: provider_name.to_string(),
            enabled,
            api_base: existing.as_ref().and_then(|p| p.api_base.clone()),
            models: existing.as_ref().map(|p| p.models.clone()).unwrap_or_default(),
            source: "".to_string(),
            source_detail: "".to_string(),
        };
        
        let result = self.save_provider(&provider, scope);
        
        // Verify the update
        let after = self.get_provider(provider_name);
        crate::logging::debug("config_resolver", &format!("toggle_provider: after.enabled={:?}", after.as_ref().map(|p| p.enabled)));
        
        result
    }

    /// Remove a provider from the specified scope
    pub fn remove_provider(
        &self,
        provider_name: &str,
        scope: &str,
    ) -> Result<String, String> {
        let destination = self.get_write_destination(scope);
        
        match destination {
            WriteDestination::Rpc(endpoint_name, scope) => {
                // Set enabled to false and models to empty (effectively removes)
                if let Some(endpoint) = get_rpc_endpoint(&endpoint_name) {
                    let rpc_config = RpcConfigProvider::new(&endpoint);
                    
                    rpc_config.set_provider(
                        provider_name,
                        &scope,
                        self.workspace_path.as_deref(),
                        Some(false),
                        Some(vec![]),
                        None,
                    ).map_err(|e| format!("RPC remove failed: {}", e))?;
                    
                    Ok(format!("{} {} Settings", endpoint_name, if scope == "user" { "User" } else { "Workspace" }))
                } else {
                    Err(format!("RPC endpoint '{}' not found", endpoint_name))
                }
            }
            WriteDestination::Native(scope) => {
                let file_config = if scope == "workspace" {
                    if let Some(ws_path) = &self.workspace_path {
                        FileConfigProvider::workspace(ws_path)
                    } else {
                        return Err("No workspace path set".to_string());
                    }
                } else {
                    FileConfigProvider::user()
                };
                
                if !file_config.exists() {
                    return Ok("Already removed".to_string());
                }
                
                let mut providers = futures::executor::block_on(file_config.get_providers());
                providers.retain(|p| !p.name.eq_ignore_ascii_case(provider_name));
                file_config.import_providers(providers)
                    .map_err(|e| format!("Failed to write config: {}", e))?;
                
                Ok(file_config.path().to_string_lossy().to_string())
            }
        }
    }

    /// Get information about where a write would go for a given scope
    pub fn get_write_destination_info(&self, scope: &str) -> (String, String) {
        match self.get_write_destination(scope) {
            WriteDestination::Rpc(name, scope) => (
                format!("rpc:{}:{}", name, scope),
                format!("{} {} Settings", name, if scope == "user" { "User" } else { "Workspace" }),
            ),
            WriteDestination::Native(scope) => {
                let path = if scope == "workspace" {
                    self.workspace_path.as_ref()
                        .map(|p| FileConfigProvider::workspace(p).path().to_string_lossy().to_string())
                        .unwrap_or_else(|| ".config/openllm/config.yaml".to_string())
                } else {
                    FileConfigProvider::user().path().to_string_lossy().to_string()
                };
                (format!("native:{}", scope), path)
            }
        }
    }
}

/// Where a write will be routed
enum WriteDestination {
    /// Write to RPC endpoint (endpoint_name, scope)
    Rpc(String, String),
    /// Write to native YAML file (scope)
    Native(String),
}

impl Default for UnifiedConfigResolver {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolver_creation() {
        let resolver = UnifiedConfigResolver::new();
        let sources = resolver.list_sources();
        assert!(!sources.is_empty());
    }

    #[test]
    fn test_resolver_with_workspace() {
        let resolver = UnifiedConfigResolver::with_workspace("/tmp/test-workspace");
        let sources = resolver.list_sources();
        assert!(sources.iter().any(|(name, _, _)| name == "native:workspace"));
    }
}
