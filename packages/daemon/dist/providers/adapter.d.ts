/**
 * Provider adapter - wraps multi-llm-ts engines for OpenLLM
 *
 * Maps OpenLLM provider IDs to multi-llm-ts engine names and provides
 * a unified interface for model listing and chat.
 */
import type { ModelInfo } from '../state.js';
/**
 * Get all supported provider IDs
 */
export declare function getSupportedProviders(): string[];
/**
 * Get display name for a provider
 */
export declare function getProviderDisplayName(providerId: string): string;
/**
 * Get default env var name for a provider
 */
export declare function getDefaultEnvVar(providerId: string): string | undefined;
/**
 * Check if a provider requires an API key
 */
export declare function providerRequiresKey(providerId: string): boolean;
/**
 * Get the multi-llm-ts engine name for a provider
 */
export declare function getEngineName(providerId: string): string | undefined;
/**
 * Fetch available models from a provider
 */
export declare function fetchModels(providerId: string, apiKey?: string, baseUrl?: string): Promise<ModelInfo[]>;
/**
 * Stream a chat response from a provider
 */
export declare function streamChat(providerId: string, modelId: string, messages: Array<{
    role: string;
    content: string;
}>, apiKey?: string, baseUrl?: string): AsyncGenerator<{
    type: 'text' | 'done';
    text?: string;
    finishReason?: string;
}>;
//# sourceMappingURL=adapter.d.ts.map