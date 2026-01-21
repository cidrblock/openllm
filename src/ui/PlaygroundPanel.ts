import * as vscode from 'vscode';
import { ConfigManager } from '../config/ConfigManager';
import { OpenLLMProvider } from '../core/OpenLLMProvider';

/**
 * Playground Panel for testing all models with the same prompt
 */
export class PlaygroundPanel {
  public static currentPanel: PlaygroundPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private configManager: ConfigManager;
  private openLLMProvider: OpenLLMProvider;
  private activeRequests: Map<string, vscode.CancellationTokenSource> = new Map();

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    configManager: ConfigManager,
    openLLMProvider: OpenLLMProvider
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.configManager = configManager;
    this.openLLMProvider = openLLMProvider;

    this.update();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'sendPrompt':
            await this.sendToAllModels(message.prompt, message.selectedModels);
            break;
          case 'cancelAll':
            this.cancelAllRequests();
            this.log('info', 'All requests cancelled by user');
            break;
          case 'cancelModel':
            this.cancelModelRequest(message.modelId);
            break;
          case 'clearLogs':
            // Logs are cleared in the webview
            break;
        }
      },
      null,
      this.disposables
    );

    // Handle panel disposal
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    configManager: ConfigManager,
    openLLMProvider: OpenLLMProvider
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (PlaygroundPanel.currentPanel) {
      PlaygroundPanel.currentPanel.panel.reveal(column);
      PlaygroundPanel.currentPanel.update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'openLLMPlayground',
      'Open LLM Playground',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    PlaygroundPanel.currentPanel = new PlaygroundPanel(
      panel,
      extensionUri,
      configManager,
      openLLMProvider
    );
  }

  private log(
    level: 'info' | 'request' | 'response' | 'error' | 'debug',
    message: string,
    details?: Record<string, unknown>
  ): void {
    this.panel.webview.postMessage({
      command: 'log',
      level,
      message,
      details,
      timestamp: new Date().toISOString(),
    });
  }

  private truncate(text: string, maxLength: number = 200): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength) + '...';
  }

  private cancelAllRequests(): void {
    for (const tokenSource of this.activeRequests.values()) {
      tokenSource.cancel();
      tokenSource.dispose();
    }
    this.activeRequests.clear();
  }

  private cancelModelRequest(modelId: string): void {
    const tokenSource = this.activeRequests.get(modelId);
    if (tokenSource) {
      tokenSource.cancel();
      tokenSource.dispose();
      this.activeRequests.delete(modelId);
      this.log('info', `Request cancelled for model: ${modelId}`);
    }
  }

  private async sendToAllModels(prompt: string, selectedModelIds: string[]): Promise<void> {
    // Cancel any existing requests
    this.cancelAllRequests();

    const models = this.configManager.getModels()
      .filter(m => selectedModelIds.includes(m.id));

    if (models.length === 0) {
      this.log('error', 'No models selected');
      return;
    }

    this.log('info', `Starting requests to ${models.length} model(s)`, {
      models: models.map(m => m.name),
      promptLength: prompt.length,
    });

    // Initialize all responses as pending
    for (const model of models) {
      this.panel.webview.postMessage({
        command: 'modelUpdate',
        modelId: model.id,
        status: 'pending',
        content: '',
      });
    }

    // Send to all models concurrently
    const promises = models.map(async (model) => {
      const tokenSource = new vscode.CancellationTokenSource();
      this.activeRequests.set(model.id, tokenSource);
      const requestStartTime = Date.now();

      // Log request details
      this.log('request', `[${model.name}] Sending request`, {
        provider: model.provider,
        model: model.model,
        apiBase: model.apiBase || '(default)',
        prompt: this.truncate(prompt, 100),
        options: { temperature: 0.7, maxTokens: 1024 },
      });

      try {
        this.panel.webview.postMessage({
          command: 'modelUpdate',
          modelId: model.id,
          status: 'streaming',
          content: '',
          startTime: requestStartTime,
        });

        const messages = [vscode.LanguageModelChatMessage.User(prompt)];
        
        this.log('debug', `[${model.name}] Creating LanguageModelChatMessage`, {
          role: 'user',
          contentLength: prompt.length,
        });

        const stream = await this.openLLMProvider.sendRequest(
          model.id,
          messages,
          { temperature: 0.7, maxTokens: 1024 },
          tokenSource.token
        );

        const streamStartTime = Date.now();
        this.log('debug', `[${model.name}] Stream started`, {
          timeToFirstByte: streamStartTime - requestStartTime + 'ms',
        });

        let content = '';
        let chunkCount = 0;
        for await (const chunk of stream) {
          if (tokenSource.token.isCancellationRequested) {
            this.log('info', `[${model.name}] Request cancelled during streaming`);
            break;
          }
          chunkCount++;
          content += chunk;
          
          // Log every 10th chunk to avoid spam
          if (chunkCount % 10 === 0) {
            this.log('debug', `[${model.name}] Received ${chunkCount} chunks`, {
              totalLength: content.length,
            });
          }

          this.panel.webview.postMessage({
            command: 'modelUpdate',
            modelId: model.id,
            status: 'streaming',
            content,
          });
        }

        const endTime = Date.now();
        const duration = endTime - requestStartTime;

        this.log('response', `[${model.name}] Complete`, {
          duration: duration + 'ms',
          chunks: chunkCount,
          responseLength: content.length,
          preview: this.truncate(content, 150),
        });

        this.panel.webview.postMessage({
          command: 'modelUpdate',
          modelId: model.id,
          status: 'complete',
          content,
          endTime,
        });
      } catch (error) {
        const endTime = Date.now();
        const errorMessage = error instanceof Error ? error.message : String(error);
        
        this.log('error', `[${model.name}] Request failed`, {
          duration: (endTime - requestStartTime) + 'ms',
          error: errorMessage,
        });

        this.panel.webview.postMessage({
          command: 'modelUpdate',
          modelId: model.id,
          status: 'error',
          content: '',
          error: errorMessage,
          endTime,
        });
      } finally {
        this.activeRequests.delete(model.id);
        tokenSource.dispose();
      }
    });

    await Promise.allSettled(promises);
    this.log('info', 'All requests completed');
  }

  private update(): void {
    const models = this.configManager.getModels();
    this.panel.webview.html = this.getWebviewContent(models);
  }

  private getWebviewContent(
    models: ReturnType<ConfigManager['getModels']>
  ): string {
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://unpkg.com; script-src 'nonce-${nonce}' https://unpkg.com; font-src https://unpkg.com;">
  <title>Open LLM Playground</title>
  <link rel="stylesheet" href="https://unpkg.com/@vscode-elements/elements@1/dist/bundled.css">
  <script type="module" src="https://unpkg.com/@vscode-elements/elements@1/dist/bundled.js"></script>
  <style>
    * {
      box-sizing: border-box;
    }
    body {
      padding: 0;
      margin: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .header {
      padding: 12px 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header h1 {
      margin: 0;
      font-size: 1.1em;
      font-weight: 600;
    }
    .input-section {
      padding: 12px 20px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .prompt-row {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
    }
    .prompt-input {
      flex: 1;
      padding: 8px 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-family: inherit;
      font-size: 0.9em;
      resize: none;
    }
    .prompt-input:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    .model-selector {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }
    .model-selector > label:first-child {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      margin-right: 2px;
    }
    .model-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border: 1px solid transparent;
      border-radius: 12px;
      font-size: 0.8em;
      cursor: pointer;
      transition: all 0.15s;
    }
    .model-chip:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .model-chip.selected {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .model-chip input {
      display: none;
    }
    .main-content {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .responses-section {
      flex: 1;
      overflow: auto;
      padding: 12px 20px;
    }
    .responses-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 12px;
    }
    .response-card {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    .response-header {
      padding: 8px 12px;
      background: var(--vscode-sideBarSectionHeader-background);
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .response-model-name {
      font-weight: 600;
      font-size: 0.85em;
    }
    .response-provider {
      color: var(--vscode-descriptionForeground);
      font-size: 0.75em;
    }
    .response-status {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 0.75em;
    }
    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
    }
    .status-pending .status-dot { background: var(--vscode-descriptionForeground); }
    .status-streaming .status-dot { background: var(--vscode-charts-blue); animation: pulse 1s infinite; }
    .status-complete .status-dot { background: var(--vscode-testing-iconPassed); }
    .status-error .status-dot { background: var(--vscode-testing-iconFailed); }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .response-body {
      padding: 10px 12px;
      flex: 1;
      overflow: auto;
      font-size: 0.85em;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      min-height: 120px;
      max-height: 300px;
    }
    .response-body.error {
      color: var(--vscode-errorForeground);
    }
    .response-body.empty {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .response-footer {
      padding: 6px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 0.75em;
      color: var(--vscode-descriptionForeground);
    }
    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--vscode-descriptionForeground);
    }
    .button-group {
      display: flex;
      gap: 6px;
    }
    
    /* Log Panel */
    .log-section {
      flex-shrink: 0;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      flex-direction: column;
      max-height: 35%;
      min-height: 120px;
    }
    .log-section.collapsed {
      min-height: auto;
    }
    .log-section.collapsed .log-content {
      display: none;
    }
    .log-header {
      padding: 6px 12px;
      background: var(--vscode-sideBarSectionHeader-background);
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
    }
    .log-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .log-header h3 {
      margin: 0;
      font-size: 0.85em;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .log-header .toggle-icon {
      transition: transform 0.2s;
    }
    .log-section.collapsed .toggle-icon {
      transform: rotate(-90deg);
    }
    .log-actions {
      display: flex;
      gap: 8px;
    }
    .log-content {
      flex: 1;
      overflow: auto;
      padding: 8px 12px;
      font-family: var(--vscode-editor-font-family), monospace;
      font-size: 0.8em;
      line-height: 1.4;
      background: var(--vscode-editor-background);
    }
    .log-entry {
      padding: 3px 0;
      display: flex;
      gap: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .log-entry:last-child {
      border-bottom: none;
    }
    .log-time {
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
      font-size: 0.9em;
    }
    .log-level {
      flex-shrink: 0;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 0.85em;
      font-weight: 500;
      text-transform: uppercase;
    }
    .log-level.info { background: var(--vscode-charts-blue); color: white; }
    .log-level.request { background: var(--vscode-charts-purple); color: white; }
    .log-level.response { background: var(--vscode-charts-green); color: white; }
    .log-level.error { background: var(--vscode-testing-iconFailed); color: white; }
    .log-level.debug { background: var(--vscode-descriptionForeground); color: white; }
    .log-message {
      flex: 1;
      word-break: break-word;
    }
    .log-details {
      margin-top: 4px;
      padding: 6px 8px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      font-size: 0.95em;
      white-space: pre-wrap;
      color: var(--vscode-descriptionForeground);
    }
    .log-count {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 6px;
      border-radius: 10px;
      font-size: 0.85em;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Model Playground</h1>
    <span style="color: var(--vscode-descriptionForeground); font-size: 0.85em;">
      Compare responses from multiple models
    </span>
  </div>

  <div class="input-section">
    <div class="prompt-row">
      <textarea 
        id="prompt-input" 
        class="prompt-input" 
        rows="2" 
        placeholder="Enter your prompt here... (Ctrl+Enter to send)"
      ></textarea>
      <div class="button-group">
        <vscode-button id="send-btn">Send</vscode-button>
        <vscode-button id="cancel-btn" appearance="secondary">Cancel</vscode-button>
      </div>
    </div>
    <div class="model-selector">
      <label>Models:</label>
      ${models.length === 0 ? '<span style="color: var(--vscode-errorForeground); font-size: 0.85em;">No models configured</span>' : 
        models.map(m => `
          <label class="model-chip selected" data-model-id="${m.id}">
            <input type="checkbox" checked value="${m.id}">
            <span>${m.name}</span>
          </label>
        `).join('')
      }
    </div>
  </div>

  <div class="main-content">
    <div class="responses-section">
      ${models.length === 0 ? `
        <div class="empty-state">
          <p>No models configured. Add a provider to get started.</p>
        </div>
      ` : `
        <div class="responses-grid" id="responses-grid">
          ${models.map(m => `
            <div class="response-card" data-model-id="${m.id}">
              <div class="response-header">
                <div>
                  <div class="response-model-name">${m.name}</div>
                  <div class="response-provider">${m.provider}</div>
                </div>
                <div class="response-status status-pending" id="status-${m.id}">
                  <span class="status-dot"></span>
                  <span class="status-text">Ready</span>
                </div>
              </div>
              <div class="response-body empty" id="body-${m.id}">
                Waiting for prompt...
              </div>
              <div class="response-footer" id="footer-${m.id}">
                ${(m.contextLength || 8192).toLocaleString()} tokens
              </div>
            </div>
          `).join('')}
        </div>
      `}
    </div>

    <div class="log-section" id="log-section">
      <div class="log-header" id="log-header">
        <h3>
          <span class="toggle-icon">▼</span>
          Request Log
          <span class="log-count" id="log-count">0</span>
        </h3>
        <div class="log-actions">
          <vscode-button appearance="icon" id="clear-logs-btn" title="Clear logs">
            Clear
          </vscode-button>
        </div>
      </div>
      <div class="log-content" id="log-content">
        <div style="color: var(--vscode-descriptionForeground); font-style: italic;">
          Logs will appear here when you send a request...
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const startTimes = {};
    let logCount = 0;

    // Toggle log panel
    document.getElementById('log-header')?.addEventListener('click', (e) => {
      if (e.target.closest('#clear-logs-btn')) return;
      document.getElementById('log-section')?.classList.toggle('collapsed');
    });

    // Clear logs
    document.getElementById('clear-logs-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('log-content').innerHTML = 
        '<div style="color: var(--vscode-descriptionForeground); font-style: italic;">Logs cleared</div>';
      logCount = 0;
      document.getElementById('log-count').textContent = '0';
    });

    // Model chip selection
    document.querySelectorAll('.model-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const checkbox = chip.querySelector('input');
        checkbox.checked = !checkbox.checked;
        chip.classList.toggle('selected', checkbox.checked);
      });
    });

    // Send button
    document.getElementById('send-btn')?.addEventListener('click', () => {
      const prompt = document.getElementById('prompt-input').value.trim();
      if (!prompt) return;

      const selectedModels = Array.from(document.querySelectorAll('.model-chip.selected input'))
        .map(input => input.value);

      if (selectedModels.length === 0) {
        return;
      }

      // Reset all responses
      selectedModels.forEach(modelId => {
        startTimes[modelId] = Date.now();
        updateModelCard(modelId, 'pending', '', null);
      });

      vscode.postMessage({ 
        command: 'sendPrompt', 
        prompt,
        selectedModels
      });
    });

    // Cancel button
    document.getElementById('cancel-btn')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'cancelAll' });
    });

    // Enter to send (Ctrl/Cmd + Enter)
    document.getElementById('prompt-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        document.getElementById('send-btn')?.click();
      }
    });

    // Handle messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      
      if (message.command === 'modelUpdate') {
        const elapsed = message.endTime 
          ? ((message.endTime - startTimes[message.modelId]) / 1000).toFixed(1) + 's'
          : null;
        updateModelCard(message.modelId, message.status, message.content, elapsed, message.error);
      } else if (message.command === 'log') {
        addLogEntry(message);
      }
    });

    function updateModelCard(modelId, status, content, elapsed, error) {
      const statusEl = document.getElementById('status-' + modelId);
      const bodyEl = document.getElementById('body-' + modelId);
      const footerEl = document.getElementById('footer-' + modelId);

      if (statusEl) {
        statusEl.className = 'response-status status-' + status;
        const statusTexts = {
          pending: 'Pending',
          streaming: 'Streaming...',
          complete: 'Complete',
          error: 'Error'
        };
        statusEl.querySelector('.status-text').textContent = statusTexts[status] || status;
      }

      if (bodyEl) {
        bodyEl.className = 'response-body';
        if (error) {
          bodyEl.classList.add('error');
          bodyEl.textContent = 'Error: ' + error;
        } else if (content) {
          bodyEl.textContent = content;
        } else if (status === 'pending') {
          bodyEl.classList.add('empty');
          bodyEl.textContent = 'Waiting...';
        } else if (status === 'streaming') {
          bodyEl.classList.add('empty');
          bodyEl.textContent = 'Receiving response...';
        }
      }

      if (footerEl && elapsed) {
        footerEl.textContent = 'Completed in ' + elapsed;
      }
    }

    function addLogEntry(log) {
      const logContent = document.getElementById('log-content');
      const logCountEl = document.getElementById('log-count');
      
      // Clear placeholder on first log
      if (logCount === 0) {
        logContent.innerHTML = '';
      }
      
      logCount++;
      logCountEl.textContent = logCount.toString();

      const time = new Date(log.timestamp).toLocaleTimeString('en-US', { 
        hour12: false, 
        hour: '2-digit', 
        minute: '2-digit', 
        second: '2-digit',
        fractionalSecondDigits: 3
      });

      const entry = document.createElement('div');
      entry.className = 'log-entry';
      
      let detailsHtml = '';
      if (log.details) {
        const detailsStr = JSON.stringify(log.details, null, 2);
        detailsHtml = '<div class="log-details">' + escapeHtml(detailsStr) + '</div>';
      }

      entry.innerHTML = 
        '<span class="log-time">' + time + '</span>' +
        '<span class="log-level ' + log.level + '">' + log.level + '</span>' +
        '<div class="log-message">' + escapeHtml(log.message) + detailsHtml + '</div>';

      logContent.appendChild(entry);
      
      // Auto-scroll to bottom
      logContent.scrollTop = logContent.scrollHeight;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  public dispose(): void {
    this.cancelAllRequests();
    PlaygroundPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
