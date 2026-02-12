/**
 * Provider adapter - wraps multi-llm-ts engines for OpenLLM
 * 
 * Maps OpenLLM provider IDs to multi-llm-ts engine names and provides
 * a unified interface for model listing and chat.
 */

import {
  igniteEngine,
  loadModels,
  Message,
} from 'multi-llm-ts';
import type { ModelInfo } from '../state.js';
import { mockStreamChat, getMockModels } from './mock.js';

/**
 * Mapping from OpenLLM provider IDs to multi-llm-ts engine names
 */
const PROVIDER_ENGINE_MAP: Record<string, string> = {
  mock: 'mock',        // Built-in mock provider (no network, no key)
  openai: 'openai',
  anthropic: 'anthropic',
  gemini: 'google',
  mistral: 'mistralai',
  ollama: 'ollama',
  azure: 'azure',
  openrouter: 'openrouter',
  deepseek: 'deepseek',
  groq: 'groq',
  xai: 'xai',
  cerebras: 'cerebras',
  lmstudio: 'lmstudio',
  meta: 'meta',
};

/**
 * Provider display names
 */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  mock: 'Mock (Testing)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  mistral: 'Mistral',
  ollama: 'Ollama',
  azure: 'Azure OpenAI',
  openrouter: 'OpenRouter',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  xai: 'xAI (Grok)',
  cerebras: 'Cerebras',
  lmstudio: 'LM Studio',
  meta: 'Meta (Llama)',
};

/**
 * Default environment variable names for API keys
 */
const DEFAULT_ENV_VARS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  groq: 'GROQ_API_KEY',
  xai: 'XAI_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  meta: 'META_API_KEY',
};

/**
 * Default base URLs per provider.
 * 
 * NOTE: multi-llm-ts does not currently expose default base URLs programmatically —
 * each provider class hardcodes its own default internally. This static map duplicates
 * those values. A future improvement would be to have multi-llm-ts export a
 * getDefaultBaseUrl(engine) function so we don't have to maintain a parallel list.
 */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  mistral: 'https://api.mistral.ai',
  ollama: 'http://127.0.0.1:11434',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  xai: 'https://api.x.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  lmstudio: 'http://localhost:1234/v1',
  meta: 'https://api.llama.com/compat/v1/',
  // azure: no default — must be set by user
  // mock: no network calls
};

/**
 * Providers that don't require an API key
 */
const NO_KEY_PROVIDERS = new Set(['mock', 'ollama', 'lmstudio']);

/**
 * Get all supported provider IDs
 */
export function getSupportedProviders(): string[] {
  return Object.keys(PROVIDER_ENGINE_MAP);
}

/**
 * Get display name for a provider
 */
export function getProviderDisplayName(providerId: string): string {
  return PROVIDER_DISPLAY_NAMES[providerId] || providerId;
}

/**
 * Get default env var name for a provider
 */
export function getDefaultEnvVar(providerId: string): string | undefined {
  return DEFAULT_ENV_VARS[providerId];
}

/**
 * Get the default base URL for a provider (undefined if none / not applicable)
 */
export function getDefaultBaseUrl(providerId: string): string | undefined {
  return DEFAULT_BASE_URLS[providerId];
}

/**
 * Check if a provider requires an API key
 */
export function providerRequiresKey(providerId: string): boolean {
  return !NO_KEY_PROVIDERS.has(providerId);
}

/**
 * Get the multi-llm-ts engine name for a provider
 */
export function getEngineName(providerId: string): string | undefined {
  return PROVIDER_ENGINE_MAP[providerId];
}

/**
 * Fetch available models from a provider
 */
export async function fetchModels(
  providerId: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<ModelInfo[]> {
  // Mock provider returns static models — no network call
  if (providerId === 'mock') {
    return getMockModels();
  }
  
  const engineName = getEngineName(providerId);
  if (!engineName) {
    return [];
  }
  
  const config: Record<string, any> = {};
  if (apiKey) config.apiKey = apiKey;
  if (baseUrl) config.baseURL = baseUrl;
  
  try {
    const modelsList = await loadModels(engineName, config);
    
    if (!modelsList || !modelsList.chat) {
      return [];
    }
    
    return modelsList.chat.map((m) => ({
      id: `${providerId}/${m.id}`,
      provider: providerId,
      displayName: m.name || m.id,
      contextWindow: 0,
      capabilities: {
        supportsTools: m.capabilities?.tools === true,
        supportsVision: m.capabilities?.vision === true,
      },
    }));
  } catch (error: any) {
    console.error(`[Provider] Failed to fetch models for ${providerId}:`, error.message || error);
    return [];
  }
}

/**
 * Stream a chat response from a provider
 */
export async function* streamChat(
  providerId: string,
  modelId: string,
  messages: Array<{ role: string; content: string }>,
  apiKey?: string,
  baseUrl?: string,
): AsyncGenerator<{ type: 'text' | 'done'; text?: string; finishReason?: string }> {
  // Mock provider — no network, no key, deterministic
  if (providerId === 'mock') {
    yield* mockStreamChat(modelId, messages);
    return;
  }
  
  const engineName = getEngineName(providerId);
  if (!engineName) {
    yield { type: 'done', finishReason: 'error' };
    return;
  }
  
  const config: Record<string, any> = {};
  if (apiKey) config.apiKey = apiKey;
  if (baseUrl) config.baseURL = baseUrl;
  
  const engine = igniteEngine(engineName, config);
  
  // Convert messages to multi-llm-ts format
  const thread = messages.map((m) => new Message(
    m.role as 'system' | 'user' | 'assistant',
    m.content,
  ));
  
  // Strip the OpenLLM provider prefix (first segment only) from model ID.
  // e.g. "openrouter/anthropic/claude-3-haiku" -> "anthropic/claude-3-haiku"
  // But "openai/gpt-4o" -> "gpt-4o"
  const bareModelId = modelId;
  
  let gotContent = false;
  
  try {
    for await (const chunk of engine.generate(bareModelId, thread)) {
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
    console.error(`[Provider] Chat error for ${providerId}/${bareModelId}:`, error.message || error);
    yield { type: 'done', finishReason: 'error' };
  }
}
