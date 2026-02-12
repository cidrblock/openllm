import * as vscode from 'vscode';
import { DaemonClient } from '../daemon/client';
import * as proto from '../proto/openllm/v1/service';
import { getLogger } from '../utils/logger';

const logger = getLogger();

/** Single vendor ID used in package.json */
const VENDOR_ID = 'openllm';

/**
 * Format the `detail` field for a model in the VS Code picker.
 * Shows engine type and any non-default parameters.
 * 
 * Example: "OpenRouter · temp=0.2, top_p=0.5"
 */
function formatDetail(model: proto.Model): string {
    const parts: string[] = [];
    
    // Engine name
    const engine = model.engine || model.provider || '';
    if (engine) parts.push(engine);
    
    // Non-default params
    const params = model.params;
    if (params) {
        const paramParts: string[] = [];
        if (params.temperature != null) paramParts.push(`temp=${params.temperature}`);
        if (params.topP != null) paramParts.push(`top_p=${params.topP}`);
        if (params.topK != null) paramParts.push(`top_k=${params.topK}`);
        if (params.maxTokens != null) paramParts.push(`max=${params.maxTokens}`);
        if (params.systemPrompt) paramParts.push('sys_prompt');
        if (paramParts.length > 0) {
            parts.push(paramParts.join(', '));
        }
    }
    
    if (parts.length === 0) return 'default';
    if (parts.length === 1 && parts[0] === engine) return `${engine} · default`;
    return parts.join(' · ');
}

/**
 * Format a detailed tooltip for hover.
 */
function formatTooltip(model: proto.Model): string {
    const lines: string[] = [];
    lines.push(`Provider: ${model.provider || 'unknown'}`);
    lines.push(`Engine: ${model.engine || 'unknown'}`);
    lines.push(`Engine Model ID: ${model.engineModelId || model.name || model.id}`);
    if (model.capabilities?.contextWindow) {
        lines.push(`Context Window: ${model.capabilities.contextWindow.toLocaleString()}`);
    }
    const params = model.params;
    if (params) {
        if (params.temperature != null) lines.push(`Temperature: ${params.temperature}`);
        if (params.topP != null) lines.push(`Top P: ${params.topP}`);
        if (params.topK != null) lines.push(`Top K: ${params.topK}`);
        if (params.maxTokens != null) lines.push(`Max Tokens: ${params.maxTokens}`);
        if (params.timeout != null) lines.push(`Timeout: ${params.timeout}ms`);
        if (params.systemPrompt) lines.push(`System Prompt: ${params.systemPrompt.substring(0, 50)}...`);
    }
    return lines.join('\n');
}

/**
 * Single handler for the `openllm` vendor.
 * All virtual models from all virtual providers are served through this one handler.
 * The `family` field provides grouping by virtual provider in the picker.
 */
class OpenLLMHandler implements vscode.LanguageModelChatProvider {
    constructor(
        private readonly models: proto.Model[],
        private readonly client: DaemonClient,
    ) {}

    async provideLanguageModelChatInformation(
        _options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        logger.info(`[LMProvider] provideLanguageModelChatInformation called (${this.models.length} models)`);
        const result = this.models.map(model => {
            const compositeId = model.id || `${model.provider}/${model.name}`;
            const virtualName = model.name || model.displayName || compositeId;
            const contextWindow = model.capabilities?.contextWindow || 128000;

            const info = {
                id: compositeId,                              // Routing key: "work-openrouter/claude-opus-precise"
                name: virtualName,                            // Display: "claude-opus-precise"
                family: model.provider || 'openllm',          // Grouping: "work-openrouter"
                detail: formatDetail(model),                  // "OpenRouter · temp=0.2, top_p=0.5"
                tooltip: formatTooltip(model),                // Full details on hover
                version: '1.0.0',
                maxInputTokens: contextWindow,
                maxOutputTokens: Math.floor(contextWindow / 4),
                capabilities: {
                    imageInput: model.capabilities?.supportsVision || false,
                    toolCalling: model.capabilities?.supportsTools || false,
                },
            };
            logger.info(`[LMProvider]   → id="${info.id}" name="${info.name}" family="${info.family}" detail="${info.detail}"`);
            return info;
        });
        return result;
    }

    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Use the composite ID for routing to the daemon
        const compositeId = model.id;
        logger.debug(`[LMProvider] Chat request for model: ${compositeId}`);

