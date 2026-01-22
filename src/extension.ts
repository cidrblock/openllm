import * as vscode from 'vscode';
import { ConfigManager } from './config/ConfigManager';
import { ProviderRegistry } from './registry/ProviderRegistry';
import { OpenLLMProvider } from './core/OpenLLMProvider';
import { StatusPanel } from './ui/StatusPanel';
import { PlaygroundPanel } from './ui/PlaygroundPanel';
import { ChatViewProvider } from './ui/ChatViewProvider';
import { getLogger, updateLogLevel, disposeLogger } from './utils/logger';

let openLLMProvider: OpenLLMProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let chatViewProvider: ChatViewProvider | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const logger = getLogger();
  logger.info('Open LLM Provider activating...');

  try {
    // Initialize configuration manager
    const configManager = new ConfigManager(context);
    await configManager.initialize();
    context.subscriptions.push(configManager);

    // Initialize provider registry
    const providerRegistry = new ProviderRegistry();

    // Create the main provider
    openLLMProvider = new OpenLLMProvider(configManager, providerRegistry);
    context.subscriptions.push(openLLMProvider);

    // Register the Chat sidebar webview
    chatViewProvider = new ChatViewProvider(context.extensionUri, openLLMProvider);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        ChatViewProvider.viewType,
        chatViewProvider
      )
    );
    
    // Register commands
    registerCommands(context, configManager, openLLMProvider, providerRegistry, chatViewProvider);

    // Create status bar item
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    updateStatusBar(openLLMProvider);
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Watch for configuration changes to update log level
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('openLLM.logLevel')) {
          updateLogLevel();
        }
      })
    );

    // Watch for model changes to update status bar
    context.subscriptions.push(
      configManager.onDidChange(() => {
        updateStatusBar(openLLMProvider!);
        vscode.window.showInformationMessage(
          `Open LLM: Configuration reloaded (${openLLMProvider!.getModelCount()} models)`
        );
      })
    );

    // Check configuration and show first-time setup if needed
    if (!configManager.hasValidConfiguration()) {
      showFirstTimeSetup();
    } else {
      const modelCount = openLLMProvider.getModelCount();
      logger.info(`Activated with ${modelCount} models`);
      vscode.window.showInformationMessage(
        `Open LLM Provider activated with ${modelCount} models`
      );
    }

    logger.info('Open LLM Provider activated successfully');
  } catch (error) {
    logger.error('Failed to activate Open LLM Provider:', error);
    vscode.window.showErrorMessage(
      `Failed to activate Open LLM Provider: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export function deactivate() {
  const logger = getLogger();
  logger.info('Open LLM Provider deactivating...');
  
  if (openLLMProvider) {
    openLLMProvider.dispose();
  }
  
  disposeLogger();
}

function updateStatusBar(provider: OpenLLMProvider): void {
  if (!statusBarItem) {
    return;
  }
  
  const count = provider.getModelCount();
  statusBarItem.text = `$(sparkle) Open LLM`;
  statusBarItem.tooltip = `${count} model${count !== 1 ? 's' : ''} available\nClick to show models`;
  statusBarItem.command = 'openLLM.showModels';
}

function registerCommands(
  context: vscode.ExtensionContext,
  configManager: ConfigManager,
  provider: OpenLLMProvider,
  registry: ProviderRegistry,
  chatProvider: ChatViewProvider
): void {
  // Show available models
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.showModels', async () => {
      const models = provider.getAvailableModels();
      
      if (models.length === 0) {
        const action = await vscode.window.showInformationMessage(
          'No models configured. Would you like to add a provider?',
          'Add Provider',
          'Cancel'
        );
        if (action === 'Add Provider') {
          vscode.commands.executeCommand('openLLM.addProvider');
        }
        return;
      }

      const items = models.map(m => ({
        label: m.name,
        description: m.provider,
        detail: `Context: ${m.contextLength.toLocaleString()} tokens`,
        model: m,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Available LLM Models',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        vscode.window.showInformationMessage(`Selected: ${selected.label}`);
      }
    })
  );

  // Add provider
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.addProvider', async () => {
      const metadata = registry.getProviderMetadata();
      
      const providerItems = metadata.map(p => ({
        label: p.displayName,
        description: p.requiresApiKey ? 'Requires API key' : 'No API key required',
        detail: p.defaultModels.length > 0 
          ? `Models: ${p.defaultModels.map(m => m.name).join(', ')}`
          : 'Configure deployment name',
        provider: p,
      }));

      const selected = await vscode.window.showQuickPick(providerItems, {
        placeHolder: 'Select a provider to add',
      });

      if (!selected) {
        return;
      }

      const provider = selected.provider;

      // Get API key if required
      let apiKey: string | undefined;
      if (provider.requiresApiKey) {
        apiKey = await vscode.window.showInputBox({
          prompt: `Enter your ${provider.displayName} API key`,
          password: true,
          placeHolder: 'sk-...',
          ignoreFocusOut: true,
        });

        if (!apiKey) {
          return;
        }

        // Store the API key securely
        await configManager.storeApiKey(provider.id, apiKey);
      }

      // Get API base if it's Azure
      let apiBase: string | undefined;
      if (provider.id === 'azure') {
        apiBase = await vscode.window.showInputBox({
          prompt: 'Enter your Azure OpenAI endpoint URL',
          placeHolder: 'https://your-resource.openai.azure.com',
          ignoreFocusOut: true,
        });

        if (!apiBase) {
          return;
        }
      }

      // Select models
      let selectedModels: string[] = [];
      
      if (provider.defaultModels.length > 0) {
        const modelItems = provider.defaultModels.map(m => ({
          label: m.name,
          description: `${m.contextLength.toLocaleString()} tokens`,
          picked: false,
          modelId: m.id,
        }));

        const pickedModels = await vscode.window.showQuickPick(modelItems, {
          placeHolder: 'Select models to enable',
          canPickMany: true,
        });

        if (!pickedModels || pickedModels.length === 0) {
          return;
        }

        selectedModels = pickedModels.map(m => m.modelId);
      } else {
        // For Azure, ask for deployment name
        const deploymentName = await vscode.window.showInputBox({
          prompt: 'Enter your Azure deployment name',
          placeHolder: 'gpt-4-deployment',
          ignoreFocusOut: true,
        });

        if (!deploymentName) {
          return;
        }

        selectedModels = [deploymentName];
      }

      // Update VS Code settings
      const config = vscode.workspace.getConfiguration('openLLM');
      const providers = config.get<Array<{
        name: string;
        apiKey?: string;
        apiBase?: string;
        models: string[];
      }>>('providers', []);

      // Check if provider already exists
      const existingIndex = providers.findIndex(p => p.name === provider.id);
      
      // Build the secret reference string (e.g., ${{ secrets.OPENAI_API_KEY }})
      const secretRef = apiKey 
        ? '${{ secrets.' + provider.id.toUpperCase() + '_API_KEY }}'
        : undefined;

      const newProvider = {
        name: provider.id,
        apiKey: secretRef,
        apiBase,
        models: selectedModels,
      };

      if (existingIndex >= 0) {
        providers[existingIndex] = newProvider;
      } else {
        providers.push(newProvider);
      }

      await config.update('providers', providers, vscode.ConfigurationTarget.Global);

      vscode.window.showInformationMessage(
        'Added ' + provider.displayName + ' with ' + selectedModels.length + ' model(s)'
      );
    })
  );

  // Configure (open settings)
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.configure', async () => {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'openLLM'
      );
    })
  );

  // Reload configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.reloadConfig', async () => {
      await configManager.reload();
      provider.reloadModels();
      updateStatusBar(provider);
      vscode.window.showInformationMessage('Configuration reloaded');
    })
  );

  // Test connections
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.testConnection', async () => {
      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Testing provider connections...',
          cancellable: false,
        },
        async () => {
          return await provider.testConnections();
        }
      );

      if (result.total === 0) {
        vscode.window.showWarningMessage('No providers configured to test');
        return;
      }

      const message = 'Tested ' + result.total + ' model(s): ' + result.successful + ' successful, ' + result.failed + ' failed';
      
      if (result.failed > 0) {
        const showDetails = await vscode.window.showWarningMessage(
          message,
          'Show Details'
        );
        
        if (showDetails) {
          const details = result.details
            .filter(d => !d.success)
            .map(d => '- ' + d.provider + '/' + d.model + ': ' + d.error)
            .join('\n');
          
          vscode.window.showErrorMessage('Failed connections:\n' + details);
        }
      } else {
        vscode.window.showInformationMessage(message);
      }
    })
  );

  // Import from Continue
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.importFromContinue', async () => {
      const config = vscode.workspace.getConfiguration('openLLM');
      const currentValue = config.get<boolean>('importContinueConfig', true);
      
      if (!currentValue) {
        await config.update('importContinueConfig', true, vscode.ConfigurationTarget.Global);
      }
      
      await configManager.reload();
      provider.reloadModels();
      updateStatusBar(provider);
      
      const modelCount = provider.getModelCount();
      vscode.window.showInformationMessage(
        `Imported Continue configuration (${modelCount} models available)`
      );
    })
  );

  // Send chat message (for testing/demo)
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.sendMessage', async () => {
      const models = provider.getAvailableModels();
      
      if (models.length === 0) {
        vscode.window.showErrorMessage('No models configured');
        return;
      }

      // Select model
      const modelItems = models.map(m => ({
        label: m.name,
        description: m.provider,
        modelId: m.id,
      }));

      const selectedModel = await vscode.window.showQuickPick(modelItems, {
        placeHolder: 'Select a model',
      });

      if (!selectedModel) {
        return;
      }

      // Get message
      const message = await vscode.window.showInputBox({
        prompt: 'Enter your message',
        placeHolder: 'Hello!',
      });

      if (!message) {
        return;
      }

      // Send request
      const outputChannel = vscode.window.createOutputChannel('Open LLM Response');
      outputChannel.show();
      outputChannel.appendLine(`Model: ${selectedModel.label}`);
      outputChannel.appendLine(`Message: ${message}`);
      outputChannel.appendLine('---');
      outputChannel.appendLine('Response:');

      try {
        const messages = [vscode.LanguageModelChatMessage.User(message)];
        const tokenSource = new vscode.CancellationTokenSource();
        
        const stream = await provider.sendRequest(
          selectedModel.modelId,
          messages,
          {},
          tokenSource.token
        );

        for await (const chunk of stream) {
          outputChannel.append(chunk);
        }

        outputChannel.appendLine('');
        outputChannel.appendLine('---');
        outputChannel.appendLine('Done');
      } catch (error) {
        outputChannel.appendLine(`Error: ${error instanceof Error ? error.message : String(error)}`);
        vscode.window.showErrorMessage(
          `Request failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  // Show status panel
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.showStatusPanel', () => {
      StatusPanel.createOrShow(
        context.extensionUri,
        configManager,
        registry,
        provider
      );
    })
  );

  // Show playground
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.showPlayground', () => {
      PlaygroundPanel.createOrShow(
        context.extensionUri,
        configManager,
        provider
      );
    })
  );

  // Focus chat panel
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.focusChat', () => {
      vscode.commands.executeCommand('openLLM.chatView.focus');
    })
  );

  // Clear chat history
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.clearChat', () => {
      chatProvider.clearChat();
    })
  );
}

async function showFirstTimeSetup(): Promise<void> {
  const selection = await vscode.window.showInformationMessage(
    'Welcome to Open LLM Provider! Configure your first provider to get started.',
    'Add Provider',
    'Import from Continue',
    'Later'
  );

  if (selection === 'Add Provider') {
    vscode.commands.executeCommand('openLLM.addProvider');
  } else if (selection === 'Import from Continue') {
    vscode.commands.executeCommand('openLLM.importFromContinue');
  }
}
