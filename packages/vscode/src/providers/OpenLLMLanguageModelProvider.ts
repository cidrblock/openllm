import * as vscode from 'vscode';
import { DaemonClient } from '../daemon/client';
import * as proto from '../proto/openllm/v1/service';
import { getLogger } from '../utils/logger';

const logger = getLogger();

// Vendor ID must match the one declared in package.json
const VENDOR_ID = 'openllm';

/**
 * Implements the VS Code LanguageModelChatProvider interface.
 * This allows other extensions (like Copilot Chat) to use OpenLLM models.
 */
export class OpenLLMLanguageModelProvider implements vscode.LanguageModelChatProvider {
    private disposable: vscode.Disposable | null = null;
    private cachedModels: proto.Model[] = [];
    private refreshInterval: NodeJS.Timeout | null = null;

    constructor(private client: DaemonClient) {}

    /**
     * Start the provider - registers with VS Code and begins model refresh
     */
    async start(): Promise<void> {
        logger.info('[LMProvider] Starting OpenLLM Language Model Provider');
        
        // Initial model fetch
        await this.refreshModels();
        
        // Register the provider with VS Code
        try {
            this.disposable = vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, this);
            logger.info(`[LMProvider] Registered as vendor: ${VENDOR_ID}`);
        } catch (e) {
            logger.error('[LMProvider] Failed to register:', e);
        }
        
        // Periodically refresh models (every 60 seconds)
        this.refreshInterval = setInterval(() => {
            this.refreshModels().catch(e => {
                logger.warn('[LMProvider] Failed to refresh models:', e);
            });
        }, 60000);
    }

    /**
     * Stop the provider and clean up
     */
    stop(): void {
        logger.info('[LMProvider] Stopping OpenLLM Language Model Provider');
        
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        
        if (this.disposable) {
            this.disposable.dispose();
            this.disposable = null;
        }
    }

    /**
     * Refresh the list of models from the daemon
     */
    async refreshModels(): Promise<void> {
        try {
            this.cachedModels = await this.client.listModels();
            logger.info(`[LMProvider] Cached ${this.cachedModels.length} models from daemon`);
        } catch (e) {
            logger.error('[LMProvider] Failed to list models:', e);
        }
    }

    /**
     * Provide information about available models.
     * Called by VS Code to get the list of models this provider offers.
     */
    async provideLanguageModelChatInformation(
        options: { silent: boolean },
        _token: vscode.CancellationToken
    ): Promise<vscode.LanguageModelChatInformation[]> {
        logger.debug(`[LMProvider] provideLanguageModelChatInformation called (silent: ${options.silent})`);
        
        // Refresh models if cache is empty and not silent mode
        if (this.cachedModels.length === 0 && !options.silent) {
            await this.refreshModels();
        }

        return this.cachedModels.map(model => {
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

    /**
     * Handle a chat request.
     * Called by VS Code when an extension wants to use one of our models.
     */
    async provideLanguageModelChatResponse(
        model: vscode.LanguageModelChatInformation,
        messages: readonly vscode.LanguageModelChatRequestMessage[],
        options: vscode.ProvideLanguageModelChatResponseOptions,
        progress: vscode.Progress<vscode.LanguageModelResponsePart>,
        token: vscode.CancellationToken
    ): Promise<void> {
        const modelId = model.id;
        logger.debug(`[LMProvider] Chat request for model: ${modelId}`);
        
        // Convert VS Code messages to proto format
        const protoMessages = this.convertMessages(messages);
        
        // Build chat request
        const request: proto.DeepPartial<proto.ChatRequest> = {
            model: modelId,
            messages: protoMessages,
            options: {
                temperature: options.modelOptions?.temperature as number | undefined,
                maxTokens: options.modelOptions?.maxTokens as number | undefined,
            }
        };

        // Stream response from daemon
        const stream = this.client.chat(request);
        
        // Handle cancellation
        token.onCancellationRequested(() => {
            logger.debug('[LMProvider] Request cancelled');
        });

        try {
            for await (const chunk of stream) {
                if (token.isCancellationRequested) {
                    break;
                }
                
                // Handle different chunk types
                if (chunk.text) {
                    const text = chunk.text.text || '';
                    progress.report(new vscode.LanguageModelTextPart(text));
                } else if (chunk.toolCall) {
                    const tc = chunk.toolCall;
                    progress.report(new vscode.LanguageModelToolCallPart(
                        tc.id || `call_${Date.now()}`,
                        tc.name || '',
                        JSON.parse(tc.arguments || '{}')
                    ));
                } else if (chunk.usage) {
                    logger.debug(`[LMProvider] Usage: ${JSON.stringify(chunk.usage)}`);
                }
            }
        } catch (e) {
            if (!token.isCancellationRequested) {
                logger.error(`[LMProvider] Chat error:`, e);
                throw e;
            }
        }
    }

    /**
     * Provide token count for messages.
     * Called by VS Code to help manage context windows.
     */
    async provideTokenCount(
        _model: vscode.LanguageModelChatInformation,
        text: string | vscode.LanguageModelChatRequestMessage,
        _token: vscode.CancellationToken
    ): Promise<number> {
        // Rough estimation: ~4 characters per token on average
        let totalChars = 0;
        
        if (typeof text === 'string') {
            totalChars = text.length;
        } else {
            // It's a LanguageModelChatRequestMessage
            for (const part of text.content) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    totalChars += part.value.length;
                }
            }
        }
        
        return Math.ceil(totalChars / 4);
    }

    /**
     * Convert VS Code messages to proto format
     */
    private convertMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): proto.Message[] {
        return messages.map(m => {
            let role: proto.Role;
            if (m.role === vscode.LanguageModelChatMessageRole.User) {
                role = proto.Role.ROLE_USER;
            } else if (m.role === vscode.LanguageModelChatMessageRole.Assistant) {
                role = proto.Role.ROLE_ASSISTANT;
            } else {
                role = proto.Role.ROLE_USER;
            }

            // Extract text content
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
}
