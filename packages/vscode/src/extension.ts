import * as vscode from 'vscode';
import { getLogger, updateLogLevel, disposeLogger } from './utils/logger';
import { 
  initializeDaemon, 
  shutdownDaemon, 
  setExtensionPath,
  getDaemonClient 
} from './daemon';
import { OpenLLMLanguageModelProvider } from './providers';

// Default dashboard URL - daemon serves web UI here
const DASHBOARD_URL = 'http://localhost:8787';

let daemonConnected = false;
let languageModelProvider: OpenLLMLanguageModelProvider | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log('[OpenLLM] activate() called');
  const logger = getLogger();
  logger.info('Open LLM Provider activating...');

  // Set extension path for finding bundled daemon binary
  setExtensionPath(context.extensionPath);
  console.log('[OpenLLM] extensionPath:', context.extensionPath);

  // Initialize daemon connection (auto-starts daemon if not running)
  try {
    logger.info('[Daemon] Connecting to OpenLLM daemon...');
    await initializeDaemon();
    logger.info('[Daemon] Connected');
    daemonConnected = true;
    
    // Check daemon health
    const client = getDaemonClient();
    const healthy = await client.healthCheck();
    if (healthy) {
      logger.info('[Daemon] Health check passed');
    } else {
      logger.warn('[Daemon] Health check failed');
    }

    // Start the Language Model Provider to expose models to VS Code
    languageModelProvider = new OpenLLMLanguageModelProvider(client);
    await languageModelProvider.start();
    logger.info('[LMProvider] Language Model Provider started');
  } catch (e) {
    logger.error('[Daemon] Failed to connect:', e);
    vscode.window.showWarningMessage(
      `OpenLLM: Could not connect to daemon. Dashboard may not be available.`
    );
  }

  // Register commands
  registerCommands(context);

  // Create status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = daemonConnected ? '$(sparkle) OpenLLM' : '$(warning) OpenLLM';
  statusBarItem.tooltip = daemonConnected 
    ? 'OpenLLM Daemon Connected - Click to open dashboard' 
    : 'OpenLLM Daemon Not Connected';
  statusBarItem.command = 'openLLM.openDashboard';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Watch for configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('openLLM.logLevel')) {
        updateLogLevel();
      }
    })
  );

  logger.info('Open LLM Provider activated');
}

export async function deactivate() {
  const logger = getLogger();
  logger.info('Open LLM Provider deactivating...');
  
  // Stop the Language Model Provider
  if (languageModelProvider) {
    languageModelProvider.stop();
    languageModelProvider = null;
    logger.info('[LMProvider] Language Model Provider stopped');
  }
  
  try {
    await shutdownDaemon();
    logger.info('[Daemon] Disconnected');
  } catch (e) {
    logger.error('[Daemon] Error during shutdown:', e);
  }
  
  disposeLogger();
}

function registerCommands(context: vscode.ExtensionContext): void {
  // Daemon status command
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.daemonStatus', async () => {
      console.log('[OpenLLM] daemonStatus command');
      
      try {
        const client = getDaemonClient();
        const status = await client.getStatus();
        
        const startedAt = status.startedAt?.seconds 
          ? new Date(Number(status.startedAt.seconds) * 1000).toLocaleString()
          : 'unknown';
        
        const msg = [
          `OpenLLM Daemon v${status.version || 'unknown'}`,
          `Started: ${startedAt}`,
          `Clients: ${status.connectedClients || 0}`,
          `Sessions: ${status.activeSessions || 0}`,
        ].join('\n');
        
        vscode.window.showInformationMessage(msg, 'Open Dashboard').then(action => {
          if (action === 'Open Dashboard') {
            vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
          }
        });
      } catch (e) {
        console.error('[OpenLLM] daemonStatus error:', e);
        vscode.window.showErrorMessage(
          `OpenLLM: Cannot get daemon status. Is the daemon running?`,
          'Open Dashboard Anyway'
        ).then(action => {
          if (action === 'Open Dashboard Anyway') {
            vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
          }
        });
      }
    })
  );

  // Open dashboard command - opens web UI in browser
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.openDashboard', () => {
      console.log('[OpenLLM] openDashboard command');
      vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
    })
  );

  // Configure provider command - opens dashboard for API key configuration
  context.subscriptions.push(
    vscode.commands.registerCommand('openLLM.configureProvider', () => {
      console.log('[OpenLLM] configureProvider command');
      vscode.env.openExternal(vscode.Uri.parse(DASHBOARD_URL));
    })
  );
}
