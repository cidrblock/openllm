//! Chat orchestrator for managing the tool calling loop
//!
//! The ChatOrchestrator manages the complete conversation flow including:
//! - Streaming responses from the LLM
//! - Collecting tool calls from the response
//! - Executing tools via the ToolRegistry
//! - Adding tool results to the conversation
//! - Repeating until no more tool calls or max iterations
//!
//! ## Architecture
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────────────┐
//! │                        ChatOrchestrator                                  │
//! │                                                                         │
//! │  ┌─────────────────────────────────────────────────────────────────┐   │
//! │  │  Orchestration Loop                                              │   │
//! │  │                                                                  │   │
//! │  │  1. Send messages to LLM ──▶ Stream response                    │   │
//! │  │  2. Emit text chunks ──▶ UI                                      │   │
//! │  │  3. Collect tool calls                                           │   │
//! │  │  4. If tool calls:                                               │   │
//! │  │     a. Emit ToolExecuting chunks ──▶ UI                         │   │
//! │  │     b. Execute via ToolRegistry                                  │   │
//! │  │     c. Emit ToolResult chunks ──▶ UI                            │   │
//! │  │     d. Add results to messages                                   │   │
//! │  │     e. Go to step 1 (next iteration)                            │   │
//! │  │  5. Emit Done chunk ──▶ UI                                       │   │
//! │  └─────────────────────────────────────────────────────────────────┘   │
//! └─────────────────────────────────────────────────────────────────────────┘
//! ```

use std::sync::Arc;
use futures::{Stream, StreamExt};
use tokio::sync::mpsc;
use parking_lot::RwLock;

use crate::logging::Logger;
use crate::providers::{Provider, ProviderModelConfig, StreamChatOptions};
use crate::types::{
    ChatMessage, ContentPart, MessageContent, MessageRole,
    StreamChunk, PromptOption, ToolCall, ToolResult, CancellationToken,
};
use super::ToolRegistry;

/// Configuration for the orchestration loop
#[derive(Debug, Clone)]
pub struct OrchestratorConfig {
    /// Maximum number of tool calling iterations
    pub max_iterations: u32,
    /// Whether to continue on tool errors
    pub continue_on_error: bool,
    /// Whether to emit orchestration status chunks
    pub emit_status: bool,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        Self {
            max_iterations: 10,
            continue_on_error: true,
            emit_status: true,
        }
    }
}

impl OrchestratorConfig {
    pub fn new() -> Self {
        Self::default()
    }
    
    pub fn with_max_iterations(mut self, max: u32) -> Self {
        self.max_iterations = max;
        self
    }
    
    pub fn with_continue_on_error(mut self, continue_on_error: bool) -> Self {
        self.continue_on_error = continue_on_error;
        self
    }
    
    pub fn with_emit_status(mut self, emit: bool) -> Self {
        self.emit_status = emit;
        self
    }
}

/// User response to a prompt
#[derive(Debug, Clone)]
pub struct UserPromptResponse {
    /// The prompt ID this is responding to
    pub prompt_id: String,
    /// The selected option ID
    pub selected_option: String,
}

/// Channel for receiving user responses to prompts
pub type PromptResponseReceiver = mpsc::Receiver<UserPromptResponse>;
/// Channel for sending user responses to prompts  
pub type PromptResponseSender = mpsc::Sender<UserPromptResponse>;

/// Chat orchestrator that manages the complete tool calling flow
pub struct ChatOrchestrator {
    /// Tool registry for discovering and executing tools
    tool_registry: Arc<ToolRegistry>,
    /// Logger for diagnostics
    logger: Arc<dyn Logger>,
    /// Configuration
    config: OrchestratorConfig,
    /// Channel for receiving prompt responses
    prompt_response_rx: RwLock<Option<PromptResponseReceiver>>,
}

impl ChatOrchestrator {
    /// Create a new orchestrator
    pub fn new(
        tool_registry: Arc<ToolRegistry>,
        logger: Arc<dyn Logger>,
        config: OrchestratorConfig,
    ) -> Self {
        Self {
            tool_registry,
            logger,
            config,
            prompt_response_rx: RwLock::new(None),
        }
    }
    
    /// Create a channel pair for prompt responses
    pub fn create_prompt_channel() -> (PromptResponseSender, PromptResponseReceiver) {
        mpsc::channel(16)
    }
    
    /// Set the prompt response receiver
    pub fn set_prompt_receiver(&self, rx: PromptResponseReceiver) {
        *self.prompt_response_rx.write() = Some(rx);
    }
    
