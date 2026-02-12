/**
 * Provider adapter - wraps multi-llm-ts engines for OpenLLM
 * 
 * The "actual" layer: engines are fixed API implementations from multi-llm-ts.
 * Virtual providers (user-defined instances) live in config/state -- not here.
 * 
 * This module consolidates all engine metadata into a single EngineInfo[] source
 * of truth, and provides fetchModels() + streamChat() that operate on engine IDs.
 */

import {
  igniteEngine,
  loadModels,
  Message,
} from 'multi-llm-ts';
import { mockStreamChat, getMockModels } from './mock.js';

// ── Engine metadata (actual layer) ─────────────────────────────────────

/**
 * Engine = actual API implementation from multi-llm-ts.
 * Fixed set, not user-configurable. This is the "actual" layer.
 */
export interface EngineInfo {
  /** Engine type identifier (e.g., "openrouter", "openai") */
  id: string;
  /** multi-llm-ts engine name (may differ from id, e.g., gemini → "google") */
  multiLlmName: string;
  /** Human-readable display name (e.g., "OpenRouter") */
  displayName: string;
  /** Whether this engine requires an API key */
  requiresKey: boolean;
  /** Default base URL (from multi-llm-ts defaults; undefined if user must set) */
  defaultBaseUrl?: string;
  /** Default environment variable for API key */
  defaultEnvVar?: string;
}

/**
 * Predefined template for the "Add Provider" wizard.
 * Essentially the engine info + a suggested instance name.
 */
export interface ProviderTemplate {
  engine: string;
  suggestedName: string;
  displayName: string;
  defaultBaseUrl?: string;
  requiresKey: boolean;
}

/**
 * Single source of truth for all engine metadata.
 * Replaces PROVIDER_ENGINE_MAP, PROVIDER_DISPLAY_NAMES, DEFAULT_ENV_VARS,
 * NO_KEY_PROVIDERS, and DEFAULT_BASE_URLS.
 * 
 * NOTE: default base URLs are duplicated from multi-llm-ts internals.
 * multi-llm-ts does not currently expose them programmatically.
 */
const ENGINES: EngineInfo[] = [
  {
    id: 'mock',
    multiLlmName: 'mock',
    displayName: 'Mock (Testing)',
    requiresKey: false,
  },
  {
    id: 'openai',
    multiLlmName: 'openai',
    displayName: 'OpenAI',
    requiresKey: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultEnvVar: 'OPENAI_API_KEY',
  },
  {
    id: 'anthropic',
    multiLlmName: 'anthropic',
    displayName: 'Anthropic',
    requiresKey: true,
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultEnvVar: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'gemini',
    multiLlmName: 'google',
    displayName: 'Google Gemini',
    requiresKey: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultEnvVar: 'GOOGLE_API_KEY',
  },
  {
    id: 'mistral',
    multiLlmName: 'mistralai',
    displayName: 'Mistral',
    requiresKey: true,
    defaultBaseUrl: 'https://api.mistral.ai',
    defaultEnvVar: 'MISTRAL_API_KEY',
  },
  {
    id: 'ollama',
    multiLlmName: 'ollama',
    displayName: 'Ollama',
    requiresKey: false,
    defaultBaseUrl: 'http://127.0.0.1:11434',
  },
  {
    id: 'azure',
    multiLlmName: 'azure',
    displayName: 'Azure OpenAI',
    requiresKey: true,
    // No default base URL — user must set
    defaultEnvVar: 'AZURE_OPENAI_API_KEY',
  },
  {
    id: 'openrouter',
    multiLlmName: 'openrouter',
    displayName: 'OpenRouter',
    requiresKey: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    defaultEnvVar: 'OPENROUTER_API_KEY',
  },
  {
    id: 'deepseek',
    multiLlmName: 'deepseek',
    displayName: 'DeepSeek',
    requiresKey: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultEnvVar: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'groq',
    multiLlmName: 'groq',
    displayName: 'Groq',
    requiresKey: true,
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    defaultEnvVar: 'GROQ_API_KEY',
  },
  {
    id: 'xai',
    multiLlmName: 'xai',
    displayName: 'xAI (Grok)',
    requiresKey: true,
    defaultBaseUrl: 'https://api.x.ai/v1',
    defaultEnvVar: 'XAI_API_KEY',
  },
  {
    id: 'cerebras',
    multiLlmName: 'cerebras',
    displayName: 'Cerebras',
    requiresKey: true,
    defaultBaseUrl: 'https://api.cerebras.ai/v1',
    defaultEnvVar: 'CEREBRAS_API_KEY',
  },
  {
    id: 'lmstudio',
    multiLlmName: 'lmstudio',
    displayName: 'LM Studio',
    requiresKey: false,
    defaultBaseUrl: 'http://localhost:1234/v1',
  },
  {
    id: 'meta',
    multiLlmName: 'meta',
    displayName: 'Meta (Llama)',
    requiresKey: true,
    defaultBaseUrl: 'https://api.llama.com/compat/v1/',
    defaultEnvVar: 'META_API_KEY',
  },
];

