import * as vscode from 'vscode';
import { ConfigManager } from '../config/ConfigManager';
import { ProviderRegistry } from '../registry/ProviderRegistry';
import { ModelConfig, ConnectionTestResult } from '../types';
import { getLogger } from '../utils/logger';

/**
 * Main Language Model Provider that implements vscode.LanguageModelChatProvider
 * This allows our models to appear in vscode.lm alongside Copilot models
 */
export class OpenLLMProvider implements vscode.LanguageModelChatProvider {
  private configManager: ConfigManager;
  private providerRegistry: ProviderRegistry;
  private logger = getLogger();
  private disposables: vscode.Disposable[] = [];
  private registration: vscode.Disposable | undefined;

  constructor(
    configManager: ConfigManager,
    providerRegistry: ProviderRegistry
  ) {
    this.configManager = configManager;
    this.providerRegistry = providerRegistry;

    // Register with VS Code's Language Model API
    this.register();

    // Re-register when configuration changes
    this.disposables.push(
      configManager.onDidChange(() => {
        this.logger.info('Configuration changed, re-registering models');
        this.register();
      })
    );
  }

  /**
   * Register this provider with vscode.lm
   */
  private register(): void {
    // Dispose previous registration
    if (this.registration) {
      this.registration.dispose();
    }

    try {
      // Register using the vendor ID from package.json
      this.registration = vscode.lm.registerLanguageModelChatProvider('open-llm', this);
      this.logger.info('Registered with vscode.lm as vendor "open-llm"');
    } catch (error) {
      this.logger.error('Failed to register with vscode.lm:', error);
    }
  }

  /**
   * Provide information about available models
   * Called by VS Code to discover what models this provider offers
   */
  provideLanguageModelChatInformation(
    _options: { silent: boolean },
    _token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    const models = this.configManager.getModels();
    
    this.logger.debug(`provideLanguageModelChatInformation called, returning ${models.length} models`);

    return models.map(model => ({
      id: model.id,
      name: model.name,
      tooltip: `${model.provider}/${model.model} via Open LLM Provider`,
      family: this.getFamilyFromProvider(model.provider),
      maxInputTokens: model.contextLength || 8192,
      maxOutputTokens: 4096,
      version: '1.0.0',
      capabilities: {
        toolCalling: false, // TODO: detect from model config
        imageInput: false,  // TODO: detect from model config
      }
    }));
  }

  /**
   * Handle chat requests from VS Code
   * This is called when extensions use vscode.lm.sendRequest() with our models
   */
  async provideLanguageModelChatResponse(
    modelInfo: vscode.LanguageModelChatInformation,
    messages: vscode.LanguageModelChatMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const model = this.configManager.getModel(modelInfo.id);
    
    if (!model) {
      throw new Error(`Model not found: ${modelInfo.id}`);
    }

    if (!model.apiKey && model.provider.toLowerCase() !== 'ollama') {
      throw new Error(`No API key configured for ${model.provider}/${model.model}`);
    }

    const provider = this.providerRegistry.getProvider(model.provider);
    
    if (!provider) {
      throw new Error(`Unsupported provider: ${model.provider}`);
    }

    this.logger.info(`provideLanguageModelChatResponse: ${model.provider}/${model.model}`);

    try {
      const stream = await provider.streamChat(
        messages,
        model,
        {
          // Extract options if available
          temperature: undefined,
          maxTokens: undefined,
        },
        token
      );

      for await (const chunk of stream) {
        if (token.isCancellationRequested) {
          break;
        }
        progress.report(new vscode.LanguageModelTextPart(chunk));
      }
    } catch (error) {
      throw this.handleError(error, model);
    }
  }