    /// Run the orchestrated chat, returning a stream of chunks
    ///
    /// This method handles the full tool calling loop:
    /// 1. Stream the LLM response
    /// 2. If tool calls are detected, execute them
    /// 3. Add tool results to the conversation
    /// 4. Continue until no more tool calls or max iterations
    pub fn stream_chat(
        self: Arc<Self>,
        provider: Arc<dyn Provider>,
        messages: Vec<ChatMessage>,
        model: ProviderModelConfig,
        options: StreamChatOptions,
        cancel_token: CancellationToken,
    ) -> impl Stream<Item = StreamChunk> + Send {
        // Create a channel to emit chunks
        let (tx, rx) = mpsc::channel::<StreamChunk>(256);
        
        // Spawn the orchestration task
        let orchestrator = self.clone();
        tokio::spawn(async move {
            orchestrator.run_orchestration(
                tx,
                provider,
                messages,
                model,
                options,
                cancel_token,
            ).await;
        });
        
        // Convert the receiver to a stream
        tokio_stream::wrappers::ReceiverStream::new(rx)
    }
    
    /// Run the orchestration loop
    async fn run_orchestration(
        &self,
        tx: mpsc::Sender<StreamChunk>,
        provider: Arc<dyn Provider>,
        mut messages: Vec<ChatMessage>,
        model: ProviderModelConfig,
        base_options: StreamChatOptions,
        cancel_token: CancellationToken,
    ) {
        // Get available tools
        let tools = self.tool_registry.get_llm_tools();
        let has_tools = !tools.is_empty();
        
        // Create options with tools
        let options = if has_tools {
            StreamChatOptions {
                tools: Some(tools),
                ..base_options.clone()
            }
        } else {
            base_options.clone()
        };
        
        for iteration in 1..=self.config.max_iterations {
            // Check cancellation
            if cancel_token.is_cancelled() {
                let _ = tx.send(StreamChunk::error("Operation cancelled", false)).await;
                break;
            }
            
            // Emit iteration status
            if self.config.emit_status && iteration > 1 {
                let _ = tx.send(StreamChunk::orchestration_status(
                    iteration,
                    self.config.max_iterations,
                    format!("Iteration {} - processing tool results", iteration),
                )).await;
            }
            
            // Stream from the provider
            let response = match provider.stream_chat(
                messages.clone(),
                model.clone(),
                options.clone(),
                cancel_token.clone(),
            ).await {
                Ok(stream) => stream,
                Err(e) => {
                    let _ = tx.send(StreamChunk::error(
                        format!("Provider error: {}", e),
                        false,
                    )).await;
                    break;
                }
            };
            
            // Collect chunks and detect tool calls
            let (tool_calls, should_continue) = self.process_stream(
                response,
                &tx,
                &cancel_token,
            ).await;
            
            if !should_continue {
                break;
            }
            
            // If no tool calls, we're done
            if tool_calls.is_empty() {
                self.logger.debug("[Orchestrator] No tool calls, completing");
                let _ = tx.send(StreamChunk::done()).await;
                break;
            }
            
            // Execute tool calls and add results to messages
            let tool_results = self.execute_tools(&tool_calls, &tx).await;
            
            // Build assistant message with tool calls
            let assistant_parts: Vec<ContentPart> = tool_calls.iter()
                .map(|tc| ContentPart::tool_use(&tc.id, &tc.name, tc.input.clone()))
                .collect();
            
            messages.push(ChatMessage {
                role: MessageRole::Assistant,
                content: MessageContent::Parts(assistant_parts),
            });
            
            // Build user message with tool results
            let result_parts: Vec<ContentPart> = tool_results.iter()
                .map(|tr| ContentPart::tool_result(&tr.call_id, &tr.content))
                .collect();
            
            messages.push(ChatMessage {
                role: MessageRole::User,
                content: MessageContent::Parts(result_parts),
            });
            
            self.logger.info(&format!(
                "[Orchestrator] Iteration {} complete, {} tool calls executed",
                iteration,
                tool_calls.len()
            ));
        }
        
        // Check if we hit max iterations
        if self.config.emit_status {
            self.logger.warn(&format!(
                "[Orchestrator] Reached max iterations ({})",
                self.config.max_iterations
            ));
        }
    }
    
