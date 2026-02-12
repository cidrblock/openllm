import * as vscode from 'vscode';
import { DaemonClient } from '../daemon/client';
import * as proto from '../proto/openllm/v1/service';
import { getLogger } from '../utils/logger';

const logger = getLogger();

/**
 * Per-provider handler that implements LanguageModelChatProvider for a single
 * backend provider (e.g. openrouter, openai, anthropic).
 * 
 * Registered with VS Code under vendor ID `openllm-{providerId}`.
 */
class PerProviderHandler implements vscode.LanguageModelChatProvider {
    constructor(
        private providerId: string,
        private models: proto.Model[],
        private client: DaemonClient,
    ) {}

    /** Replace the cached model list (called on refresh) */
    updateModels(models: proto.Model[]): void {
        this.models = models;
    }

    async provideLanguageModelChatInformation(
        _options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        return this.models.map(model => {
            const modelId = model.id || `${model.provider}/${model.name}`;
            const contextWindow = model.capabilities?.contextWindow || 128000;

            return {
                id: modelId,
                name: model.displayName || model.name || modelId,
                family: model.provider || 'openllm',
                version: '1.0.0',
                maxInputTokens: contextWindow,
                maxOutputTokens: Math.floor(contextWindow / 4),
                capabilities: {
                    imageInput: model.capabilities?.supportsVision || false,
                    toolCalling: model.capabilities?.supportsTools || false,
                },
            };
        });
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const modelId = model.id;
        logger.debug(`[LMProvider:${this.providerId}] Chat request for model: ${modelId}`);

        const protoMessages = convertMessages(messages);

        const request: proto.DeepPartial<proto.ChatRequest> = {
            model: modelId,
            messages: protoMessages,
            options: {
                temperature: options.modelOptions?.temperature as number | undefined,
                maxTokens: options.modelOptions?.maxTokens as number | undefined,
            }
        };

        const stream = this.client.chat(request);

        token.onCancellationRequested(() => {
            logger.debug(`[LMProvider:${this.providerId}] Request cancelled`);
        });

        try {
            for await (const chunk of stream) {
                if (token.isCancellationRequested) {
                    break;
                }

                const c = chunk.chunk;
                if (!c) continue;

                switch (c.$case) {
                    case 'text': {
                        const text = c.text.text || '';
                        progress.report(new vscode.LanguageModelTextPart(text));
                        break;
                    }
                    case 'toolCall': {
                        const tc = c.toolCall;
                        progress.report(new vscode.LanguageModelToolCallPart(
                            tc.id || `call_${Date.now()}`,
                            tc.name || '',
                            JSON.parse(tc.arguments || '{}')
                        ));
                        break;
                    }
                    case 'usage':
                        logger.debug(`[LMProvider:${this.providerId}] Usage: ${JSON.stringify(c.usage)}`);
                        break;
                    case 'error':
                        logger.error(`[LMProvider:${this.providerId}] Error chunk: ${c.error.message}`);
                        throw new Error(c.error.message || 'Chat error');
                    case 'done':
                        logger.debug(`[LMProvider:${this.providerId}] Done: ${c.done.finishReason}`);
                        break;
                }
            }
        } catch (e) {
            if (!token.isCancellationRequested) {
                logger.error(`[LMProvider:${this.providerId}] Chat error:`, e);
                throw e;
            }
        }
    }

    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        let totalChars = 0;
        if (typeof text === 'string') {
            totalChars = text.length;
        } else {
            for (const part of text.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    totalChars += part.value.length;
                }
            }
        }
        return Math.ceil(totalChars / 4);
    }
}

/**
 * Manages per-provider Language Model registrations with VS Code.
 * 
 * Each backend provider (openrouter, openai, anthropic, etc.) is registered
 * as a separate vendor: `openllm-openrouter`, `openllm-openai`, etc.
 * This lets users see which underlying provider a model comes from in the
 * VS Code model picker.
 * 
 * Model refresh is driven by backchannel push notifications from the daemon
 * (no polling timer).
 */
