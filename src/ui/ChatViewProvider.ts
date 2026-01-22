import * as vscode from 'vscode';
import { OpenLLMProvider } from '../core/OpenLLMProvider';
import { getLogger } from '../utils/logger';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

interface ChatModel {
  id: string;
  name: string;
  vendor: string;
  isVSCodeLM: boolean;
}

/**
 * Provides the Chat sidebar webview for "Ask" mode interactions
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openLLM.chatView';

  private _view?: vscode.WebviewView;
  private _messages: ChatMessage[] = [];
  private _models: ChatModel[] = [];
  private _selectedModelId: string = '';
  private _isStreaming: boolean = false;
  private _currentAbortController?: AbortController;
  private _logger = getLogger();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _openLLMProvider: OpenLLMProvider
  ) {}

  /**
   * Called when the webview view is resolved/created
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready':
          await this._refreshModels();
          this._sendStateToWebview();
          break;
        case 'sendMessage':
          await this._handleUserMessage(message.text);
          break;
        case 'selectModel':
          this._selectedModelId = message.modelId;
          break;
        case 'clearChat':
          this._clearChat();
          break;
        case 'stopGeneration':
          this._stopGeneration();
          break;
        case 'refreshModels':
          await this._refreshModels();
          break;
      }
    });

    // Listen for model changes
    vscode.lm.onDidChangeChatModels(() => {
      this._refreshModels();
    });
  }

  /**
   * Refresh the list of available models
   */
  private async _refreshModels(): Promise<void> {
    this._models = [];

    try {
      // Get models from vscode.lm API (includes Copilot and any registered providers)
      const lmModels = await vscode.lm.selectChatModels({});
      for (const model of lmModels) {
        this._models.push({
          id: `vscode-lm:${model.vendor}/${model.id}`,
          name: `${model.name} (${model.vendor})`,
          vendor: model.vendor,
          isVSCodeLM: true
        });
      }
    } catch (error) {
      this._logger.warn('Failed to get vscode.lm models:', error);
    }

    // Get models from our OpenLLMProvider directly (fallback)
    const openLLMModels = this._openLLMProvider.getAvailableModels();
    for (const model of openLLMModels) {
      // Avoid duplicates if already registered via vscode.lm
      const existingId = `vscode-lm:open-llm/${model.id}`;
      if (!this._models.find(m => m.id === existingId)) {
        this._models.push({
          id: `direct:${model.id}`,
          name: `${model.name} (${model.provider})`,
          vendor: model.provider,
          isVSCodeLM: false
        });
      }
    }

    // Set default selection if not set
    if (!this._selectedModelId && this._models.length > 0) {
      this._selectedModelId = this._models[0].id;
    }

    this._sendModelsToWebview();
  }

  /**
   * Handle a user message submission
   */
  private async _handleUserMessage(text: string): Promise<void> {
    if (!text.trim() || this._isStreaming) {
      return;
    }

    // Add user message
    const userMessage: ChatMessage = {
      role: 'user',
      content: text.trim(),
      timestamp: Date.now()
    };
    this._messages.push(userMessage);
    this._sendMessageToWebview(userMessage);

    // Start streaming response
    this._isStreaming = true;
    this._sendStreamingState(true);

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: '',
      timestamp: Date.now()
    };

    try {
      const selectedModel = this._models.find(m => m.id === this._selectedModelId);
      if (!selectedModel) {
        throw new Error('No model selected. Please select a model from the dropdown.');
      }

      // Create cancellation token
      const tokenSource = new vscode.CancellationTokenSource();
      
      // Build message history for context
      const vsMessages = this._messages
        .filter(m => m.role !== 'system')
        .map(m => 
          m.role === 'user'
            ? vscode.LanguageModelChatMessage.User(m.content)
            : vscode.LanguageModelChatMessage.Assistant(m.content)
        );

      if (selectedModel.isVSCodeLM) {
        // Use vscode.lm API
        const [vendor, modelId] = selectedModel.id.replace('vscode-lm:', '').split('/');
        const models = await vscode.lm.selectChatModels({ vendor, id: modelId });
        
        if (models.length === 0) {
          throw new Error(`Model ${selectedModel.name} is no longer available.`);
        }

        const response = await models[0].sendRequest(vsMessages, {}, tokenSource.token);
        
        for await (const chunk of response.text) {
          if (tokenSource.token.isCancellationRequested) {
            break;
          }
          assistantMessage.content += chunk;
          this._streamChunkToWebview(chunk);
        }
      } else {
        // Use direct OpenLLMProvider
        const modelId = selectedModel.id.replace('direct:', '');
        const stream = await this._openLLMProvider.sendRequest(
          modelId,
          vsMessages,
          {},
          tokenSource.token
        );

        for await (const chunk of stream) {
          if (tokenSource.token.isCancellationRequested) {
            break;
          }
          assistantMessage.content += chunk;
          this._streamChunkToWebview(chunk);
        }
      }

      // Finalize the message
      this._messages.push(assistantMessage);
      this._sendStreamComplete();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._logger.error('Chat error:', error);
      
      // Send error to webview
      assistantMessage.content = `Error: ${errorMessage}`;
      this._messages.push(assistantMessage);
      this._sendErrorToWebview(errorMessage);
    } finally {
      this._isStreaming = false;
      this._sendStreamingState(false);
    }
  }

  /**
   * Clear the chat history
   */
  public clearChat(): void {
    this._clearChat();
  }

  private _clearChat(): void {
    this._messages = [];
    this._view?.webview.postMessage({ type: 'clearMessages' });
  }

  /**
   * Stop the current generation
   */
  private _stopGeneration(): void {
    this._currentAbortController?.abort();
    this._isStreaming = false;
    this._sendStreamingState(false);
  }

  /**
   * Send current state to webview
   */
  private _sendStateToWebview(): void {
    this._view?.webview.postMessage({
      type: 'state',
      messages: this._messages,
      models: this._models,
      selectedModelId: this._selectedModelId,
      isStreaming: this._isStreaming
    });
  }

  /**
   * Send models list to webview
   */
  private _sendModelsToWebview(): void {
    this._view?.webview.postMessage({
      type: 'models',
      models: this._models,
      selectedModelId: this._selectedModelId
    });
  }

  /**
   * Send a message to the webview
   */
  private _sendMessageToWebview(message: ChatMessage): void {
    this._view?.webview.postMessage({
      type: 'message',
      message
    });
  }

  /**
   * Stream a chunk to the webview
   */
  private _streamChunkToWebview(chunk: string): void {
    this._view?.webview.postMessage({
      type: 'streamChunk',
      chunk
    });
  }

  /**
   * Signal stream completion
   */
  private _sendStreamComplete(): void {
    this._view?.webview.postMessage({
      type: 'streamComplete'
    });
  }

  /**
   * Send streaming state to webview
   */
  private _sendStreamingState(isStreaming: boolean): void {
    this._view?.webview.postMessage({
      type: 'streamingState',
      isStreaming
    });
  }

  /**
   * Send error to webview
   */
  private _sendErrorToWebview(error: string): void {
    this._view?.webview.postMessage({
      type: 'error',
      error
    });
  }

  /**
   * Generate the HTML content for the webview
   */
  private _getHtmlContent(webview: vscode.Webview): string {
    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <title>Open LLM Chat</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* Header */
    .header {
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-shrink: 0;
    }

    .model-select {
      flex: 1;
      padding: 4px 8px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
    }

    .model-select:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }

    .header-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .header-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }

    .header-btn svg {
      width: 16px;
      height: 16px;
    }

    /* Messages */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .message {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .message-role {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }

    .message-content {
      padding: 8px 12px;
      border-radius: 8px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .message.user .message-content {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
    }

    .message.assistant .message-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }

    .message.error .message-content {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-errorForeground);
    }

    /* Code blocks */
    .message-content pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 8px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 8px 0;
    }

    .message-content code {
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
    }

    .message-content p {
      margin: 4px 0;
    }

    /* Streaming indicator */
    .streaming-cursor {
      display: inline-block;
      width: 8px;
      height: 16px;
      background: var(--vscode-editorCursor-foreground);
      animation: blink 1s step-end infinite;
      vertical-align: text-bottom;
      margin-left: 2px;
    }

    @keyframes blink {
      50% { opacity: 0; }
    }

    /* Empty state */
    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }

    .empty-state-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.5;
    }

    .empty-state-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
    }

    .empty-state-text {
      font-size: 12px;
      line-height: 1.5;
    }

    /* Input area */
    .input-area {
      padding: 12px;
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }

    .input-container {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }

    .input-wrapper {
      flex: 1;
      position: relative;
    }

    .message-input {
      width: 100%;
      min-height: 36px;
      max-height: 120px;
      padding: 8px 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      resize: none;
      outline: none;
    }

    .message-input:focus {
      border-color: var(--vscode-focusBorder);
    }

    .message-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .send-btn {
      padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .send-btn:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }

    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .stop-btn {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
    }

    /* Loading */
    .loading {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .loading-dots {
      display: flex;
      gap: 4px;
    }

    .loading-dots span {
      width: 6px;
      height: 6px;
      background: var(--vscode-foreground);
      border-radius: 50%;
      animation: bounce 1.4s ease-in-out infinite;
    }

    .loading-dots span:nth-child(1) { animation-delay: 0s; }
    .loading-dots span:nth-child(2) { animation-delay: 0.2s; }
    .loading-dots span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes bounce {
      0%, 80%, 100% { transform: scale(0); }
      40% { transform: scale(1); }
    }

    /* No models state */
    .no-models {
      padding: 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }

    .no-models a {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }

    .no-models a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="header">
    <select class="model-select" id="modelSelect" title="Select model">
      <option value="">Loading models...</option>
    </select>
    <button class="header-btn" id="refreshBtn" title="Refresh models">
      <svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M13.451 5.609l-.579-.939-1.068.812-.076.094c-.335.415-.927 1.341-1.124 2.876l-.021.165.033.163.071.345c.074.37.124.757.124 1.18a4.811 4.811 0 01-9.622 0H0a6.81 6.81 0 106.81-6.81v2h-.337l.394-.396-.004-.004.947-.946-.947-.947-.003.004-.394-.396h.337v-2A6.81 6.81 0 000 7.695h1a5.81 5.81 0 015.81-5.81v2.001l-.947.946.947.947.394-.396-.003-.004-.394-.396.337.001V3.984A5.811 5.811 0 1111.621 10.305h-2c0 .423-.05.81-.124 1.18l-.071.345-.033.163.021.165c.197 1.535.789 2.461 1.124 2.876l.076.094 1.068.812.579-.939-.812-1.068-.094-.076c-.415-.335-1.341-.927-2.876-1.124l-.165-.021-.163.033-.345.071c-.37.074-.757.124-1.18.124a4.811 4.811 0 010-9.622v-2a6.81 6.81 0 110 13.62z"/>
      </svg>
    </button>
    <button class="header-btn" id="clearBtn" title="Clear chat">
      <svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 13A6 6 0 118 2a6 6 0 010 12zm3.5-9h-7l.75 9h5.5l.75-9zM7 6v5H6V6h1zm2 0v5h1V6H9z"/>
      </svg>
    </button>
  </div>

  <div class="messages" id="messages">
    <div class="empty-state" id="emptyState">
      <div class="empty-state-icon">💬</div>
      <div class="empty-state-title">Open LLM Chat</div>
      <div class="empty-state-text">
        Ask questions, get help with code, or have a conversation with your configured AI models.
      </div>
    </div>
  </div>

  <div class="input-area">
    <div class="input-container">
      <div class="input-wrapper">
        <textarea 
          class="message-input" 
          id="messageInput" 
          placeholder="Ask anything..."
          rows="1"
        ></textarea>
      </div>
      <button class="send-btn" id="sendBtn">
        Send
      </button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    
    // State
    let isStreaming = false;
    let currentStreamingMessageEl = null;
    let models = [];
    let selectedModelId = '';

    // Elements
    const messagesEl = document.getElementById('messages');
    const emptyStateEl = document.getElementById('emptyState');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const modelSelect = document.getElementById('modelSelect');
    const clearBtn = document.getElementById('clearBtn');
    const refreshBtn = document.getElementById('refreshBtn');

    // Auto-resize textarea
    messageInput.addEventListener('input', () => {
      messageInput.style.height = 'auto';
      messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
    });

    // Send message on Enter (Shift+Enter for newline)
    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Send button click
    sendBtn.addEventListener('click', () => {
      if (isStreaming) {
        stopGeneration();
      } else {
        sendMessage();
      }
    });

    // Model select
    modelSelect.addEventListener('change', () => {
      selectedModelId = modelSelect.value;
      vscode.postMessage({ type: 'selectModel', modelId: selectedModelId });
    });

    // Clear button
    clearBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'clearChat' });
    });

    // Refresh button
    refreshBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshModels' });
    });

    function sendMessage() {
      const text = messageInput.value.trim();
      if (!text || isStreaming) return;
      
      if (!selectedModelId) {
        showError('Please select a model first.');
        return;
      }

      vscode.postMessage({ type: 'sendMessage', text });
      messageInput.value = '';
      messageInput.style.height = 'auto';
    }

    function stopGeneration() {
      vscode.postMessage({ type: 'stopGeneration' });
    }

    function addMessage(message) {
      emptyStateEl.style.display = 'none';
      
      const messageEl = document.createElement('div');
      messageEl.className = 'message ' + message.role;
      
      const roleEl = document.createElement('div');
      roleEl.className = 'message-role';
      roleEl.textContent = message.role === 'user' ? 'You' : 'Assistant';
      
      const contentEl = document.createElement('div');
      contentEl.className = 'message-content';
      contentEl.innerHTML = formatContent(message.content);
      
      messageEl.appendChild(roleEl);
      messageEl.appendChild(contentEl);
      messagesEl.appendChild(messageEl);
      
      scrollToBottom();
      
      return messageEl;
    }

    function startStreaming() {
      emptyStateEl.style.display = 'none';
      
      const messageEl = document.createElement('div');
      messageEl.className = 'message assistant';
      
      const roleEl = document.createElement('div');
      roleEl.className = 'message-role';
      roleEl.textContent = 'Assistant';
      
      const contentEl = document.createElement('div');
      contentEl.className = 'message-content';
      contentEl.innerHTML = '<span class="streaming-cursor"></span>';
      
      messageEl.appendChild(roleEl);
      messageEl.appendChild(contentEl);
      messagesEl.appendChild(messageEl);
      
      currentStreamingMessageEl = contentEl;
      scrollToBottom();
    }

    function appendStreamChunk(chunk) {
      if (!currentStreamingMessageEl) {
        startStreaming();
      }
      
      // Remove cursor, append chunk, add cursor back
      const cursor = currentStreamingMessageEl.querySelector('.streaming-cursor');
      if (cursor) cursor.remove();
      
      // Get current text content
      let currentText = currentStreamingMessageEl.textContent || '';
      currentText += chunk;
      
      // Format and display
      currentStreamingMessageEl.innerHTML = formatContent(currentText) + '<span class="streaming-cursor"></span>';
      scrollToBottom();
    }

    function finishStreaming() {
      if (currentStreamingMessageEl) {
        const cursor = currentStreamingMessageEl.querySelector('.streaming-cursor');
        if (cursor) cursor.remove();
        currentStreamingMessageEl = null;
      }
    }

    function showError(error) {
      const messageEl = document.createElement('div');
      messageEl.className = 'message error';
      
      const roleEl = document.createElement('div');
      roleEl.className = 'message-role';
      roleEl.textContent = 'Error';
      
      const contentEl = document.createElement('div');
      contentEl.className = 'message-content';
      contentEl.textContent = error;
      
      messageEl.appendChild(roleEl);
      messageEl.appendChild(contentEl);
      messagesEl.appendChild(messageEl);
      
      finishStreaming();
      scrollToBottom();
    }

    function clearMessages() {
      messagesEl.innerHTML = '';
      messagesEl.appendChild(emptyStateEl);
      emptyStateEl.style.display = 'flex';
      currentStreamingMessageEl = null;
    }

    function updateModels(newModels, newSelectedId) {
      models = newModels;
      selectedModelId = newSelectedId;
      
      modelSelect.innerHTML = '';
      
      if (models.length === 0) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No models available';
        modelSelect.appendChild(option);
        return;
      }
      
      models.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        if (model.id === selectedModelId) {
          option.selected = true;
        }
        modelSelect.appendChild(option);
      });
    }

    function updateStreamingState(streaming) {
      isStreaming = streaming;
      
      if (streaming) {
        sendBtn.textContent = 'Stop';
        sendBtn.classList.add('stop-btn');
        messageInput.disabled = true;
        startStreaming();
      } else {
        sendBtn.textContent = 'Send';
        sendBtn.classList.remove('stop-btn');
        messageInput.disabled = false;
        messageInput.focus();
      }
    }

    function formatContent(text) {
      if (!text) return '';
      
      // Simple markdown-like formatting
      let html = escapeHtml(text);
      
      // Code blocks
      html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
      
      // Inline code
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      
      // Bold
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      
      // Italic
      html = html.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      
      // Line breaks
      html = html.replace(/\\n/g, '<br>');
      
      return html;
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function scrollToBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // Handle messages from extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      
      switch (message.type) {
        case 'state':
          updateModels(message.models, message.selectedModelId);
          message.messages.forEach(m => addMessage(m));
          updateStreamingState(message.isStreaming);
          break;
        case 'models':
          updateModels(message.models, message.selectedModelId);
          break;
        case 'message':
          addMessage(message.message);
          break;
        case 'streamChunk':
          appendStreamChunk(message.chunk);
          break;
        case 'streamComplete':
          finishStreaming();
          break;
        case 'streamingState':
          updateStreamingState(message.isStreaming);
          break;
        case 'error':
          showError(message.error);
          break;
        case 'clearMessages':
          clearMessages();
          break;
      }
    });

    // Signal ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  /**
   * Generate a nonce for CSP
   */
  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
