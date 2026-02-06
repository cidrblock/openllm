import * as vscode from 'vscode';
import { ConfigManager } from './config/ConfigManager';
import { ProviderRegistry } from './registry/ProviderRegistry';
import { OpenLLMProvider } from './core/OpenLLMProvider';
import { StatusPanel } from './ui/StatusPanel';
import { PlaygroundPanel } from './ui/PlaygroundPanel';
import { ChatViewProvider } from './ui/ChatViewProvider';
import { ApiKeyPanel } from './ui/ApiKeyPanel';
import { getLogger, updateLogLevel, disposeLogger } from './utils/logger';
import { getNative } from './utils/nativeLoader';
import { RpcServer } from './rpc';
import { McpToolServer } from './mcp';

let openLLMProvider: OpenLLMProvider | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let chatViewProvider: ChatViewProvider | undefined;
let rpcServer: RpcServer | undefined;
let mcpToolServer: McpToolServer | undefined;

export async function activate(context: vscode.ExtensionContext) {
  const logger = getLogger();
  logger.info('Open LLM Provider activating...');

  // Log the Rust debug log path so user knows where to look
  try {
    const native = getNative();
    if (native && typeof native.getDebugLogPath === 'function') {
      const debugLogPath = native.getDebugLogPath();
      logger.info(`[DEBUG] Rust debug log: ${debugLogPath}`);
      // Note: Don't clear the log on activation - it's useful for debugging across reloads
    }
  } catch (e) {
    // Ignore if not available
  }

  try {
    // Start JSON-RPC server FIRST - before ConfigManager
    // This ensures the RPC endpoint is available when ConfigManager initializes
    try {
      rpcServer = new RpcServer(context, logger);
      const rpcInfo = await rpcServer.start();
      logger.info(`[RPC] Server started on ${rpcInfo.socketPath}`);
      
      // Register the endpoint with openllm-core native bindings if available
      try {
        const native = getNative();
        if (native && typeof native.registerRpcEndpoint === 'function') {
          native.registerRpcEndpoint({
            name: 'vscode',
            socketPath: rpcInfo.socketPath,
            authToken: rpcInfo.authToken,
            capabilities: ['secrets', 'config', 'workspace'],
          });
          logger.info('[RPC] Registered endpoint with openllm-core');
        }
      } catch (e) {
        // Native bindings may not have RPC support yet
        logger.info('[RPC] Native RPC registration not available (will be added later)');
      }
      
      // Add cleanup to subscriptions
      context.subscriptions.push({
        dispose: async () => {
          await rpcServer?.stop();
        }
      });
    } catch (e) {
      logger.error('[RPC] Failed to start server:', e);
      // Non-fatal - extension can work without RPC
    }

    // Start MCP Tool Server (official MCP SDK)
    // This exposes VS Code tools and internal tools via MCP protocol
    try {
      mcpToolServer = new McpToolServer(context);
      const mcpInfo = await mcpToolServer.start();
      logger.info(`[MCP] Tool server started on ${mcpInfo.socketPath}`);
      
      // Register the MCP endpoint with openllm-core native bindings
      try {
        const native = getNative();
        if (native && typeof native.registerMcpEndpoint === 'function') {
          native.registerMcpEndpoint({
            name: 'vscode-tools',
            socketPath: mcpInfo.socketPath,
            httpUrl: mcpInfo.httpUrl,
          });
          logger.info('[MCP] Registered tool server with openllm-core');
        }
      } catch (e) {
        // Native MCP support may not be available yet
        logger.info('[MCP] Native MCP registration not available yet');
      }
      
      // Add cleanup to subscriptions
      context.subscriptions.push({
        dispose: async () => {
          await mcpToolServer?.stop();
        }
      });
    } catch (e) {
      logger.error('[MCP] Failed to start tool server:', e);
      // Non-fatal - tool orchestration can work without MCP
    }

    // Initialize configuration manager (now RPC endpoint is available)
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

    // Watch for model changes to update status bar and chat view
    context.subscriptions.push(
      configManager.onDidChange(() => {
        updateStatusBar(openLLMProvider!);
        // Refresh chat models when config changes
        chatViewProvider?.refreshModels();
        vscode.window.showInformationMessage(
          `Open LLM: Configuration reloaded (${openLLMProvider!.getModelCount()} models)`
        );
        // Notify RPC clients of config change
        rpcServer?.notifyConfigChanged('user');
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

export async function deactivate() {
  const logger = getLogger();
  logger.info('Open LLM Provider deactivating...');
  
  // Stop MCP tool server
  if (mcpToolServer) {
    try {
      await mcpToolServer.stop();
      logger.info('[MCP] Tool server stopped');
    } catch (e) {
      logger.error('[MCP] Error stopping tool server:', e);
    }
    mcpToolServer = undefined;
  }
  
  // Stop RPC server
  if (rpcServer) {
    try {
      await rpcServer.stop();
      logger.info('[RPC] Server stopped');
    } catch (e) {
      logger.error('[RPC] Error stopping server:', e);
    }
    rpcServer = undefined;
  }
  
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
        placeHolder: 'Select a model for Chat',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (selected) {
        // Set the model in the chat view
        const modelId = `direct:${selected.model.id}`;
        if (chatProvider.setModel(modelId)) {
          vscode.window.showInformationMessage(`Chat model set to: ${selected.label}`);
          // Focus the chat view
          vscode.commands.executeCommand('openLLM.chatView.focus');
        } else {
          vscode.window.showWarningMessage(`Could not set model: ${selected.label}`);
        }
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

  // Export config to native YAML
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.exportConfig', async () => {
      try {
        const native = getNative();
        const config = vscode.workspace.getConfiguration('openLLM');
        const providers = config.get<Array<{ name: string; enabled?: boolean; apiBase?: string; models?: string[] }>>('providers', []);
        
        if (providers.length === 0) {
          vscode.window.showWarningMessage('No providers configured in VS Code settings');
          return;
        }

        // Ask user: workspace or user level?
        const level = await vscode.window.showQuickPick(
          [
            { label: 'Workspace', description: '.config/openllm/config.yaml in current workspace', value: 'workspace' },
            { label: 'User', description: '~/.config/openllm/config.yaml (shared across all projects)', value: 'user' }
          ],
          { placeHolder: 'Export to...' }
        );

        if (!level) {
          return;
        }

        // Create FileConfigProvider
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const fileConfig = level.value === 'workspace' && workspaceRoot
          ? native.FileConfigProvider.workspace(workspaceRoot)
          : native.FileConfigProvider.user();

        // Backup existing file
        let backupPath: string | undefined;
        if (fileConfig.exists()) {
          backupPath = fileConfig.backup();
        }

        // Convert VS Code providers to native format
        const nativeProviders = providers.map((p: any) => ({
          name: p.name,
          enabled: p.enabled !== false,
          apiBase: p.apiBase || undefined,
          models: p.models || []
        }));

        // Import to native config
        fileConfig.importProviders(nativeProviders);

        const message = backupPath
          ? `Config exported to ${fileConfig.path}\n(backup: ${backupPath})`
          : `Config exported to ${fileConfig.path}`;
        
        vscode.window.showInformationMessage(message);
        getLogger().info(`Exported ${providers.length} providers to ${fileConfig.path}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        getLogger().error('Export config failed:', error);
      }
    })
  );

  // Import config from native YAML
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.importConfig', async () => {
      try {
        const native = getNative();
        
        // Ask user: workspace or user level?
        const level = await vscode.window.showQuickPick(
          [
            { label: 'Workspace', description: '.config/openllm/config.yaml in current workspace', value: 'workspace' },
            { label: 'User', description: '~/.config/openllm/config.yaml (shared across all projects)', value: 'user' }
          ],
          { placeHolder: 'Import from...' }
        );

        if (!level) {
          return;
        }

        // Create FileConfigProvider
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const fileConfig = level.value === 'workspace' && workspaceRoot
          ? native.FileConfigProvider.workspace(workspaceRoot)
          : native.FileConfigProvider.user();

        if (!fileConfig.exists()) {
          vscode.window.showWarningMessage(`Config file not found: ${fileConfig.path}`);
          return;
        }

        // Get providers from native config
        const nativeProviders = await fileConfig.getProviders();
        
        if (nativeProviders.length === 0) {
          vscode.window.showWarningMessage('No providers in native config file');
          return;
        }

        // Convert to VS Code format
        const vscodeProviders = nativeProviders.map((p: any) => ({
          name: p.name,
          enabled: p.enabled,
          ...(p.apiBase && { apiBase: p.apiBase }),
          models: p.models
        }));

        // Update VS Code settings (this will replace existing providers)
        const config = vscode.workspace.getConfiguration('openLLM');
        await config.update('providers', vscodeProviders, vscode.ConfigurationTarget.Global);

        vscode.window.showInformationMessage(`Imported ${nativeProviders.length} providers from ${fileConfig.path}`);
        getLogger().info(`Imported ${nativeProviders.length} providers from ${fileConfig.path}`);
        
        // Reload to apply changes
        await configManager.reload();
        provider.reloadModels();
      } catch (error) {
        vscode.window.showErrorMessage(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
        getLogger().error('Import config failed:', error);
      }
    })
  );

  // Export config to native YAML with optional level (shows QuickPick if not provided)
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.exportConfigTo', async (level?: 'user' | 'workspace') => {
      try {
        const native = getNative();
        const config = vscode.workspace.getConfiguration('openLLM');
        const providers = config.get<Array<{ name: string; enabled?: boolean; apiBase?: string; models?: string[] }>>('providers', []);
        
        if (providers.length === 0) {
          vscode.window.showWarningMessage('No providers configured in VS Code settings');
          return;
        }

        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        
        // Show QuickPick if level not provided
        if (!level) {
          const items: vscode.QuickPickItem[] = [
            { label: 'User', description: '~/.config/openllm/config.yaml', detail: 'Available globally across all projects' },
          ];
          if (workspaceRoot) {
            items.push({ label: 'Workspace', description: '.config/openllm/config.yaml', detail: 'Specific to this workspace' });
          }
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Export to which location?',
            title: 'Export Configuration'
          });
          if (!picked) { return; }
          level = picked.label.toLowerCase() as 'user' | 'workspace';
        }
        
        if (level === 'workspace' && !workspaceRoot) {
          vscode.window.showErrorMessage('No workspace folder open');
          return;
        }

        const fileConfig = level === 'workspace' && workspaceRoot
          ? native.FileConfigProvider.workspace(workspaceRoot)
          : native.FileConfigProvider.user();

        // Backup existing file
        let backupPath: string | undefined;
        if (fileConfig.exists()) {
          backupPath = fileConfig.backup();
        }

        // Convert VS Code providers to native format
        const nativeProviders = providers.map((p: any) => ({
          name: p.name,
          enabled: p.enabled !== false,
          apiBase: p.apiBase || undefined,
          models: p.models || []
        }));

        fileConfig.importProviders(nativeProviders);

        const message = backupPath
          ? `Config exported to ${fileConfig.path} (backup created)`
          : `Config exported to ${fileConfig.path}`;
        
        vscode.window.showInformationMessage(message);
        getLogger().info(`Exported ${providers.length} providers to ${fileConfig.path}`);
      } catch (error) {
        vscode.window.showErrorMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        getLogger().error('Export config failed:', error);
      }
    })
  );

  // Import config from native YAML with optional level (shows QuickPick if not provided)
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.importConfigFrom', async (level?: 'user' | 'workspace') => {
      try {
        const native = getNative();
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        
        // Show QuickPick if level not provided
        if (!level) {
          const items: vscode.QuickPickItem[] = [];
          
          // Check which config files exist
          const userConfig = native.FileConfigProvider.user();
          const workspaceConfig = workspaceRoot ? native.FileConfigProvider.workspace(workspaceRoot) : null;
          
          if (userConfig.exists()) {
            items.push({ label: 'User', description: '~/.config/openllm/config.yaml', detail: 'Import from user config' });
          }
          if (workspaceConfig?.exists()) {
            items.push({ label: 'Workspace', description: '.config/openllm/config.yaml', detail: 'Import from workspace config' });
          }
          
          if (items.length === 0) {
            vscode.window.showWarningMessage('No OpenLLM config files found');
            return;
          }
          
          const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Import from which location?',
            title: 'Import Configuration'
          });
          if (!picked) { return; }
          level = picked.label.toLowerCase() as 'user' | 'workspace';
        }
        
        if (level === 'workspace' && !workspaceRoot) {
          vscode.window.showErrorMessage('No workspace folder open');
          return;
        }

        const fileConfig = level === 'workspace' && workspaceRoot
          ? native.FileConfigProvider.workspace(workspaceRoot)
          : native.FileConfigProvider.user();

        if (!fileConfig.exists()) {
          vscode.window.showWarningMessage(`No config file found at ${fileConfig.path}`);
          return;
        }

        const nativeProviders = await fileConfig.getProviders();
        
        if (nativeProviders.length === 0) {
          vscode.window.showWarningMessage('No providers found in native config');
          return;
        }

        // Convert to VS Code format
        const vscodeProviders = nativeProviders.map((p: any) => ({
          name: p.name,
          enabled: p.enabled,
          apiBase: p.apiBase || undefined,
          models: p.models || []
        }));

        const config = vscode.workspace.getConfiguration('openLLM');
        await config.update('providers', vscodeProviders, vscode.ConfigurationTarget.Global);

        vscode.window.showInformationMessage(`Imported ${nativeProviders.length} providers from ${fileConfig.path}`);
        getLogger().info(`Imported ${nativeProviders.length} providers from ${fileConfig.path}`);
        
        await configManager.reload();
        provider.reloadModels();
      } catch (error) {
        vscode.window.showErrorMessage(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
        getLogger().error('Import config failed:', error);
      }
    })
  );

  // Export keys to system keychain
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.exportKeysToKeychain', async () => {
      try {
        const native = getNative();
        
        if (!native.KeychainSecretStore) {
          vscode.window.showErrorMessage('System keychain is not available on this platform');
          return;
        }

        const keychainStore = new native.KeychainSecretStore();
        if (!keychainStore.isAvailable()) {
          vscode.window.showErrorMessage('System keychain is not available. On Linux, ensure libsecret is installed.');
          return;
        }

        const providers = ['openai', 'anthropic', 'gemini', 'mistral', 'azure', 'openrouter'];
        let exported = 0;

        for (const providerId of providers) {
          // Use ConfigManager's getApiKey method which delegates to unified resolver
          const apiKey = await configManager.getApiKey(providerId);
          if (apiKey) {
            await keychainStore.store(providerId, apiKey);
            exported++;
          }
        }

        if (exported > 0) {
          vscode.window.showInformationMessage(`Exported ${exported} API key(s) to system keychain`);
          getLogger().info(`Exported ${exported} keys to keychain`);
        } else {
          vscode.window.showWarningMessage('No API keys found to export');
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        getLogger().error('Export keys to keychain failed:', error);
      }
    })
  );

  // Export keys to VS Code SecretStorage
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.exportKeysToVSCode', async () => {
      try {
        const native = getNative();
        const secretStorage = context.secrets;
        
        // Try to get keys from keychain
        if (!native.KeychainSecretStore) {
          vscode.window.showErrorMessage('System keychain is not available to export from');
          return;
        }

        const keychainStore = new native.KeychainSecretStore();
        const providers = ['openai', 'anthropic', 'gemini', 'mistral', 'azure', 'openrouter'];
        let exported = 0;

        for (const providerId of providers) {
          try {
            const apiKey = await keychainStore.get(providerId);
            if (apiKey) {
              const storageKey = `openllm.${providerId}.apiKey`;
              await secretStorage.store(storageKey, apiKey);
              exported++;
            }
          } catch {
            // Key not in keychain, skip
          }
        }

        if (exported > 0) {
          vscode.window.showInformationMessage(`Exported ${exported} API key(s) to VS Code SecretStorage`);
          getLogger().info(`Exported ${exported} keys to VS Code`);
        } else {
          vscode.window.showWarningMessage('No API keys found in system keychain to export');
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        getLogger().error('Export keys to VS Code failed:', error);
      }
    })
  );

  // Export keys to .env file
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.exportKeysToDotEnv', async () => {
      try {
        const fs = require('fs');
        const path = require('path');
        const os = require('os');

        // Ask user where to save
        const location = await vscode.window.showQuickPick(
          [
            { label: 'User Home', description: '~/.config/openllm/.env', value: 'user' },
            { label: 'Workspace', description: '.config/openllm/.env in current workspace', value: 'workspace' }
          ],
          { placeHolder: 'Where to save .env file?' }
        );

        if (!location) {
          return;
        }

        let envPath: string;
        if (location.value === 'user') {
          const openllmDir = path.join(os.homedir(), '.config', 'openllm');
          if (!fs.existsSync(openllmDir)) {
            fs.mkdirSync(openllmDir, { recursive: true });
          }
          envPath = path.join(openllmDir, '.env');
        } else {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!workspaceRoot) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
          }
          const openllmDir = path.join(workspaceRoot, '.config', 'openllm');
          if (!fs.existsSync(openllmDir)) {
            fs.mkdirSync(openllmDir, { recursive: true });
          }
          envPath = path.join(openllmDir, '.env');
        }

        const envVarMap: Record<string, string> = {
          'openai': 'OPENAI_API_KEY',
          'anthropic': 'ANTHROPIC_API_KEY',
          'gemini': 'GEMINI_API_KEY',
          'mistral': 'MISTRAL_API_KEY',
          'azure': 'AZURE_API_KEY',
          'openrouter': 'OPENROUTER_API_KEY'
        };

        const lines: string[] = ['# OpenLLM API Keys', `# Generated: ${new Date().toISOString()}`, ''];
        let exported = 0;

        for (const [providerId, envVar] of Object.entries(envVarMap)) {
          // Use ConfigManager's getApiKey which delegates to unified resolver
          const apiKey = await configManager.getApiKey(providerId);
          if (apiKey) {
            lines.push(`${envVar}=${apiKey}`);
            exported++;
          }
        }

        if (exported > 0) {
          // Backup existing file
          if (fs.existsSync(envPath)) {
            const backupPath = envPath + '.backup';
            fs.copyFileSync(envPath, backupPath);
          }

          fs.writeFileSync(envPath, lines.join('\n') + '\n');
          vscode.window.showInformationMessage(`Exported ${exported} API key(s) to ${envPath}`);
          getLogger().info(`Exported ${exported} keys to ${envPath}`);
        } else {
          vscode.window.showWarningMessage('No API keys found to export');
        }
      } catch (error) {
        vscode.window.showErrorMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
        getLogger().error('Export keys to .env failed:', error);
      }
    })
  );

  // Show keys as environment variables (for copying)
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.showKeysAsEnvVars', async () => {
      try {
        const envVarMap: Record<string, string> = {
          'openai': 'OPENAI_API_KEY',
          'anthropic': 'ANTHROPIC_API_KEY',
          'gemini': 'GEMINI_API_KEY',
          'mistral': 'MISTRAL_API_KEY',
          'azure': 'AZURE_API_KEY',
          'openrouter': 'OPENROUTER_API_KEY'
        };

        const lines: string[] = [];

        for (const [providerId, envVar] of Object.entries(envVarMap)) {
          // Use ConfigManager's getApiKey which delegates to unified resolver
          const apiKey = await configManager.getApiKey(providerId);
          if (apiKey) {
            lines.push(`export ${envVar}="${apiKey}"`);
          }
        }

        if (lines.length === 0) {
          vscode.window.showWarningMessage('No API keys configured');
          return;
        }

        // Create a new document with the env vars
        const doc = await vscode.workspace.openTextDocument({
          content: `# Add these to your shell profile (~/.bashrc, ~/.zshrc, etc.)\n\n${lines.join('\n')}\n`,
          language: 'shellscript'
        });
        await vscode.window.showTextDocument(doc);

        vscode.window.showInformationMessage('Copy these environment variable exports to your shell profile');
      } catch (error) {
        vscode.window.showErrorMessage(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        getLogger().error('Show keys as env vars failed:', error);
      }
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