    /// Process a stream from the provider, collecting tool calls
    async fn process_stream(
        &self,
        mut stream: std::pin::Pin<Box<dyn Stream<Item = Result<StreamChunk, crate::providers::ProviderError>> + Send>>,
        tx: &mpsc::Sender<StreamChunk>,
        cancel_token: &CancellationToken,
    ) -> (Vec<ToolCall>, bool) {
        let mut tool_calls: Vec<ToolCall> = Vec::new();
        let mut tool_call_deltas: std::collections::HashMap<String, (String, String)> = std::collections::HashMap::new();
        
        while let Some(result) = stream.next().await {
            // Check cancellation
            if cancel_token.is_cancelled() {
                return (tool_calls, false);
            }
            
            match result {
                Ok(chunk) => {
                    match chunk {
                        StreamChunk::Text { ref text } => {
                            // Forward text chunks directly
                            let _ = tx.send(StreamChunk::text(text)).await;
                        }
                        StreamChunk::ToolCall { ref tool_call } => {
                            // Complete tool call received
                            tool_calls.push(tool_call.clone());
                            // Also forward to UI for display
                            let _ = tx.send(chunk.clone()).await;
                        }
                        StreamChunk::ToolCallDelta { ref id, ref name, ref input_delta } => {
                            // Accumulate tool call deltas
                            let entry = tool_call_deltas
                                .entry(id.clone())
                                .or_insert_with(|| (String::new(), String::new()));
                            
                            if let Some(n) = name {
                                entry.0 = n.clone();
                            }
                            if let Some(delta) = input_delta {
                                entry.1.push_str(delta);
                            }
                            
                            // Forward to UI for streaming display
                            let _ = tx.send(chunk.clone()).await;
                        }
                        StreamChunk::Error { recoverable, .. } => {
                            let _ = tx.send(chunk).await;
                            if !recoverable {
                                return (tool_calls, false);
                            }
                        }
                        StreamChunk::Done { .. } => {
                            // Don't forward Done - we'll emit our own at the end
                        }
                        other => {
                            // Forward any other chunks
                            let _ = tx.send(other).await;
                        }
                    }
                }
                Err(e) => {
                    let _ = tx.send(StreamChunk::error(
                        format!("Stream error: {}", e),
                        false,
                    )).await;
                    return (tool_calls, false);
                }
            }
        }
        
        // Convert accumulated deltas to complete tool calls
        for (id, (name, input_str)) in tool_call_deltas {
            if !name.is_empty() {
                // Parse accumulated input as JSON
                let input: serde_json::Value = serde_json::from_str(&input_str)
                    .unwrap_or_else(|_| serde_json::json!({}));
                
                // Only add if we don't already have this tool call
                if !tool_calls.iter().any(|tc| tc.id == id) {
                    tool_calls.push(ToolCall { id, name, input });
                }
            }
        }
        
        (tool_calls, true)
    }
    
    /// Execute tool calls and return results
    async fn execute_tools(
        &self,
        tool_calls: &[ToolCall],
        tx: &mpsc::Sender<StreamChunk>,
    ) -> Vec<ToolResult> {
        let mut results = Vec::new();
        
        for call in tool_calls {
            // Emit executing status
            let _ = tx.send(StreamChunk::tool_executing(
                &call.id,
                &call.name,
                call.input.to_string(),
            )).await;
            
            // Execute the tool
            let result = self.tool_registry.execute_tool_call(call).await;
            
            // Emit result
            let _ = tx.send(StreamChunk::tool_result(
                &call.id,
                &call.name,
                &result.content,
                result.is_error,
            )).await;
            
            // Check if we should continue on error
            if result.is_error && !self.config.continue_on_error {
                self.logger.error(&format!(
                    "[Orchestrator] Tool {} failed, stopping: {}",
                    call.name,
                    result.content
                ));
                break;
            }
            
            results.push(result);
        }
        
        results
    }
    
    /// Request user approval for a tool (for future permission system)
    #[allow(dead_code)]
    async fn request_tool_approval(
        &self,
        tool_call: &ToolCall,
        tx: &mpsc::Sender<StreamChunk>,
    ) -> bool {
        let prompt_id = format!("tool-approval-{}", tool_call.id);
        
        // Emit prompt to user
        let options = vec![
            PromptOption::new("allow_once", "Allow Once"),
            PromptOption::new("allow_always", "Always Allow").with_default(true),
            PromptOption::new("deny", "Deny"),
        ];
        
        let context = serde_json::json!({
            "tool_name": tool_call.name,
            "arguments": tool_call.input,
        });
        
        let _ = tx.send(StreamChunk::user_prompt_with_context(
            &prompt_id,
            "tool_approval",
            format!("Allow tool '{}'?", tool_call.name),
            format!("The assistant wants to run the tool '{}' with the provided arguments.", tool_call.name),
            options,
            context,
        )).await;
        
        // Wait for response (this would need the prompt_response_rx)
        // For now, auto-approve
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::logging::NoOpLogger;
    
    #[test]
    fn test_orchestrator_config_defaults() {
        let config = OrchestratorConfig::default();
        assert_eq!(config.max_iterations, 10);
        assert!(config.continue_on_error);
        assert!(config.emit_status);
    }
    
    #[test]
    fn test_orchestrator_config_builder() {
        let config = OrchestratorConfig::new()
            .with_max_iterations(5)
            .with_continue_on_error(false)
            .with_emit_status(false);
        
        assert_eq!(config.max_iterations, 5);
        assert!(!config.continue_on_error);
        assert!(!config.emit_status);
    }
    
    #[test]
    fn test_prompt_channel_creation() {
        let (tx, _rx) = ChatOrchestrator::create_prompt_channel();
        assert!(tx.capacity() >= 16);
    }
}
