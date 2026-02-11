/**
 * Provider adapter - wraps multi-llm-ts engines for OpenLLM
 *
 * Maps OpenLLM provider IDs to multi-llm-ts engine names and provides
 * a unified interface for model listing and chat.
 */
import { igniteEngine, loadModels, Message, } from 'multi-llm-ts';
/**
 * Mapping from OpenLLM provider IDs to multi-llm-ts engine names
 */
const PROVIDER_ENGINE_MAP = {
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
const PROVIDER_DISPLAY_NAMES = {
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
const DEFAULT_ENV_VARS = {
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
 * Providers that don't require an API key
 */
const NO_KEY_PROVIDERS = new Set(['ollama', 'lmstudio']);
/**
 * Get all supported provider IDs
 */
export function getSupportedProviders() {
    return Object.keys(PROVIDER_ENGINE_MAP);
}
/**
 * Get display name for a provider
 */
export function getProviderDisplayName(providerId) {
    return PROVIDER_DISPLAY_NAMES[providerId] || providerId;
}
/**
 * Get default env var name for a provider
 */
export function getDefaultEnvVar(providerId) {
    return DEFAULT_ENV_VARS[providerId];
}
/**
 * Check if a provider requires an API key
 */
export function providerRequiresKey(providerId) {
    return !NO_KEY_PROVIDERS.has(providerId);
}
/**
 * Get the multi-llm-ts engine name for a provider
 */
export function getEngineName(providerId) {
    return PROVIDER_ENGINE_MAP[providerId];
}
/**
 * Fetch available models from a provider
 */
export async function fetchModels(providerId, apiKey, baseUrl) {
    const engineName = getEngineName(providerId);
    if (!engineName) {
        return [];
    }
    const config = {};
    if (apiKey)
        config.apiKey = apiKey;
    if (baseUrl)
        config.baseURL = baseUrl;
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
    }
    catch (error) {
        console.error(`[Provider] Failed to fetch models for ${providerId}:`, error.message || error);
        return [];
    }
}
/**
 * Stream a chat response from a provider
 */
export async function* streamChat(providerId, modelId, messages, apiKey, baseUrl) {
    const engineName = getEngineName(providerId);
    if (!engineName) {
        yield { type: 'done', finishReason: 'error' };
        return;
    }
    const config = {};
    if (apiKey)
        config.apiKey = apiKey;
    if (baseUrl)
        config.baseURL = baseUrl;
    const engine = igniteEngine(engineName, config);
    // Convert messages to multi-llm-ts format
    const thread = messages.map((m) => new Message(m.role, m.content));
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
    }
    catch (error) {
        console.error(`[Provider] Chat error for ${providerId}/${bareModelId}:`, error.message || error);
        yield { type: 'done', finishReason: 'error' };
    }
}
//# sourceMappingURL=adapter.js.map