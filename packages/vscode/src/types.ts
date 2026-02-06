import * as vscode from 'vscode';

// ============================================================================
// Core Interfaces (previously from @openllm/core, now local)
// ============================================================================

/**
 * Cancellation token interface
 */
export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): void;
}

/**
 * Logger interface
 */
export interface ILogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ============================================================================
// Model Configuration
// ============================================================================

/**
 * Configuration for an individual model
 */
export interface ModelConfig {
  /** Unique identifier for this model configuration */
  id: string;
  /** Display name for the model */
  name: string;
  /** Provider name (openai, anthropic, google, ollama, etc.) */
  provider: string;
  /** Model identifier as used by the provider's API */
  model: string;
  /** API key for authentication */
  apiKey?: string;
  /** Custom API base URL */
  apiBase?: string;
  /** Roles this model can fulfill */
  roles: string[];
  /** Maximum context length in tokens */
  contextLength?: number;
  /** Model capabilities */
  capabilities?: ModelCapabilities;
}

/**
 * Model capabilities
 */
export interface ModelCapabilities {
  /** Whether the model supports image input */
  imageInput?: boolean;
  /** Whether the model supports tool/function calling */
  toolCalling?: boolean;
  /** Whether the model supports streaming */
  streaming?: boolean;
}

/**
 * Provider configuration from VS Code settings
 * 
 * Note: API keys are NOT stored here. They are resolved from:
 * 1. VS Code SecretStorage (managed by Providers and Models webview)
 * 2. Environment variables (e.g., OPENAI_API_KEY, ANTHROPIC_API_KEY)
 */
export interface ProviderConfig {
  /** Provider name (e.g., 'openai', 'anthropic', 'openrouter') */
  name: string;
  /** Whether this provider is enabled (default: true) */
  enabled?: boolean;
  /** Custom API base URL (optional, uses provider default if not set) */
  apiBase?: string;
  /** List of model names to expose */
  models: string[];
  /** Internal tracking: where this config came from */
  _source?: string;
  /** Internal tracking: detailed source description */
  _sourceDetail?: string;
}

/**
 * Result of a connection test
 */
export interface ConnectionTestResult {
  /** Total number of providers tested */
  total: number;
  /** Number of successful connections */
  successful: number;
  /** Number of failed connections */
  failed: number;
  /** Details for each provider */
  details: Array<{
    provider: string;
    model: string;
    success: boolean;
    error?: string;
  }>;
}

/**
 * Chat message for LLM requests
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
}

/**
 * Content part for multi-modal and tool messages
 */
export interface ContentPart {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  imageUrl?: string;
  // Tool use fields (assistant calling a tool)
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  // Tool result fields (returning tool output)
  tool_use_id?: string;
  content?: string;
}

/**
 * Tool definition (matches vscode.LanguageModelChatTool)
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Tool call from the LLM
 */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result to send back to LLM
 */
export interface ToolResult {
  callId: string;
  content: string;
  isError?: boolean;
}

/**
 * Streaming chunk types
 */
export type StreamChunk = 
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_call_delta'; id: string; name?: string; inputDelta?: string };

/**
 * Streaming chat request
 */
export interface StreamChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: Tool[];
  toolChoice?: 'auto' | 'none' | 'required';
}

/**
 * Provider metadata
 */
export interface ProviderMetadata {
  /** Provider identifier */
  id: string;
  /** Display name */
  displayName: string;
  /** Default API base URL */
  defaultApiBase: string;
  /** Whether API key is required */
  requiresApiKey: boolean;
  /** Supported models with their context lengths */
  defaultModels: Array<{
    id: string;
    name: string;
    contextLength: number;
    capabilities: ModelCapabilities;
  }>;
}

/**
 * Logger interface
 */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/**
 * Extension context with typed secrets
 */
export type ExtensionSecrets = vscode.SecretStorage;
