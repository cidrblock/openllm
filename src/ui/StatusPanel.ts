import * as vscode from 'vscode';
import { ConfigManager } from '../config/ConfigManager';
import { ProviderRegistry } from '../registry/ProviderRegistry';
import { OpenLLMProvider } from '../core/OpenLLMProvider';
import { ModelConfig } from '../types';

/**
 * Status Panel webview for debugging and monitoring
 */
export class StatusPanel {
  public static currentPanel: StatusPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private disposables: vscode.Disposable[] = [];

  private configManager: ConfigManager;
  private providerRegistry: ProviderRegistry;
  private openLLMProvider: OpenLLMProvider;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    configManager: ConfigManager,
    providerRegistry: ProviderRegistry,
    openLLMProvider: OpenLLMProvider
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.configManager = configManager;
    this.providerRegistry = providerRegistry;
    this.openLLMProvider = openLLMProvider;

    this.update();

    // Handle messages from webview
    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.command) {
          case 'refresh':
            this.update();
            break;
          case 'testConnections':
            await this.testConnections();
            break;
          case 'reloadConfig':
            await this.configManager.reload();
            this.openLLMProvider.reloadModels();
            this.update();
            break;
          case 'openSettings':
            vscode.commands.executeCommand('workbench.action.openSettings', 'openLLM');
            break;
        }
      },
      null,
      this.disposables
    );

    // Update when configuration changes
    this.disposables.push(
      this.configManager.onDidChange(() => {
        this.update();
      })
    );

    // Handle panel disposal
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    configManager: ConfigManager,
    providerRegistry: ProviderRegistry,
    openLLMProvider: OpenLLMProvider
  ): void {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (StatusPanel.currentPanel) {
      StatusPanel.currentPanel.panel.reveal(column);
      StatusPanel.currentPanel.update();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'openLLMStatus',
      'Open LLM Status',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    StatusPanel.currentPanel = new StatusPanel(
      panel,
      extensionUri,
      configManager,
      providerRegistry,
      openLLMProvider
    );
  }

  private async testConnections(): Promise<void> {
    this.panel.webview.postMessage({ command: 'testingStarted' });
    
    try {
      const result = await this.openLLMProvider.testConnections();
      this.panel.webview.postMessage({ 
        command: 'testResults', 
        data: result 
      });
    } catch (error) {
      this.panel.webview.postMessage({ 
        command: 'testError', 
        data: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get the configuration source from the model ID
   */
  private getConfigSource(model: ModelConfig): string {
    if (model.id.startsWith('continue-')) {
      return 'Continue Config (~/.continue/config.yaml)';
    } else if (model.id.startsWith('settings-')) {
      return 'VS Code Settings (settings.json)';
    }
    return 'Unknown';
  }

  /**
   * Mask an API key for display
   */
  private maskApiKey(apiKey: string | undefined): string {
    if (!apiKey) {
      return '(not set)';
    }
    if (apiKey.length <= 8) {
      return '****';
    }
    return apiKey.substring(0, 4) + '...' + apiKey.substring(apiKey.length - 4);
  }

  /**
   * Get default API base for a provider
   */
  private getDefaultApiBase(provider: string): string {
    const defaults: Record<string, string> = {
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com',
      google: 'https://generativelanguage.googleapis.com',
      gemini: 'https://generativelanguage.googleapis.com',
      ollama: 'http://localhost:11434',
      mistral: 'https://api.mistral.ai/v1',
      azure: '(requires custom endpoint)',
    };
    return defaults[provider.toLowerCase()] || '(unknown)';
  }

  /**
   * Generate tooltip data for a model
   */
  private getModelTooltipData(model: ModelConfig): Record<string, string> {
    return {
      'Model ID': model.id,
      'Provider': model.provider,
      'Model': model.model,
      'Source': this.getConfigSource(model),
      'API Base': model.apiBase || this.getDefaultApiBase(model.provider) + ' (default)',
      'API Key': this.maskApiKey(model.apiKey),
      'Context Length': (model.contextLength || 8192).toLocaleString() + ' tokens',
      'Roles': model.roles?.join(', ') || 'chat',
      'Image Input': model.capabilities?.imageInput ? 'Yes' : 'No',
      'Tool Calling': model.capabilities?.toolCalling ? 'Yes' : 'No',
      'Streaming': model.capabilities?.streaming !== false ? 'Yes' : 'No',
    };
  }

  private update(): void {
    const models = this.configManager.getModels();
    const providers = this.providerRegistry.getSupportedProviders();
    const providerMetadata = this.providerRegistry.getProviderMetadata();

    // Group models by provider
    const modelsByProvider: Record<string, typeof models> = {};
    for (const model of models) {
      const provider = model.provider.toLowerCase();
      if (!modelsByProvider[provider]) {
        modelsByProvider[provider] = [];
      }
      modelsByProvider[provider].push(model);
    }

    this.panel.webview.html = this.getWebviewContent(
      models,
      providers,
      providerMetadata,
      modelsByProvider
    );
  }

  private getWebviewContent(
    models: ReturnType<ConfigManager['getModels']>,
    providers: string[],
    providerMetadata: ReturnType<ProviderRegistry['getProviderMetadata']>,
    modelsByProvider: Record<string, typeof models>
  ): string {
    const nonce = this.getNonce();

    // Generate tooltip data for each model
    const modelTooltips: Record<string, Record<string, string>> = {};
    for (const model of models) {
      modelTooltips[model.id] = this.getModelTooltipData(model);
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://unpkg.com; script-src 'nonce-${nonce}' https://unpkg.com; font-src https://unpkg.com;">
  <title>Open LLM Status</title>
  <link rel="stylesheet" href="https://unpkg.com/@vscode-elements/elements@1/dist/bundled.css">
  <script type="module" src="https://unpkg.com/@vscode-elements/elements@1/dist/bundled.js"></script>
  <style>
    body {
      padding: 20px;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header h1 {
      margin: 0;
      font-size: 1.4em;
      font-weight: 600;
    }
    .header-actions {
      display: flex;
      gap: 8px;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      padding: 16px;
    }
    .stat-value {
      font-size: 2em;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .stat-label {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .section {
      margin-bottom: 24px;
    }
    .section h2 {
      font-size: 1.1em;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .provider-group {
      margin-bottom: 16px;
    }
    .provider-header {
      font-weight: 600;
      margin-bottom: 8px;
      text-transform: capitalize;
    }
    .model-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .model-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      font-size: 0.9em;
      cursor: pointer;
      position: relative;
      transition: background 0.15s;
    }
    .model-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .info-icon {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 11px;
      font-weight: bold;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-style: normal;
      margin-left: 8px;
      cursor: help;
    }
    .model-item:hover .info-icon {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    /* Provider cards */
    .provider-card {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .provider-card-header {
      padding: 10px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      transition: background 0.15s;
    }
    .provider-card-header:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .provider-card-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .provider-card-name {
      font-weight: 600;
      font-size: 0.95em;
    }
    .provider-card-meta {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
    }
    .provider-card-status {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .expand-icon {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      transition: transform 0.2s;
    }
    .provider-card.collapsed .expand-icon {
      transform: rotate(-90deg);
    }
    .provider-card-models {
      padding: 0 14px 12px 14px;
      border-top: 1px solid var(--vscode-panel-border);
      margin-top: 0;
    }
    .provider-card.collapsed .provider-card-models {
      display: none;
    }
    .available-models-title {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      margin: 10px 0 8px 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .available-model-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
      margin-bottom: 4px;
      font-size: 0.85em;
    }
    .available-model-item.configured {
      border-left: 3px solid var(--vscode-testing-iconPassed);
    }
    .available-model-name {
      flex: 1;
    }
    .available-model-context {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .available-model-caps {
      font-size: 0.85em;
    }
    .configured-check {
      color: var(--vscode-testing-iconPassed);
      font-weight: bold;
    }
    .available-models-note {
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 10px 0;
    }
    .model-name {
      flex: 1;
    }
    .model-context {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 12px;
      font-size: 0.8em;
      font-weight: 500;
    }
    .status-ok {
      background: var(--vscode-testing-iconPassed);
      color: var(--vscode-editor-background);
    }
    .status-error {
      background: var(--vscode-testing-iconFailed);
      color: var(--vscode-editor-background);
    }
    .status-pending {
      background: var(--vscode-descriptionForeground);
      color: var(--vscode-editor-background);
    }
    .test-results {
      margin-top: 12px;
    }
    .test-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      margin-bottom: 4px;
    }
    .test-item.success {
      border-left: 3px solid var(--vscode-testing-iconPassed);
    }
    .test-item.failure {
      border-left: 3px solid var(--vscode-testing-iconFailed);
    }
    .test-error {
      color: var(--vscode-errorForeground);
      font-size: 0.85em;
      margin-left: auto;
    }
    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--vscode-descriptionForeground);
    }
    .empty-state p {
      margin-bottom: 16px;
    }
    #testing-spinner {
      display: none;
    }
    #testing-spinner.visible {
      display: inline-block;
    }

    /* Tooltip styles */
    .tooltip {
      display: none;
      position: fixed;
      z-index: 1000;
      background: var(--vscode-editorWidget-background);
      border: 1px solid var(--vscode-editorWidget-border);
      border-radius: 6px;
      padding: 12px 16px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      max-width: 400px;
      font-size: 0.85em;
    }
    .tooltip.visible {
      display: block;
    }
    .tooltip-title {
      font-weight: 600;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .tooltip-row {
      display: flex;
      gap: 12px;
      padding: 4px 0;
    }
    .tooltip-label {
      color: var(--vscode-descriptionForeground);
      min-width: 100px;
      flex-shrink: 0;
    }
    .tooltip-value {
      word-break: break-all;
    }
    .tooltip-value.source {
      color: var(--vscode-textLink-foreground);
    }
    .tooltip-value.ok {
      color: var(--vscode-testing-iconPassed);
    }
    .tooltip-value.error {
      color: var(--vscode-testing-iconFailed);
    }
    .tooltip-section {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .tooltip-section-title {
      font-weight: 600;
      margin-bottom: 6px;
      font-size: 0.95em;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>Open LLM Provider Status</h1>
    <div class="header-actions">
      <vscode-button id="refresh-btn" appearance="secondary">
        Refresh
      </vscode-button>
      <vscode-button id="settings-btn" appearance="secondary">
        Settings
      </vscode-button>
    </div>
  </div>

  <div class="stats">
    <div class="stat-card">
      <div class="stat-value">${models.length}</div>
      <div class="stat-label">Models Configured</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${Object.keys(modelsByProvider).length}</div>
      <div class="stat-label">Active Providers</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${providers.length}</div>
      <div class="stat-label">Supported Providers</div>
    </div>
  </div>

  <div class="section">
    <h2>Configured Models</h2>
    <p style="color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 12px;">
      Hover over a model for connection details
    </p>
    ${models.length === 0 ? `
      <div class="empty-state">
        <p>No models configured yet.</p>
        <vscode-button id="add-provider-btn">Add Provider</vscode-button>
      </div>
    ` : Object.entries(modelsByProvider).map(([provider, providerModels]) => `
      <div class="provider-group">
        <div class="provider-header">${provider}</div>
        <div class="model-list">
          ${providerModels.map(model => `
            <div class="model-item has-tooltip" data-model-id="${model.id}">
              <span class="model-name">${model.name}</span>
              <span class="model-context">${(model.contextLength || 8192).toLocaleString()} tokens</span>
              <span class="status-badge ${model.apiKey || provider === 'ollama' ? 'status-ok' : 'status-error'}">
                ${model.apiKey || provider === 'ollama' ? 'Ready' : 'No Key'}
              </span>
              <span class="info-icon">i</span>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('')}
  </div>

  <div class="section">
    <h2>
      Connection Test
      <vscode-progress-ring id="testing-spinner"></vscode-progress-ring>
    </h2>
    <vscode-button id="test-btn">Test All Connections</vscode-button>
    <div id="test-results" class="test-results"></div>
  </div>

  <div class="section">
    <h2>Supported Providers &amp; Available Models</h2>
    <p style="color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 12px;">
      Click a provider to see available models you can configure
    </p>
    ${providerMetadata.map(p => `
      <div class="provider-card" data-provider-id="${p.id}">
        <div class="provider-card-header">
          <div class="provider-card-info">
            <span class="provider-card-name">${p.displayName}</span>
            <span class="provider-card-meta">${p.requiresApiKey ? 'API Key Required' : 'No API Key Needed'}</span>
          </div>
          <div class="provider-card-status">
            <span class="status-badge ${modelsByProvider[p.id] ? 'status-ok' : 'status-pending'}">
              ${modelsByProvider[p.id] ? modelsByProvider[p.id].length + ' configured' : 'Not configured'}
            </span>
            <span class="expand-icon">▼</span>
          </div>
        </div>
        <div class="provider-card-models">
          ${p.defaultModels.length > 0 ? `
            <div class="available-models-title">Available Models:</div>
            ${p.defaultModels.map(m => `
              <div class="available-model-item ${modelsByProvider[p.id]?.some(cm => cm.model.includes(m.id)) ? 'configured' : ''}">
                <span class="available-model-name">${m.name}</span>
                <span class="available-model-context">${m.contextLength.toLocaleString()} tokens</span>
                <span class="available-model-caps">
                  ${m.capabilities.imageInput ? '🖼' : ''}
                  ${m.capabilities.toolCalling ? '🔧' : ''}
                </span>
                ${modelsByProvider[p.id]?.some(cm => cm.model.includes(m.id)) ? '<span class="configured-check">✓</span>' : ''}
              </div>
            `).join('')}
          ` : `
            <div class="available-models-note">
              ${p.id === 'azure' ? 'Uses your Azure deployment names' : 
                p.id === 'ollama' ? 'Run "ollama list" to see installed models' : 
                'Configure custom models in settings'}
            </div>
          `}
        </div>
      </div>
    `).join('')}
  </div>

  <!-- Tooltip element -->
  <div class="tooltip" id="tooltip"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const tooltip = document.getElementById('tooltip');
    
    // Model tooltip data
    const modelData = ${JSON.stringify(modelTooltips)};

    // Show tooltip on hover
    document.querySelectorAll('.model-item.has-tooltip').forEach(item => {
      item.addEventListener('mouseenter', (e) => {
        const modelId = item.dataset.modelId;
        const data = modelData[modelId];
        if (!data) return;

        // Build tooltip content
        let html = '<div class="tooltip-title">' + escapeHtml(data['Model ID']) + '</div>';
        
        // Configuration section
        html += '<div class="tooltip-section-title">Configuration</div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Source:</span><span class="tooltip-value source">' + escapeHtml(data['Source']) + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Provider:</span><span class="tooltip-value">' + escapeHtml(data['Provider']) + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Model:</span><span class="tooltip-value">' + escapeHtml(data['Model']) + '</span></div>';
        
        // Connection section
        html += '<div class="tooltip-section"><div class="tooltip-section-title">Connection</div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">API Base:</span><span class="tooltip-value">' + escapeHtml(data['API Base']) + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">API Key:</span><span class="tooltip-value ' + (data['API Key'] === '(not set)' ? 'error' : 'ok') + '">' + escapeHtml(data['API Key']) + '</span></div>';
        html += '</div>';
        
        // Capabilities section
        html += '<div class="tooltip-section"><div class="tooltip-section-title">Capabilities</div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Context:</span><span class="tooltip-value">' + escapeHtml(data['Context Length']) + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Roles:</span><span class="tooltip-value">' + escapeHtml(data['Roles']) + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Image Input:</span><span class="tooltip-value">' + data['Image Input'] + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Tool Calling:</span><span class="tooltip-value">' + data['Tool Calling'] + '</span></div>';
        html += '<div class="tooltip-row"><span class="tooltip-label">Streaming:</span><span class="tooltip-value">' + data['Streaming'] + '</span></div>';
        html += '</div>';

        tooltip.innerHTML = html;
        tooltip.classList.add('visible');
        
        positionTooltip(e);
      });

      item.addEventListener('mousemove', (e) => {
        positionTooltip(e);
      });

      item.addEventListener('mouseleave', () => {
        tooltip.classList.remove('visible');
      });
    });

    function positionTooltip(e) {
      const padding = 15;
      let left = e.clientX + padding;
      let top = e.clientY + padding;

      // Get tooltip dimensions
      const rect = tooltip.getBoundingClientRect();
      
      // Adjust if overflowing right
      if (left + rect.width > window.innerWidth - padding) {
        left = e.clientX - rect.width - padding;
      }
      
      // Adjust if overflowing bottom
      if (top + rect.height > window.innerHeight - padding) {
        top = e.clientY - rect.height - padding;
      }

      tooltip.style.left = left + 'px';
      tooltip.style.top = top + 'px';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    document.getElementById('refresh-btn')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });

    document.getElementById('settings-btn')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'openSettings' });
    });

    document.getElementById('test-btn')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'testConnections' });
    });

    document.getElementById('add-provider-btn')?.addEventListener('click', () => {
      vscode.postMessage({ command: 'openSettings' });
    });

    // Provider card expand/collapse - start all collapsed
    document.querySelectorAll('.provider-card').forEach(card => {
      card.classList.add('collapsed');
      card.querySelector('.provider-card-header')?.addEventListener('click', () => {
        card.classList.toggle('collapsed');
      });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      const spinner = document.getElementById('testing-spinner');
      const resultsDiv = document.getElementById('test-results');

      switch (message.command) {
        case 'testingStarted':
          spinner?.classList.add('visible');
          if (resultsDiv) resultsDiv.innerHTML = '';
          break;
        case 'testResults':
          spinner?.classList.remove('visible');
          if (resultsDiv) {
            const data = message.data;
            resultsDiv.innerHTML = data.details.map(d => 
              '<div class="test-item ' + (d.success ? 'success' : 'failure') + '">' +
                '<span class="model-name">' + d.provider + '/' + d.model + '</span>' +
                (d.success 
                  ? '<span class="status-badge status-ok">OK</span>' 
                  : '<span class="test-error">' + (d.error || 'Failed') + '</span>') +
              '</div>'
            ).join('');
          }
          break;
        case 'testError':
          spinner?.classList.remove('visible');
          if (resultsDiv) {
            resultsDiv.innerHTML = '<div class="test-item failure">Error: ' + message.data + '</div>';
          }
          break;
      }
    });
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
    StatusPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
