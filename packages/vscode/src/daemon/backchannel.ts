/**
 * VS Code Backchannel - Bidirectional gRPC stream for daemon callbacks
 * 
 * This module handles requests from the daemon to:
 * - Invoke VS Code tools (vscode.lm.tools)
 * - List/use VS Code LM models (Copilot, etc.)
 * - Access VS Code secrets
 * 
 * The backchannel is a long-lived bidirectional stream. VS Code opens the stream,
 * and the daemon pushes requests through it. VS Code sends responses back.
 */

import * as vscode from 'vscode';
import { getLogger } from '../utils/logger';
import * as proto from '../proto/openllm/v1/service';
import { DaemonClient } from './client';

const logger = getLogger();

// Our vendor ID prefix for filtering out our own models (avoid circular calls).
// All our per-provider vendors start with 'openllm-' (e.g. openllm-openrouter).
const OUR_VENDOR_PREFIX = 'openllm-';

/**
 * VS Code Backchannel Handler
 * 
 * Manages the bidirectional stream with the daemon for callbacks.
 */
export class BackchannelHandler {
    private client: DaemonClient;
    private context: vscode.ExtensionContext;
    private stream: AsyncGenerator<proto.VSCodeRequest, void, proto.VSCodeResponse> | null = null;
    private running = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    
    // Cache of VS Code LM models
    private modelCache: Map<string, vscode.LanguageModelChat> = new Map();

    /** Callback fired when daemon sends a ModelsChanged notification */
    onModelsChanged: (() => void) | null = null;

    constructor(client: DaemonClient, context: vscode.ExtensionContext) {
        this.client = client;
        this.context = context;
    }

    /**
     * Start the backchannel stream
     */
    async start(): Promise<void> {
        if (this.running) {
            return;
        }
        
        this.running = true;
        await this.connect();
    }

    /**
     * Stop the backchannel stream
     */
    async stop(): Promise<void> {
        this.running = false;
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        // Stream will be closed when we stop reading
        this.stream = null;
    }

    /**
     * Connect to the daemon's backchannel
     */
    private async connect(): Promise<void> {
        if (!this.running) {
            return;
        }

        try {
            logger.info('[Backchannel] Connecting to daemon...');
            
            const grpcClient = this.client.getClient();
            
            // Open bidirectional stream
            // Note: nice-grpc uses AsyncGenerator for bidi streams
            // We need to handle this with the nice-grpc client pattern
            await this.runBackchannelLoop(grpcClient);
            
        } catch (error) {
            logger.error('[Backchannel] Connection error:', error);
            this.scheduleReconnect();
        }
    }

    /**
     * Run the backchannel message loop
     */
    private async runBackchannelLoop(grpcClient: proto.OpenLLMClient): Promise<void> {
        try {
            // For nice-grpc bidirectional streams, we create an async generator
            // that yields our responses, and iterate over the requests
            const responseQueue: proto.VSCodeResponse[] = [];
            let resolveNext: ((value: proto.VSCodeResponse) => void) | null = null;
            
            // Create an async generator for our responses
            async function* responseGenerator(): AsyncGenerator<proto.DeepPartial<proto.VSCodeResponse>> {
                while (true) {
                    if (responseQueue.length > 0) {
                        yield responseQueue.shift()!;
                    } else {
                        // Wait for next response
                        const response = await new Promise<proto.VSCodeResponse>(resolve => {
                            resolveNext = resolve;
                        });
                        resolveNext = null;
                        yield response;
                    }
                }
            }

            // Helper to send a response
            const sendResponse = (response: proto.VSCodeResponse) => {
                if (resolveNext) {
                    resolveNext(response);
                } else {
                    responseQueue.push(response);
                }
            };

            // Open the bidirectional stream
            const requestStream = grpcClient.vSCodeStream(responseGenerator());
            
            logger.info('[Backchannel] Stream opened, listening for requests...');
            
            // Process requests from daemon
            for await (const request of requestStream) {
                if (!this.running) {
                    break;
                }
                
                try {
                    const response = await this.handleRequest(request);
                    sendResponse(response);
                } catch (error) {
                    logger.error('[Backchannel] Error handling request:', error);
                    sendResponse({
                        requestId: request.requestId,
                        error: {
                            message: error instanceof Error ? error.message : String(error),
                            code: 'INTERNAL_ERROR',
                        },
                    });
                }
            }
            
            logger.info('[Backchannel] Stream closed');
            
        } catch (error) {
            throw error;
        }
    }

    /**
     * Handle a request from the daemon
     */
    private async handleRequest(request: proto.VSCodeRequest): Promise<proto.VSCodeResponse> {
        logger.debug(`[Backchannel] Handling request: ${request.requestId}`);
        
        // Check which request type is set (new proto uses direct optional fields)
        if (request.invokeTool) {
            return this.handleInvokeTool(request.requestId, request.invokeTool);
        }
        
        if (request.listModels) {
            return this.handleListModels(request.requestId, request.listModels);
        }
        
        if (request.sendChat) {
            return this.handleSendChat(request.requestId, request.sendChat);
        }
        
        if (request.getWorkspace) {
            return this.handleGetWorkspace(request.requestId);
        }
        
        // Handle ModelsChanged push notification from daemon
        // Proto uses oneof unions: check both camelCase and the $case discriminator
        const req = request as any;
        if (req.modelsChanged || req.models_changed || req.request?.$case === 'modelsChanged') {
            const reason = req.modelsChanged?.reason || req.models_changed?.reason || req.request?.modelsChanged?.reason || 'unknown';
            logger.info(`[Backchannel] Models changed notification received (reason: ${reason})`);
            if (this.onModelsChanged) {
                this.onModelsChanged();
            }
            return { requestId: request.requestId };
        }
        
        return {
            requestId: request.requestId,
            error: { message: 'Unknown or empty request type', code: 'INVALID_REQUEST' },
        };
    }