  /**
   * Provide token count for a message
   */
  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    // Simple approximation: ~4 chars per token
    const content = typeof text === 'string' ? text : 
      text.content.map(p => p instanceof vscode.LanguageModelTextPart ? p.value : '').join('');
    return Math.ceil(content.length / 4);
  }

  /**
   * Get the model family from provider name
   */
  private getFamilyFromProvider(provider: string): string {
    const familyMap: Record<string, string> = {
      'openai': 'gpt',
      'anthropic': 'claude',
      'google': 'gemini',
      'gemini': 'gemini',
      'ollama': 'local',
      'mistral': 'mistral',
      'azure': 'azure-gpt',
      'azure-openai': 'azure-gpt',
    };
    return familyMap[provider.toLowerCase()] || provider;
  }

  /**
   * Handle and transform errors for better user experience
   */
  private handleError(error: unknown, model: ModelConfig): Error {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      
      if (message.includes('401') || message.includes('unauthorized') || message.includes('authentication')) {
        return new Error(`Authentication failed for ${model.provider}. Please check your API key.`);
      }
      
      if (message.includes('429') || message.includes('rate limit')) {
        return new Error(`Rate limit exceeded for ${model.provider}. Please try again later.`);
      }
      
      if (message.includes('404') || message.includes('not found')) {
        return new Error(`Model ${model.model} not found in ${model.provider}. Please check the model name.`);
      }
      
      if (message.includes('500') || message.includes('internal server error')) {
        return new Error(`${model.provider} service error. Please try again later.`);
      }
      
      if (message.includes('econnrefused') || message.includes('network')) {
        return new Error(`Cannot connect to ${model.provider}. Please check your network connection.`);
      }
      
      return error;
    }
    
    return new Error(`Unknown error: ${String(error)}`);
  }

  // ========== Legacy methods for direct access (used by Playground fallback) ==========

  /**
   * Send a chat request directly (for Playground when vscode.lm isn't available)
   */
  async sendRequest(
    modelId: string,
    messages: vscode.LanguageModelChatMessage[],
    options: {
      temperature?: number;
      maxTokens?: number;
      stop?: string[];
    },
    token: vscode.CancellationToken
  ): Promise<AsyncIterable<string>> {
    const model = this.configManager.getModel(modelId);
    
    if (!model) {
      throw new Error(`Model not found: ${modelId}`);
    }

    if (!model.apiKey && model.provider.toLowerCase() !== 'ollama') {
      throw new Error(`No API key configured for ${model.provider}/${model.model}`);
    }

    const provider = this.providerRegistry.getProvider(model.provider);
    
    if (!provider) {
      throw new Error(`Unsupported provider: ${model.provider}`);
    }

    this.logger.info(`Direct sendRequest: ${model.provider}/${model.model}`);

    try {
      return await provider.streamChat(messages, model, options, token);
    } catch (error) {
      throw this.handleError(error, model);
    }
  }

  /**
   * Reload models from configuration
   */
  reloadModels(): void {
    this.providerRegistry.clearInstances();
    this.register();
    this.logger.info('Provider instances cleared and models re-registered');
  }

  /**
   * Get the count of available models
   */
  getModelCount(): number {
    return this.configManager.getModelCount();
  }

  /**
   * Get all available models with metadata
   */
  getAvailableModels(): Array<{
    id: string;
    name: string;
    provider: string;
    contextLength: number;
    description: string;
  }> {
    return this.configManager.getModels().map(m => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      contextLength: m.contextLength || 8192,
      description: `${m.provider}/${m.model}`,
    }));
  }

  /**
   * Test connections to all configured providers
   */
  async testConnections(): Promise<ConnectionTestResult> {
    const models = this.configManager.getModels();
    const details: ConnectionTestResult['details'] = [];
    let successful = 0;
    let failed = 0;

    for (const model of models) {
      try {
        const provider = this.providerRegistry.getProvider(model.provider);
        if (!provider) {
          details.push({
            provider: model.provider,
            model: model.model,
            success: false,
            error: 'Provider not supported',
          });
          failed++;
          continue;
        }

        // Create a simple test message
        const testMessages: vscode.LanguageModelChatMessage[] = [
          vscode.LanguageModelChatMessage.User('Hello'),
        ];

        // Use a short timeout for testing
        const tokenSource = new vscode.CancellationTokenSource();
        const timeout = setTimeout(() => tokenSource.cancel(), 10000);

        try {
          const stream = await provider.streamChat(
            testMessages,
            model,
            { maxTokens: 10 },
            tokenSource.token
          );

          // Just read first chunk to verify connection
          for await (const chunk of stream) {
            if (chunk) {
              break;
            }
          }

          details.push({
            provider: model.provider,
            model: model.model,
            success: true,
          });
          successful++;
        } finally {
          clearTimeout(timeout);
          tokenSource.dispose();
        }
      } catch (error) {
        details.push({
          provider: model.provider,
          model: model.model,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
        failed++;
      }
    }

    return {
      total: models.length,
      successful,
      failed,
      details,
    };
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    if (this.registration) {
      this.registration.dispose();
    }
    this.disposables.forEach(d => d.dispose());
  }
}
