import * as vscode from 'vscode';
import { ConfigManager } from './config/ConfigManager';
import { ProviderRegistry } from './registry/ProviderRegistry';
import { OpenLLMProvider } from './core/OpenLLMProvider';
import { StatusPanel } from './ui/StatusPanel';
import { PlaygroundPanel } from './ui/PlaygroundPanel';
import { ChatViewProvider } from './ui/ChatViewProvider';
import { ApiKeyPanel } from './ui/ApiKeyPanel';
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
    chatViewProvider = new ChatViewProvider(
      context.extensionUri,
      openLLMProvider,
      context.globalState
    );
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
      const modelCount = configManager.getModelCount();
      const providerCount = configManager.getProviderCount();
      const providers = configManager.getConfiguredProviders();
      logger.info(`Activated with ${modelCount} models from ${providerCount} providers: ${providers.join(', ')}`);
      vscode.window.showInformationMessage(
        `Open LLM: ${modelCount} models from ${providerCount} provider${providerCount !== 1 ? 's' : ''}`
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
          'No models configured. Would you like to configure providers?',
          'Configure Providers',
          'Cancel'
        );
        if (action === 'Configure Providers') {
          vscode.commands.executeCommand('openLLM.configureApiKeys');
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

  // Reload configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.reloadConfig', async () => {
      await configManager.reload();
      provider.reloadModels();
      updateStatusBar(provider);
      const modelCount = configManager.getModelCount();
      const providerCount = configManager.getProviderCount();
      vscode.window.showInformationMessage(
        `Open LLM: ${modelCount} models from ${providerCount} provider${providerCount !== 1 ? 's' : ''}`
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

  // Configure API keys
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.configureApiKeys', () => {
      ApiKeyPanel.createOrShow(context);
    })
  );

  // Focus chat panel
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.focusChat', () => {
      vscode.commands.executeCommand('openLLM.chatView.focus');
    })
  );

  // Send message to chat UI (for external extensions)
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.chat.send', async (args?: {
      message: string;
      context?: Array<{ path: string; name: string; language: string; content: string }>;
      newSession?: boolean;
    }) => {
      if (!args?.message) {
        vscode.window.showErrorMessage('Open LLM: No message provided to openLLM.chat.send');
        return;
      }
      
      await chatProvider.sendMessage(args.message, {
        context: args.context,
        newSession: args.newSession
      });
    })
  );

  // List available tools (for debugging)
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.listTools', async () => {
      const tools = vscode.lm.tools;
      const logger = getLogger();
      
      logger.info(`Total tools available: ${tools.length}`);
      
      if (tools.length === 0) {
        vscode.window.showInformationMessage('No tools registered in vscode.lm.tools');
        return;
      }
      
      const output = vscode.window.createOutputChannel('Open LLM Tools');
      output.clear();
      output.appendLine(`=== Available VS Code LM Tools (${tools.length}) ===\n`);
      
      tools.forEach(t => {
        output.appendLine(`📦 ${t.name}`);
        output.appendLine(`   Description: ${t.description || 'None'}`);
        try {
          const schemaStr = t.inputSchema ? JSON.stringify(t.inputSchema, null, 2) : 'No schema';
          const schemaLines = schemaStr.split('\n');
          output.appendLine(`   Schema: ${schemaLines[0]}`);
          for (let i = 1; i < schemaLines.length; i++) {
            output.appendLine(`           ${schemaLines[i]}`);
          }
        } catch {
          output.appendLine(`   Schema: [Could not serialize]`);
        }
        output.appendLine('');
      });
      
      output.show();
      
      vscode.window.showInformationMessage(`Found ${tools.length} tools. See Output panel for details.`);
    })
  );

  // Clear chat history
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.clearChat', () => {
      chatProvider.clearChat();
    })
  );

  // Move chat to right (secondary sidebar)
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.moveChatToRight', () => {
      vscode.commands.executeCommand('openLLM.chatView.focus');
      vscode.commands.executeCommand('workbench.action.moveViewToSecondarySideBar');
    })
  );

  // Move chat to left (primary sidebar)
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.moveChatToLeft', () => {
      vscode.commands.executeCommand('openLLM.chatView.focus');
      vscode.commands.executeCommand('workbench.action.moveViewToSideBar');
    })
  );

  // Move chat to panel (bottom)
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.moveChatToPanel', () => {
      vscode.commands.executeCommand('openLLM.chatView.focus');
      vscode.commands.executeCommand('workbench.action.moveViewToPanel');
    })
  );
}

async function showFirstTimeSetup(): Promise<void> {
  const selection = await vscode.window.showInformationMessage(
    'Welcome to Open LLM Provider! Configure your API keys to get started.',
    'Configure Providers',
    'Later'
  );

  if (selection === 'Configure Providers') {
    vscode.commands.executeCommand('openLLM.configureApiKeys');
  }
}