    /**
     * Handle tool invocation request
     */
    private async handleInvokeTool(
        requestId: string,
        req: proto.InvokeToolRequest
    ): Promise<proto.VSCodeResponse> {
        logger.info(`[Backchannel] Invoking tool: ${req.toolName}`);
        
        try {
            const args = JSON.parse(req.argumentsJson || '{}');
            
            const result = await vscode.lm.invokeTool(req.toolName, {
                input: args,
                toolInvocationToken: undefined,
            }, new vscode.CancellationTokenSource().token);

            // Convert result to JSON
            const resultParts = result.content.map(part => {
                if (part instanceof vscode.LanguageModelTextPart) {
                    return { type: 'text', text: part.value };
                }
                return { type: 'unknown', data: JSON.stringify(part) };
            });

            return {
                requestId,
                invokeTool: {
                    resultJson: JSON.stringify(resultParts),
                    isError: false,
                },
            };
        } catch (error) {
            return {
                requestId,
                invokeTool: {
                    resultJson: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
                    isError: true,
                },
            };
        }
    }

    /**
     * Handle list models request
     */
    private async handleListModels(
        requestId: string,
        req: proto.ListVSCodeModelsRequest
    ): Promise<proto.VSCodeResponse> {
        logger.info('[Backchannel] Listing VS Code models');
        
        try {
            const selector: vscode.LanguageModelChatSelector = {};
            if (req.familyFilter) {
                selector.family = req.familyFilter;
            }

            const models = await vscode.lm.selectChatModels(selector);
            
            // Filter out our own models to avoid circular calls
            const externalModels = models.filter(m => !m.vendor.startsWith(OUR_VENDOR_PREFIX));
            
            // Cache models for later use
            for (const model of externalModels) {
                this.modelCache.set(model.id, model);
            }

            return {
                requestId,
                listModels: {
                    models: externalModels.map(m => ({
                        id: m.id,
                        name: m.name,
                        vendor: m.vendor,
                        family: m.family,
                        maxInputTokens: m.maxInputTokens,
                    })),
                },
            };
        } catch (error) {
            return {
                requestId,
                error: { message: error instanceof Error ? error.message : String(error), code: 'LIST_MODELS_ERROR' },
            };
        }
    }

    /**
     * Handle send chat request (to Copilot or other VS Code models)
     */
    private async handleSendChat(
        requestId: string,
        req: proto.SendVSCodeChatRequest
    ): Promise<proto.VSCodeResponse> {
        logger.info(`[Backchannel] Sending chat to model: ${req.modelId}`);
        
        try {
            // Get the model from cache or fetch it
            let model = this.modelCache.get(req.modelId);
            if (!model) {
                const models = await vscode.lm.selectChatModels({});
                model = models.find(m => m.id === req.modelId && !m.vendor.startsWith(OUR_VENDOR_PREFIX));
                if (model) {
                    this.modelCache.set(model.id, model);
                }
            }

            if (!model) {
                return {
                    requestId,
                    error: { message: `Model not found: ${req.modelId}`, code: 'MODEL_NOT_FOUND' },
                };
            }

            // Convert messages to VS Code format
            const vsMessages = req.messages.map(m => {
                switch (m.role) {
                    case proto.Role.ROLE_SYSTEM:
                    case proto.Role.ROLE_USER:
                        return vscode.LanguageModelChatMessage.User(m.content || '');
                    case proto.Role.ROLE_ASSISTANT:
                        return vscode.LanguageModelChatMessage.Assistant(m.content || '');
                    default:
                        return vscode.LanguageModelChatMessage.User(m.content || '');
                }
            });

            // Send request
            const response = await model.sendRequest(
                vsMessages,
                {},
                new vscode.CancellationTokenSource().token
            );

            // Collect chunks
            const chunks: proto.VSCodeChatChunk[] = [];
            for await (const part of response.stream) {
                if (part instanceof vscode.LanguageModelTextPart) {
                    chunks.push({ text: part.value });
                } else if (part instanceof vscode.LanguageModelToolCallPart) {
                    chunks.push({
                        toolCall: {
                            callId: part.callId,
                            name: part.name,
                            argumentsJson: JSON.stringify(part.input),
                        },
                    });
                }
            }

            return {
                requestId,
                sendChat: { chunks },
            };
        } catch (error) {
            return {
                requestId,
                error: { message: error instanceof Error ? error.message : String(error), code: 'CHAT_ERROR' },
            };
        }
    }

    /**
     * Handle get workspace request
     */
    private async handleGetWorkspace(requestId: string): Promise<proto.VSCodeResponse> {
        logger.debug('[Backchannel] Getting workspace path');
        
        const workspaceFolders = vscode.workspace.workspaceFolders;
        const workspacePath = workspaceFolders && workspaceFolders.length > 0 
            ? workspaceFolders[0].uri.fsPath 
            : '';
        const allFolders = workspaceFolders 
            ? workspaceFolders.map(f => f.uri.fsPath)
            : [];

        return {
            requestId,
            getWorkspace: {
                workspacePath,
                workspaceFolders: allFolders,
            },
        };
    }

    /**
     * Schedule a reconnection attempt
     */
    private scheduleReconnect(): void {
        if (!this.running || this.reconnectTimer) {
            return;
        }

        logger.info('[Backchannel] Scheduling reconnect in 5 seconds...');
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 5000);
    }
}
