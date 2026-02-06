//! Adapter between openllm-core types and genai types
//!
//! This module provides conversion functions between our types and genai's types,
//! allowing us to leverage genai's battle-tested streaming and provider implementations.
//!
//! IMPORTANT: All auth flows through our UnifiedSecretResolver, not genai's default
//! env var lookup. This ensures consistent API key resolution across all sources
//! (env vars, keychain, VS Code secrets via RPC).

use std::future::Future;
use std::pin::Pin;

use genai::chat::{
    ChatMessage as GenaiMessage, ChatOptions as GenaiOptions,
    ChatRole as GenaiRole, ChatStreamEvent, MessageContent as GenaiContent, Tool as GenaiTool,
    ToolCall as GenaiToolCall, ToolResponse as GenaiToolResponse,
};
use genai::resolver::{AuthData, AuthResolver, Endpoint, ServiceTargetResolver};
use genai::{adapter::AdapterKind, Client, ModelIden, ServiceTarget};

use crate::types::{
    ChatMessage, ContentPart, MessageContent, MessageRole, StreamChunk, Tool, ToolCall, ToolResult,
};
use crate::resolver::UnifiedSecretResolver;

use super::error::ProviderError;
use super::traits::{ProviderModelConfig, StreamChatOptions};

// ============================================================================
// Message Conversion: openllm -> genai
// ============================================================================

/// Convert openllm MessageRole to genai ChatRole
pub fn to_genai_role(role: MessageRole) -> GenaiRole {
    match role {
        MessageRole::System => GenaiRole::System,
        MessageRole::User => GenaiRole::User,
        MessageRole::Assistant => GenaiRole::Assistant,
    }
}