        const protoMessages = convertMessages(messages);

        const request: proto.DeepPartial<proto.ChatRequest> = {
            model: compositeId,
            messages: protoMessages,
            options: {
                temperature: options.modelOptions?.temperature as number | undefined,
                maxTokens: options.modelOptions?.maxTokens as number | undefined,
            }
        };

        const stream = this.client.chat(request);

        token.onCancellationRequested(() => {
            logger.debug(`[LMProvider] Request cancelled for ${compositeId}`);
        });

        try {
            for await (const chunk of stream) {
                if (token.isCancellationRequested) break;

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
                        logger.debug(`[LMProvider] Usage: ${JSON.stringify(c.usage)}`);
                        break;
                    case 'error':
                        logger.error(`[LMProvider] Error chunk: ${c.error.message}`);
                        throw new Error(c.error.message || 'Chat error');
                    case 'done':
                        logger.debug(`[LMProvider] Done: ${c.done.finishReason}`);
                        break;
                }
            }
        } catch (e) {
            if (!token.isCancellationRequested) {
                logger.error('[LMProvider] Chat error:', e);
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
 * Manages the single `openllm` Language Model registration with VS Code.
 * 
 * All virtual models across all virtual providers are served through one vendor.
 * The `family` field on each model provides visual grouping by virtual provider
 * in the VS Code picker (e.g., "work-openrouter: claude-opus-precise").
 * 
 * Model refresh is driven by backchannel push notifications from the daemon.
 */
export class OpenLLMLanguageModelProvider {
    private handler: OpenLLMHandler | null = null;
    private disposable: vscode.Disposable | null = null;

    constructor(private client: DaemonClient) {}

    /**
     * Start the provider - fetches models and registers the single vendor.
     */
    async start(): Promise<void> {
        logger.info('[LMProvider] Starting OpenLLM Language Model Provider (single vendor)');
        await this.refreshModels();
        logger.info('[LMProvider] Language Model Provider started');
    }

    /**
     * Stop the provider and clean up registration
     */
    stop(): void {
        logger.info('[LMProvider] Stopping OpenLLM Language Model Provider');
        if (this.disposable) {
            this.disposable.dispose();
            this.disposable = null;
        }
        this.handler = null;
    }

    /**
     * Refresh the list of models from the daemon and update the registration.
     * Called on startup and whenever the daemon sends a ModelsChanged notification.
     * 
     * Always disposes and re-registers to force VS Code to re-call
     * provideLanguageModelChatInformation and pick up changes.
     */
    async refreshModels(): Promise<void> {
        try {
            const allModels = await this.client.listModels();
            logger.info(`[LMProvider] Fetched ${allModels.length} models from daemon`);

            // Log each model for debugging
            for (const m of allModels) {
                logger.info(`[LMProvider]   model: id=${m.id}, name=${m.name}, provider=${m.provider}, engine=${m.engine}`);
            }

            // Always dispose + re-register so VS Code picks up the new model list
            if (this.disposable) {
                this.disposable.dispose();
                this.disposable = null;
            }
            this.handler = new OpenLLMHandler(allModels, this.client);
            this.disposable = vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, this.handler);
            logger.info(`[LMProvider] Registered vendor: ${VENDOR_ID} (${allModels.length} models)`);

            // Log summary by family (virtual provider)
            const byFamily = new Map<string, number>();
            for (const m of allModels) {
                const family = m.provider || 'unknown';
                byFamily.set(family, (byFamily.get(family) || 0) + 1);
            }
            const summary = Array.from(byFamily.entries())
                .map(([f, c]) => `${f}(${c})`)
                .join(', ');
            logger.info(`[LMProvider] Models by provider: ${summary || 'none'}`);
        } catch (e) {
            logger.error('[LMProvider] Failed to list models:', e);
        }
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
