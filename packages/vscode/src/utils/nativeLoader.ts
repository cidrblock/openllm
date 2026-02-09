/**
 * Native module loader for @openllm/native
 * Handles loading the native bindings in both development and production (bundled) contexts.
 */

import * as path from 'path';

let nativeModule: any = null;

// Use eval to prevent esbuild from bundling this require
const dynamicRequire = eval('require');

/**
 * Get the native OpenLLM bindings.
 * In development, loads from node_modules.
 * In production (bundled), loads from the out/native directory.
 * 
 * @returns The native module (typed as any for backward compatibility)
 */
export function getNative(): any {
  if (nativeModule) {
    return nativeModule;
  }

  try {
    // Try loading from the bundled location first (production)
    const bundledPath = path.join(__dirname, 'native', 'index.js');
    nativeModule = dynamicRequire(bundledPath);
    return nativeModule;
  } catch {
    // Fall back to node_modules (development)
    try {
      nativeModule = dynamicRequire('@openllm/native');
      return nativeModule;
    } catch (e) {
      throw new Error(`Failed to load @openllm/native: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Get the native OpenLLM bindings with full type information.
 * Returns null if native module is not available.
 * 
 * Use this for new code that needs proper typing.
 */
export function getNativeTyped(): NativeModule | null {
  try {
    return getNative() as NativeModule;
  } catch {
    return null;
  }
}

// Type definitions for the native module exports
export interface NativeSecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<string[]>;
}

export interface NativeProviderConfig {
  name: string;
  enabled: boolean;
  apiBase?: string;
  models: string[];
}

export interface NativeFileConfigProvider {
  path: string;
  level: 'user' | 'workspace';
  exists(): boolean;
  getProviders(): Promise<NativeProviderConfig[]>;
  addProvider(config: NativeProviderConfig): Promise<void>;
  updateProvider(name: string, config: NativeProviderConfig): Promise<void>;
  removeProvider(name: string): Promise<void>;
  importProviders(providers: NativeProviderConfig[]): Promise<void>;
}

// MCP Endpoint types
export interface NativeMcpEndpoint {
  name: string;
  socketPath: string;
  httpUrl?: string;
}

// Stream chunk from Rust orchestrator
export interface NativeStreamChunk {
  // Chunk type - may be 'type' or 'chunkType' depending on the source
  type?: string;
  chunkType?: string;
  // Text content
  text?: string;
  // Tool call fields (may have different naming conventions)
  toolId?: string;
  toolCallId?: string;
  toolName?: string;
  toolArguments?: string;
  toolInputDelta?: string;
  // Tool result fields
  toolResult?: string;
  isError?: boolean;
  // Orchestration status
  iteration?: number;
  maxIterations?: number;
  message?: string;
  recoverable?: boolean;
  // Prompt fields
  promptId?: string;
  promptType?: string;
  title?: string;
  options?: Array<{ id: string; label: string; isDefault?: boolean }>;
  context?: unknown;
  summary?: string;
}

// Orchestrator configuration
export interface NativeOrchestratorConfig {
  maxIterations?: number;
  continueOnError?: boolean;
  emitStatus?: boolean;
}

// Tool Registry class
export interface NativeToolRegistryClass {
  new(): NativeToolRegistry;
}

export interface NativeToolRegistry {
  connectToMcp(): void;
  refresh(): Promise<void>;
  toolCount: number;
  enabledToolCount: number;
  setToolEnabled(name: string, enabled: boolean): void;
}

// Chat Orchestrator class
export interface NativeChatOrchestratorClass {
  new(config?: NativeOrchestratorConfig): NativeChatOrchestrator;
  withToolRegistry(
    toolRegistry: NativeToolRegistry,
    config?: NativeOrchestratorConfig
  ): NativeChatOrchestrator;
}

export interface NativeChatOrchestrator {
  streamChat(
    messages: Array<{ role: string; content: string }>,
    config: {
      /** Provider ID (e.g., "openai", "anthropic", "vscode") */
      provider: string;
      /** Model name (e.g., "gpt-4o", "claude-3-5-sonnet-20241022") */
      model: string;
      /** API key for authentication (optional for some providers) */
      apiKey?: string;
      /** Custom API base URL (optional) */
      apiBase?: string;
    },
    options: {
      tools?: Array<{
        name: string;
        description: string;
        inputSchema?: string;
      }>;
      temperature?: number;
      maxTokens?: number;
      stop?: string[];
    } | null,
    callback: (chunk: NativeStreamChunk) => void
  ): Promise<void>;
}

// Configuration for the simple chat() function
export interface NativeChatConfig {
  /** Provider ID (e.g., "openai", "anthropic", "vscode") */
  provider: string;
  /** Model name (e.g., "gpt-4o", "claude-3-5-sonnet-20241022") */
  model: string;
  /** API key for authentication (optional for some providers) */
  apiKey?: string;
  /** Custom API base URL (optional) */
  apiBase?: string;
  /** Maximum tool calling iterations (default: 10) */
  maxToolIterations?: number;
  /** Whether to include tools from MCP (default: true if MCP is registered) */
  enableTools?: boolean;
}

// Full native module interface
export interface NativeModule {
  // === Simple Chat API (recommended) ===
  
  /** 
   * Unified chat function - the simplest way to chat with any LLM.
   * Handles provider creation, MCP tools, and orchestration automatically.
   */
  chat?(
    messages: Array<{ role: string; content: string }>,
    config: NativeChatConfig,
    callback: (chunk: NativeStreamChunk) => void
  ): Promise<void>;
  
  // === MCP Endpoint Registration ===
  registerMcpEndpoint?(endpoint: NativeMcpEndpoint): void;
  unregisterMcpEndpoint?(name: string): boolean;
  hasMcpEndpoint?(name: string): boolean;
  getMcpSocketPath?(name: string): string | null;
  
  // === Advanced API (for flexibility) ===
  
  // Tool Registry
  ToolRegistry?: NativeToolRegistryClass;
  
  // Chat Orchestrator
  ChatOrchestrator?: NativeChatOrchestratorClass;
  
  // Debug
  getDebugLogPath?(): string;
  
  // Other native exports can be added here
  [key: string]: unknown;
}