/// Convert openllm ChatMessage to genai ChatMessage
pub fn to_genai_message(msg: ChatMessage) -> GenaiMessage {
    let content = match msg.content {
        MessageContent::Text(text) => GenaiContent::from(text),
        MessageContent::Parts(parts) => {
            // For now, concatenate text parts. TODO: handle multimodal properly
            let text: String = parts
                .into_iter()
                .filter_map(|p| match p {
                    ContentPart::Text { text } => Some(text),
                    ContentPart::ToolResult { tool_use_id, content } => {
                        // This will be handled separately as a tool response message
                        Some(format!("[Tool result for {}]: {}", tool_use_id, content))
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            GenaiContent::from(text)
        }
    };

    match msg.role {
        MessageRole::System => GenaiMessage::system(content),
        MessageRole::User => GenaiMessage::user(content),
        MessageRole::Assistant => GenaiMessage::assistant(content),
    }
}

/// Convert a vector of openllm messages to genai messages
pub fn to_genai_messages(messages: Vec<ChatMessage>) -> Vec<GenaiMessage> {
    messages.into_iter().map(to_genai_message).collect()
}

// ============================================================================
// Tool Conversion: openllm -> genai
// ============================================================================

/// Convert openllm Tool to genai Tool
pub fn to_genai_tool(tool: Tool) -> GenaiTool {
    let mut genai_tool = GenaiTool::new(&tool.name).with_description(&tool.description);

    if let Some(schema) = tool.input_schema {
        genai_tool = genai_tool.with_schema(schema);
    }

    genai_tool
}

/// Convert openllm tools to genai tools
pub fn to_genai_tools(tools: Vec<Tool>) -> Vec<GenaiTool> {
    tools.into_iter().map(to_genai_tool).collect()
}

/// Convert openllm ToolResult to genai ToolResponse
pub fn to_genai_tool_response(result: ToolResult) -> GenaiToolResponse {
    GenaiToolResponse::new(result.call_id, result.content)
}

// ============================================================================
// Options Conversion: openllm -> genai
// ============================================================================

/// Convert openllm StreamChatOptions to genai ChatOptions
pub fn to_genai_options(options: &StreamChatOptions) -> GenaiOptions {
    let mut genai_opts = GenaiOptions::default();

    if let Some(temp) = options.temperature {
        genai_opts = genai_opts.with_temperature(temp as f64);
    }

    if let Some(max_tokens) = options.max_tokens {
        genai_opts = genai_opts.with_max_tokens(max_tokens);
    }

    // Capture tool calls in stream so we can return them
    genai_opts = genai_opts.with_capture_tool_calls(true);

    genai_opts
}

// ============================================================================
// Response Conversion: genai -> openllm
// ============================================================================

/// Convert genai ToolCall to openllm ToolCall
pub fn from_genai_tool_call(tc: &GenaiToolCall) -> ToolCall {
    // fn_arguments is already a serde_json::Value
    let input = tc.fn_arguments.clone();

    ToolCall {
        id: tc.call_id.clone(),
        name: tc.fn_name.clone(),
        input,
    }
}

/// Convert genai stream event to openllm StreamChunk
pub fn from_genai_event(event: ChatStreamEvent) -> Option<Result<StreamChunk, ProviderError>> {
    match event {
        ChatStreamEvent::Chunk(chunk) => Some(Ok(StreamChunk::Text {
            text: chunk.content,
        })),
        ChatStreamEvent::ToolCallChunk(chunk) => {
            // Convert partial tool call to our format
            Some(Ok(StreamChunk::ToolCallDelta {
                id: chunk.tool_call.call_id,
                name: Some(chunk.tool_call.fn_name),
                input_delta: Some(chunk.tool_call.fn_arguments.to_string()),
            }))
        }
        ChatStreamEvent::End(end) => {
            // If there are captured tool calls, emit them
            if let Some(tool_calls) = end.captured_tool_calls() {
                if !tool_calls.is_empty() {
                    // Return the first tool call as a complete chunk
                    // TODO: handle multiple tool calls
                    let tc = from_genai_tool_call(&tool_calls[0]);
                    return Some(Ok(StreamChunk::ToolCall { tool_call: tc }));
                }
            }
            None // End of stream, no more chunks
        }
        ChatStreamEvent::Start => None, // Ignore start event
        ChatStreamEvent::ReasoningChunk(_) => None, // TODO: handle reasoning
        ChatStreamEvent::ThoughtSignatureChunk(_) => None, // TODO: handle thought signatures
    }
}

// ============================================================================
// Provider Resolution
// ============================================================================

/// Provider configuration for routing
#[derive(Debug, Clone)]
pub struct ProviderConfig {
    /// Provider identifier (e.g., "openai", "azure", "openrouter")
    pub provider: String,
    /// API key for authentication
    pub api_key: Option<String>,
    /// Custom API base URL
    pub api_base: Option<String>,
}

impl From<&ProviderModelConfig> for ProviderConfig {
    fn from(config: &ProviderModelConfig) -> Self {
        // Extract provider from model name if prefixed (e.g., "openai/gpt-4")
        let provider = config
            .model
            .split('/')
            .next()
            .unwrap_or("openai")
            .to_string();

        Self {
            provider,
            api_key: config.api_key.clone(),
            api_base: config.api_base.clone(),
        }
    }
}

// ============================================================================
// Provider to Secret Key Mapping
// ============================================================================

/// Map a provider ID to our secret store key name
pub fn provider_to_secret_key(provider: &str) -> String {
    match provider.to_lowercase().as_str() {
        "openai" => "openai_api_key".to_string(),
        "anthropic" => "anthropic_api_key".to_string(),
        "gemini" | "google" => "google_api_key".to_string(),
        "ollama" => "ollama_api_key".to_string(), // Usually not needed
        "groq" => "groq_api_key".to_string(),
        "xai" => "xai_api_key".to_string(),
        "deepseek" => "deepseek_api_key".to_string(),
        "cohere" => "cohere_api_key".to_string(),
        "fireworks" => "fireworks_api_key".to_string(),
        "together" => "together_api_key".to_string(),
        "azure" => "azure_openai_api_key".to_string(),
        "openrouter" => "openrouter_api_key".to_string(),
        "mistral" => "mistral_api_key".to_string(),
        "redhat" | "rhel" | "rhai" => "redhat_api_key".to_string(),
        _ => format!("{}_api_key", provider.to_lowercase()),
    }
}

/// Map a genai AdapterKind to our secret store key name
pub fn adapter_kind_to_secret_key(adapter: AdapterKind) -> String {
    match adapter {
        AdapterKind::OpenAI => "openai_api_key".to_string(),
        AdapterKind::Anthropic => "anthropic_api_key".to_string(),
        AdapterKind::Gemini => "google_api_key".to_string(),
        AdapterKind::Ollama => "ollama_api_key".to_string(),
        AdapterKind::Groq => "groq_api_key".to_string(),
        AdapterKind::Xai => "xai_api_key".to_string(),
        AdapterKind::DeepSeek => "deepseek_api_key".to_string(),
        AdapterKind::Cohere => "cohere_api_key".to_string(),
        AdapterKind::Fireworks => "fireworks_api_key".to_string(),
        AdapterKind::Together => "together_api_key".to_string(),
        _ => format!("{:?}_api_key", adapter).to_lowercase(),
    }
}

// ============================================================================
// Client Creation with Custom Auth
// ============================================================================

/// Create a genai Client with custom auth and endpoint resolution
/// 
/// Auth flows through our UnifiedSecretResolver, not genai's env var lookup.
/// This ensures consistent API key resolution from all configured sources.
pub fn create_client(config: &ProviderConfig) -> Client {
    let provider = config.provider.clone();
    let explicit_api_key = config.api_key.clone();
    let api_base = config.api_base.clone();

    // Create auth resolver that uses our secret resolution
    let auth_provider = provider.clone();
    let auth_explicit_key = explicit_api_key.clone();
    
    let auth_resolver = AuthResolver::from_resolver_async_fn(
        move |model_iden: ModelIden| -> Pin<Box<dyn Future<Output = genai::resolver::Result<Option<AuthData>>> + Send>> {
            let provider = auth_provider.clone();
            let explicit_key = auth_explicit_key.clone();
            let adapter_kind = model_iden.adapter_kind;
            
            Box::pin(async move {
                // If an explicit API key was provided in config, use it
                if let Some(key) = explicit_key {
                    return Ok(Some(AuthData::from_single(key)));
                }
                
                // Otherwise, look up from our secret resolver
                let secret_key = if provider.is_empty() {
                    // Use adapter kind to determine the secret key
                    adapter_kind_to_secret_key(adapter_kind)
                } else {
                    provider_to_secret_key(&provider)
                };
                
                let resolver = UnifiedSecretResolver::new();
                if let Some(resolved) = resolver.resolve_async(&secret_key).await {
                    Ok(Some(AuthData::from_single(resolved.value)))
                } else {
                    // Return None - genai will handle the "no auth" case appropriately
                    // For some providers like Ollama, this is fine
                    Ok(None)
                }
            })
        }
    );

    // Create service target resolver for custom endpoints
    let target_provider = provider.clone();
    let target_api_base = api_base.clone();
    
    let target_resolver = ServiceTargetResolver::from_resolver_fn(
        move |target: ServiceTarget| -> Result<ServiceTarget, genai::resolver::Error> {
            let ServiceTarget { ref model, .. } = target;

            // Determine endpoint and adapter based on provider
            let (endpoint, adapter_kind): (Option<Endpoint>, AdapterKind) = match target_provider.as_str() {
                // Providers with custom endpoints (OpenAI-compatible)
                "azure" => {
                    let ep = target_api_base
                        .as_ref()
                        .map(|u| Endpoint::from_owned(u.clone()))
                        .unwrap_or_else(|| {
                            Endpoint::from_static("https://your-resource.openai.azure.com/")
                        });
                    (Some(ep), AdapterKind::OpenAI)
                }
                "openrouter" => (
                    Some(Endpoint::from_static("https://openrouter.ai/api/v1/")),
                    AdapterKind::OpenAI,
                ),
                "mistral" => (
                    Some(Endpoint::from_static("https://api.mistral.ai/v1/")),
                    AdapterKind::OpenAI,
                ),
                "redhat" | "rhel" | "rhai" => {
                    let ep = target_api_base
                        .as_ref()
                        .map(|u| Endpoint::from_owned(u.clone()))
                        .expect("Red Hat AI requires api_base");
                    (Some(ep), AdapterKind::OpenAI)
                }
                // Native genai providers - let it resolve normally
                _ => return Ok(target),
            };

            // Build the resolved target - NOTE: auth is handled by AuthResolver, not here
            let resolved_endpoint = endpoint.unwrap_or(target.endpoint);
            let resolved_model = ModelIden::new(adapter_kind, model.model_name.clone());

            Ok(ServiceTarget {
                endpoint: resolved_endpoint,
                auth: target.auth, // Auth is handled by AuthResolver
                model: resolved_model,
            })
        },
    );

    Client::builder()
        .with_auth_resolver(auth_resolver)
        .with_service_target_resolver(target_resolver)
        .build()
}

/// Check if a provider is natively supported by genai
pub fn is_genai_native(provider: &str) -> bool {
    matches!(
        provider.to_lowercase().as_str(),
        "openai"
            | "anthropic"
            | "gemini"
            | "ollama"
            | "groq"
            | "xai"
            | "deepseek"
            | "cohere"
            | "fireworks"
            | "together"
            | "nebius"
            | "mimo"
            | "zai"
            | "bigmodel"
    )
}

/// Check if a provider can be handled by genai (native or via OpenAI-compat)
pub fn is_genai_supported(provider: &str) -> bool {
    is_genai_native(provider)
        || matches!(
            provider.to_lowercase().as_str(),
            "azure" | "openrouter" | "mistral" | "redhat" | "rhel" | "rhai"
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_role_conversion() {
        assert!(matches!(to_genai_role(MessageRole::System), GenaiRole::System));
        assert!(matches!(to_genai_role(MessageRole::User), GenaiRole::User));
        assert!(matches!(
            to_genai_role(MessageRole::Assistant),
            GenaiRole::Assistant
        ));
    }

    #[test]
    fn test_message_conversion() {
        let msg = ChatMessage::user("Hello, world!");
        let genai_msg = to_genai_message(msg);
        assert!(matches!(genai_msg.role, GenaiRole::User));
    }

    #[test]
    fn test_tool_conversion() {
        let tool = Tool::new("get_weather", "Get weather for a location")
            .with_schema(serde_json::json!({
                "type": "object",
                "properties": {
                    "location": { "type": "string" }
                }
            }));

        let genai_tool = to_genai_tool(tool);
        assert_eq!(genai_tool.name, "get_weather");
    }

    #[test]
    fn test_provider_detection() {
        assert!(is_genai_native("openai"));
        assert!(is_genai_native("anthropic"));
        assert!(is_genai_native("gemini"));
        assert!(!is_genai_native("azure"));
        assert!(!is_genai_native("openrouter"));

        assert!(is_genai_supported("openai"));
        assert!(is_genai_supported("azure"));
        assert!(is_genai_supported("openrouter"));
        assert!(is_genai_supported("mistral"));
        assert!(is_genai_supported("redhat"));
    }
}