/** Index for O(1) lookup by engine ID */
const ENGINE_MAP = new Map<string, EngineInfo>(
  ENGINES.map(e => [e.id, e]),
);

// ── Engine accessors ───────────────────────────────────────────────────

/** Get all available engines (the fixed set of API implementations). */
export function getEngines(): EngineInfo[] {
  return ENGINES;
}

/** Get a single engine by ID, or undefined if not found. */
export function getEngine(engineId: string): EngineInfo | undefined {
  return ENGINE_MAP.get(engineId);
}

/** Get predefined templates for the "Add Provider" wizard. */
export function getProviderTemplates(): ProviderTemplate[] {
  return ENGINES.map(e => ({
    engine: e.id,
    suggestedName: e.id,
    displayName: e.displayName,
    defaultBaseUrl: e.defaultBaseUrl,
    requiresKey: e.requiresKey,
  }));
}

// ── Backward-compatible accessors (used by code not yet migrated) ──────

/** @deprecated Use getEngines() instead */
export function getSupportedProviders(): string[] {
  return ENGINES.map(e => e.id);
}

/** @deprecated Use getEngine(id)?.displayName instead */
export function getProviderDisplayName(providerId: string): string {
  return ENGINE_MAP.get(providerId)?.displayName || providerId;
}

/** @deprecated Use getEngine(id)?.defaultEnvVar instead */
export function getDefaultEnvVar(providerId: string): string | undefined {
  return ENGINE_MAP.get(providerId)?.defaultEnvVar;
}

/** @deprecated Use getEngine(id)?.defaultBaseUrl instead */
export function getDefaultBaseUrl(providerId: string): string | undefined {
  return ENGINE_MAP.get(providerId)?.defaultBaseUrl;
}

/** @deprecated Use getEngine(id)?.requiresKey === false instead */
export function providerRequiresKey(providerId: string): boolean {
  const engine = ENGINE_MAP.get(providerId);
  return engine ? engine.requiresKey : true;
}

/** @deprecated Use getEngine(id)?.multiLlmName instead */
export function getEngineName(providerId: string): string | undefined {
  return ENGINE_MAP.get(providerId)?.multiLlmName;
}

// ── Chat parameters ────────────────────────────────────────────────────

/**
 * Per-model chat parameters that can be passed through to multi-llm-ts.
 * Used for the 3-tier merge: Request > Config > Engine Default.
 */
export interface ChatParams {
  temperature?: number;
  top_p?: number;
  top_k?: number;
  maxTokens?: number;
  timeout?: number;
}

// ── Discovery model info (from engine API) ─────────────────────────────

/**
 * Model info returned from engine discovery (fetchModels).
 * This is the "actual" model — the raw data from the engine API.
 * Distinguished from the runtime ModelInfo in state.ts which is "virtual".
 */
export interface DiscoveredModel {
  /** Engine-prefixed model ID: e.g., "openrouter/anthropic/claude-opus-4.6" */
  id: string;
  /** Engine ID that discovered this model */
  engine: string;
  /** Human-readable name */
  displayName: string;
  /** Context window size (0 if unknown) */
  contextWindow: number;
  /** Model capabilities */
  capabilities?: {
    supportsTools?: boolean;
    supportsVision?: boolean;
  };
}

// ── Fetch models (actual layer) ────────────────────────────────────────

/**
 * Fetch available models from an engine.
 * Returns engine-prefixed model IDs (e.g., "openrouter/anthropic/claude-opus-4.6").
 * This operates on the "actual" layer — no virtual provider awareness.
 */
