import * as vscode from 'vscode';
import { ConfigManager } from '../config/ConfigManager';
import { ProviderRegistry } from '../registry/ProviderRegistry';
import { ModelConfig, ConnectionTestResult } from '../types';
import { getLogger } from '../utils/logger';

/**
 * Main Language Model Provider that integrates with VS Code's LM API
 */
export class OpenLLMProvider {
  private configManager: ConfigManager;
  private providerRegistry: ProviderRegistry;
  private logger = getLogger();
  private disposables: vscode.Disposable[] = [];

  constructor(
    configManager: ConfigManager,
    providerRegistry: ProviderRegistry
  ) {
    this.configManager = configManager;
    this.providerRegistry = providerRegistry;

    // Listen for configuration changes
    this.disposables.push(
      configManager.onDidChange(() => {
        this.logger.info('Configuration changed, models updated');
      })
    );
  }

  /**
   * Get all available model information for registration
   */
  getLanguageModelInformation(): Array<{
    id: string;
    name: string;
    family: string;
    version: string;
    maxInputTokens: number;
    vendor: string;
  }> {
    const models = this.configManager.getModels();
    
    return models.map(model => ({
      id: model.id,
      name: model.name,
      family: this.getFamilyFromProvider(model.provider),
      version: '1.0.0',
      maxInputTokens: model.contextLength || 8192,
      vendor: 'open-llm',
    }));
  }

  /**
   * Send a chat request to the specified model
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

    this.logger.info(`Sending request to ${model.provider}/${model.model}`);

    try {
      return await provider.streamChat(messages, model, options, token);
    } catch (error) {
      throw this.handleError(error, model);
    }
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

  /**
   * Reload models from configuration
   */
  reloadModels(): void {
    this.providerRegistry.clearInstances();
    this.logger.info('Provider instances cleared');
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
    this.disposables.forEach(d => d.dispose());
  }
}