export class OpenLLMLanguageModelProvider {
    /** vendorId → { handler, disposable } */
    private registrations = new Map<string, {
        handler: PerProviderHandler;
        disposable: vscode.Disposable;
    }>();

    constructor(private client: DaemonClient) {}

    /**
     * Start the provider - fetches models and registers per-provider vendors.
     * No polling timer is created; refresh is triggered externally via refreshModels().
     */
    async start(): Promise<void> {
        logger.info('[LMProvider] Starting OpenLLM Language Model Provider (per-provider vendors)');
        await this.refreshModels();
    }

    /**
     * Stop the provider and clean up all registrations
     */
    stop(): void {
        logger.info('[LMProvider] Stopping OpenLLM Language Model Provider');
        for (const [vendorId, reg] of this.registrations) {
            logger.info(`[LMProvider] Disposing vendor: ${vendorId}`);
            reg.disposable.dispose();
        }
        this.registrations.clear();
    }

    /**
     * Refresh the list of models from the daemon and update registrations.
     * Called on startup and whenever the daemon sends a ModelsChanged notification.
     */
    async refreshModels(): Promise<void> {
        try {
            const allModels = await this.client.listModels();
            logger.info(`[LMProvider] Fetched ${allModels.length} models from daemon`);
            this.updateRegistrations(allModels);
        } catch (e) {
            logger.error('[LMProvider] Failed to list models:', e);
        }
    }

    /**
     * Group models by provider and register/update/remove vendor registrations.
     */
    private updateRegistrations(allModels: proto.Model[]): void {
        // Group models by provider
        const byProvider = new Map<string, proto.Model[]>();
        for (const model of allModels) {
            const providerId = model.provider || 'unknown';
            if (!byProvider.has(providerId)) {
                byProvider.set(providerId, []);
            }
            byProvider.get(providerId)!.push(model);
        }

        // Track which vendors are still active
        const activeVendors = new Set<string>();

        for (const [providerId, models] of byProvider) {
            const vendorId = `openllm-${providerId}`;
            activeVendors.add(vendorId);

            const existing = this.registrations.get(vendorId);
            if (existing) {
                // Update existing handler's model list
                existing.handler.updateModels(models);
                logger.debug(`[LMProvider] Updated vendor ${vendorId} with ${models.length} models`);
            } else {
                // Register new per-provider handler
                try {
                    const handler = new PerProviderHandler(providerId, models, this.client);
                    const disposable = vscode.lm.registerLanguageModelChatProvider(vendorId, handler);
                    this.registrations.set(vendorId, { handler, disposable });
                    logger.info(`[LMProvider] Registered new vendor: ${vendorId} (${models.length} models)`);
                } catch (e) {
                    logger.error(`[LMProvider] Failed to register vendor ${vendorId}:`, e);
                }
            }
        }

        // Dispose vendors that no longer have any models
        for (const [vendorId, reg] of this.registrations) {
            if (!activeVendors.has(vendorId)) {
                logger.info(`[LMProvider] Disposing stale vendor: ${vendorId}`);
                reg.disposable.dispose();
                this.registrations.delete(vendorId);
            }
        }

        logger.info(`[LMProvider] Active vendors: ${Array.from(activeVendors).join(', ')}`);
    }
}

/**
 * Convert VS Code messages to proto format
 */
function convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): proto.Message[] {
    return messages.map(m => {
        let role: proto.Role;
        if (m.role === vscode.LanguageModelChatMessageRole.User) {
            role = proto.Role.ROLE_USER;
        } else if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
            role = proto.Role.ROLE_ASSISTANT;
        } else {
            role = proto.Role.ROLE_USER;
        }

        let textContent = '';
        for (const part of m.content) {
            if (part instanceof vscode.LanguageModelTextPart) {
                textContent += part.value;
            }
        }

        return {
            role,
            content: textContent,
            toolCalls: [],
            toolCallId: '',
            name: m.name || '',
        };
    });
}