export async function fetchModels(
  engineId: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<DiscoveredModel[]> {
  // Mock engine returns static models — no network call
  if (engineId === 'mock') {
    return getMockModels().map(m => ({
      id: m.id,
      engine: 'mock',
      displayName: m.displayName,
      contextWindow: m.contextWindow || 0,
      capabilities: m.capabilities,
    }));
  }
  
  const engine = ENGINE_MAP.get(engineId);
  if (!engine) {
    return [];
  }
  
  const config: Record<string, any> = {};
  if (apiKey) config.apiKey = apiKey;
  if (baseUrl) config.baseURL = baseUrl;
  
  try {
    const modelsList = await loadModels(engine.multiLlmName, config);
    
    if (!modelsList || !modelsList.chat) {
      return [];
    }
    
    return modelsList.chat.map((m) => ({
      id: `${engineId}/${m.id}`,
      engine: engineId,
      displayName: m.name || m.id,
      contextWindow: 0,
      capabilities: {
        supportsTools: m.capabilities?.tools === true,
        supportsVision: m.capabilities?.vision === true,
      },
    }));
  } catch (error: any) {
    console.error(`[Adapter] Failed to fetch models for engine ${engineId}:`, error.message || error);
    return [];
  }
}

// ── Stream chat (actual layer) ─────────────────────────────────────────

/**
 * Stream a chat response from an engine.
 * Operates on the "actual" layer — takes engine ID and engine model ID directly.
 * The caller (state.ts) is responsible for virtual → actual resolution.
 * 
 * @param engineId - Engine type (e.g., "openrouter")
 * @param engineModelId - Actual model ID the engine expects (e.g., "anthropic/claude-opus-4.6")
 * @param messages - Chat messages
 * @param apiKey - API key (optional for keyless engines)
 * @param baseUrl - Custom base URL (optional)
 * @param params - Chat parameters (temperature, top_p, etc.) — wired to multi-llm-ts opts
 */
export async function* streamChat(
  engineId: string,
  engineModelId: string,
  messages: Array<{ role: string; content: string }>,
  apiKey?: string,
  baseUrl?: string,
  params?: ChatParams,
): AsyncGenerator<{ type: 'text' | 'done'; text?: string; finishReason?: string }> {
  // Mock engine — no network, no key, deterministic
  if (engineId === 'mock') {
    yield* mockStreamChat(engineModelId, messages);
    return;
  }
  
  const engineInfo = ENGINE_MAP.get(engineId);
  if (!engineInfo) {
    yield { type: 'done', finishReason: 'error' };
    return;
  }
  
  const config: Record<string, any> = {};
  if (apiKey) config.apiKey = apiKey;
  if (baseUrl) config.baseURL = baseUrl;
  
  const llmEngine = igniteEngine(engineInfo.multiLlmName, config);
  
  // Convert messages to multi-llm-ts format
  const thread = messages.map((m) => new Message(
    m.role as 'system' | 'user' | 'assistant',
    m.content,
  ));
  
  // Build multi-llm-ts completion options from params
  const opts: Record<string, any> = {};
  if (params?.temperature != null) opts.temperature = params.temperature;
  if (params?.top_p != null) opts.top_p = params.top_p;
  if (params?.top_k != null) opts.top_k = params.top_k;
  if (params?.maxTokens != null) opts.maxTokens = params.maxTokens;
  if (params?.timeout != null) opts.timeout = params.timeout;
  
  const hasOpts = Object.keys(opts).length > 0;
  
  let gotContent = false;
  
  try {
    for await (const chunk of llmEngine.generate(engineModelId, thread, hasOpts ? opts : undefined)) {
      if (chunk.type === 'content') {
        if (chunk.text) {
          yield { type: 'text', text: chunk.text };
          gotContent = true;
        }
        if (chunk.done) {
          yield { type: 'done', finishReason: 'stop' };
          return;
        }
      }
      // Skip tool/usage/stream chunks for now
    }
    
    // If we exited the loop without a done chunk
    if (gotContent) {
      yield { type: 'done', finishReason: 'stop' };
    }
  } catch (error: any) {
    console.error(`[Adapter] Chat error for ${engineId}/${engineModelId}:`, error.message || error);
    yield { type: 'done', finishReason: 'error' };
  }
}
