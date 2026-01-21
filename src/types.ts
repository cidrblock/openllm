import * as vscode from 'vscode';

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
 */
export interface ProviderConfig {
  /** Provider name */
  name: string;
  /** API key or template variable */
  apiKey?: string;
  /** Custom API base URL */
  apiBase?: string;
  /** List of model names to expose */
  models: string[];
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
 * Content part for multi-modal messages
 */
export interface ContentPart {
  type: 'text' | 'image';
  text?: string;
  imageUrl?: string;
}

/**
 * Streaming chat request
 */
export interface StreamChatRequest {
  messages: ChatMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
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
