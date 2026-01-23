import * as vscode from 'vscode';
import { OpenLLMProvider } from '../core/OpenLLMProvider';
import { getLogger } from '../utils/logger';
import { Tool, ToolCall } from '../types';

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  modelId: string;
  createdAt: number;
  updatedAt: number;
}

interface ChatModel {
  id: string;
  name: string;
  vendor: string;
  isVSCodeLM: boolean;
}

/**
 * Provides the Chat sidebar webview for "Ask" mode interactions
 * Styled to match Copilot Chat UI
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'openLLM.chatView';
  private static readonly SESSIONS_KEY = 'openLLM.chatSessions';
  private static readonly CURRENT_SESSION_KEY = 'openLLM.currentSessionId';
  private static readonly MAX_SESSIONS = 50;

  private _view?: vscode.WebviewView;
  private _sessions: ChatSession[] = [];
  private _currentSession: ChatSession | null = null;
  private _models: ChatModel[] = [];
  private _selectedModelId: string = '';
  private _isStreaming: boolean = false;
  private _tokenSource?: vscode.CancellationTokenSource;
  private _logger = getLogger();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _openLLMProvider: OpenLLMProvider,
    private readonly _globalState: vscode.Memento
  ) {
    this._loadSessions();
  }

  /**
   * Public API: Send a message to the chat UI from an external extension.
   * This will focus the chat panel, create a new session if needed,
   * and send the message with optional file context.
   */
  public async sendMessage(message: string, options?: {
    context?: Array<{ path: string; name: string; language: string; content: string }>;
    newSession?: boolean;
  }): Promise<void> {
    // Focus the chat panel first
    await vscode.commands.executeCommand('openLLM.chatView.focus');
    
    // Wait a bit for the webview to be ready
    await new Promise(resolve => setTimeout(resolve, 200));
    
    // Create a new session if requested or if none exists
    if (options?.newSession || !this._currentSession) {
      this._createNewSession();
    }
    
    // Refresh models if needed
    if (this._models.length === 0) {
      await this._refreshModels();
    }
    
    // Send the message
    await this._handleUserMessage(message, options?.context);
  }

  /**
   * Public API: Get available models for external extensions
   */
  public getAvailableModels(): ChatModel[] {
    return [...this._models];
  }

  /**
   * Public API: Set the model to use for chat
   */
  public setModel(modelId: string): boolean {
    const model = this._models.find(m => m.id === modelId);
    if (model) {
      this._selectedModelId = modelId;
      if (this._currentSession) {
        this._currentSession.modelId = modelId;
      }
      this._sendModelsToWebview();
      return true;
    }
    return false;
  }

  /**
   * Load sessions from storage
   */
  private _loadSessions(): void {
    this._sessions = this._globalState.get<ChatSession[]>(ChatViewProvider.SESSIONS_KEY, []);
    const currentSessionId = this._globalState.get<string>(ChatViewProvider.CURRENT_SESSION_KEY);
    
    if (currentSessionId) {
      this._currentSession = this._sessions.find(s => s.id === currentSessionId) || null;
    }
    
    if (!this._currentSession) {
      this._createNewSession();
    }
  }

  /**
   * Save sessions to storage
   */
  private async _saveSessions(): Promise<void> {
    // Keep only the most recent sessions
    const sessionsToSave = this._sessions.slice(0, ChatViewProvider.MAX_SESSIONS);
    await this._globalState.update(ChatViewProvider.SESSIONS_KEY, sessionsToSave);
    await this._globalState.update(ChatViewProvider.CURRENT_SESSION_KEY, this._currentSession?.id);
  }

  /**
   * Create a new chat session
   */
  private _createNewSession(): ChatSession {
    const session: ChatSession = {
      id: this._generateId(),
      title: 'New Chat',
      messages: [],
      modelId: this._selectedModelId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    
    this._sessions.unshift(session);
    this._currentSession = session;
    this._saveSessions();
    
    return session;
  }

  /**
   * Generate a title from the first user message
   */
  private _generateTitle(message: string): string {
    const maxLength = 40;
    const cleaned = message.replace(/\n/g, ' ').trim();
    if (cleaned.length <= maxLength) {
      return cleaned;
    }
    return cleaned.substring(0, maxLength - 3) + '...';
  }

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
          this._sendFullState();
          break;
        case 'sendMessage':
          await this._handleUserMessage(message.text, message.context);
          break;
        case 'selectModel':
          this._selectedModelId = message.modelId;
          if (this._currentSession) {
            this._currentSession.modelId = message.modelId;
            this._saveSessions();
          }
          break;
        case 'newChat':
          this._createNewSession();
          this._sendFullState();
          break;
        case 'selectSession':
          this._selectSession(message.sessionId);
          break;
        case 'deleteSession':
          this._deleteSession(message.sessionId);
          break;
        case 'stopGeneration':
          this._stopGeneration();
          break;
        case 'refreshModels':
          await this._refreshModels();
          break;
        case 'updateSystemPrompt':
          await this._updateSystemPrompt(message.prompt);
          break;
        case 'runInTerminal':
          await this._runInTerminal(message.command);
          break;
        case 'showAttachMenu':
          await this._showAttachMenu();
          break;
      }
    });

    // Listen for model changes
    vscode.lm.onDidChangeChatModels(() => {
      this._refreshModels();
    });
  }

  /**
   * Select a session
   */
  private _selectSession(sessionId: string): void {
    const session = this._sessions.find(s => s.id === sessionId);
    if (session) {
      this._currentSession = session;
      this._selectedModelId = session.modelId || this._selectedModelId;
      this._saveSessions();
      this._sendFullState();
    }
  }

  /**
   * Delete a session
   */
  private _deleteSession(sessionId: string): void {
    const index = this._sessions.findIndex(s => s.id === sessionId);
    if (index >= 0) {
      this._sessions.splice(index, 1);
      
      // If we deleted the current session, switch to another or create new
      if (this._currentSession?.id === sessionId) {
        if (this._sessions.length > 0) {
          this._currentSession = this._sessions[0];
        } else {
          this._createNewSession();
        }
      }
      
      this._saveSessions();
      this._sendFullState();
    }
  }

  /**
   * Refresh the list of available models
   */
  private async _refreshModels(): Promise<void> {
    this._models = [];

    try {
      const lmModels = await vscode.lm.selectChatModels({});
      for (const model of lmModels) {
        this._models.push({
          id: `vscode-lm:${model.vendor}/${model.id}`,
          name: `${model.name}`,
          vendor: model.vendor,
          isVSCodeLM: true
        });
      }
    } catch (error) {
      this._logger.warn('Failed to get vscode.lm models:', error);
    }

    const openLLMModels = this._openLLMProvider.getAvailableModels();
    for (const model of openLLMModels) {
      const existingId = `vscode-lm:open-llm/${model.id}`;
      if (!this._models.find(m => m.id === existingId)) {
        this._models.push({
          id: `direct:${model.id}`,
          name: `${model.name}`,
          vendor: model.provider,
          isVSCodeLM: false
        });
      }
    }

    if (!this._selectedModelId && this._models.length > 0) {
      this._selectedModelId = this._models[0].id;
    }

    this._sendModelsToWebview();
  }

  /**
   * Handle a user message submission
   */
  private async _handleUserMessage(text: string, context?: Array<{path: string, name: string, language: string, content: string}>): Promise<void> {
    if (!text.trim() || this._isStreaming || !this._currentSession) {
      return;
    }

    // Build the full message with context
    let fullContent = text.trim();
    if (context && context.length > 0) {
      const contextParts = context.map(file => 
        `**File: ${file.name}** (\`${file.language}\`)\n\`\`\`${file.language}\n${file.content}\n\`\`\``
      );
      fullContent = `${contextParts.join('\n\n')}\n\n${text.trim()}`;
    }

    const userMessage: ChatMessage = {
      role: 'user',
      content: fullContent,
      timestamp: Date.now()
    };
    
    this._currentSession.messages.push(userMessage);
    
    // Update title if this is the first message
    if (this._currentSession.messages.length === 1) {
      this._currentSession.title = this._generateTitle(text);
    }
    
    this._currentSession.updatedAt = Date.now();
    this._sendMessageToWebview(userMessage);
    this._sendSessionsToWebview();

    // Start streaming
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
        throw new Error('No model selected. Please select a model.');
      }

      this._tokenSource = new vscode.CancellationTokenSource();
      
      // Build messages array with system prompt
      const systemPrompt = this._getSystemPrompt();
      const vsMessages: vscode.LanguageModelChatMessage[] = [];
      
      // Add system prompt as first message (if configured)
      if (systemPrompt) {
        vsMessages.push(vscode.LanguageModelChatMessage.User(`[System Instructions]\n${systemPrompt}\n\n[User Query]`));
      }
      
      // Add conversation history
      this._currentSession.messages
        .filter(m => m.role !== 'system')
        .forEach(m => {
          if (m.role === 'user') {
            vsMessages.push(vscode.LanguageModelChatMessage.User(m.content));
          } else {
            vsMessages.push(vscode.LanguageModelChatMessage.Assistant(m.content));
          }
        });

      // Get available tools from vscode.lm
      const availableTools = this._getAvailableTools();
      const enableTools = availableTools.length > 0 && this._isToolsEnabled();

      if (selectedModel.isVSCodeLM) {
        // Use vscode.lm API with tool orchestration
        await this._streamWithToolsVSCodeLM(selectedModel, vsMessages, assistantMessage, enableTools ? availableTools : undefined);
      } else {
        // Use direct provider with tool orchestration
        await this._streamWithToolsDirect(selectedModel, vsMessages, assistantMessage, enableTools ? availableTools : undefined);
      }

      this._currentSession.messages.push(assistantMessage);
      this._currentSession.updatedAt = Date.now();
      this._saveSessions();
      this._sendStreamComplete();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._logger.error('Chat error:', error);
      assistantMessage.content = `Error: ${errorMessage}`;
      this._currentSession.messages.push(assistantMessage);
      this._sendErrorToWebview(errorMessage);
    } finally {
      this._isStreaming = false;
      this._tokenSource?.dispose();
      this._tokenSource = undefined;
      this._sendStreamingState(false);
    }
  }

  /**
   * Stream response using vscode.lm API with tool orchestration
   */
  private async _streamWithToolsVSCodeLM(
    selectedModel: ChatModel,
    vsMessages: vscode.LanguageModelChatMessage[],
    assistantMessage: ChatMessage,
    tools?: Tool[]
  ): Promise<void> {
    const [vendor, modelId] = selectedModel.id.replace('vscode-lm:', '').split('/');
    const models = await vscode.lm.selectChatModels({ vendor, id: modelId });
    
    if (models.length === 0) {
      throw new Error(`Model ${selectedModel.name} is no longer available.`);
    }

    const model = models[0];
    const MAX_TOOL_ITERATIONS = 10;
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      // Convert tools to vscode format
      const vsTools = tools?.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema
      })) as vscode.LanguageModelChatTool[] | undefined;

      const response = await model.sendRequest(
        vsMessages,
        { tools: vsTools },
        this._tokenSource!.token
      );

      const toolCalls: ToolCall[] = [];
      let hasText = false;

      for await (const part of response.stream) {
        if (this._tokenSource!.token.isCancellationRequested) break;

        if (part instanceof vscode.LanguageModelTextPart) {
          hasText = true;
          assistantMessage.content += part.value;
          this._streamChunkToWebview(part.value);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            name: part.name,
            input: part.input as Record<string, unknown>
          });
        }
      }

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        break;
      }

      // Process tool calls
      this._logger.info(`Processing ${toolCalls.length} tool calls`);
      
      // Add assistant message with tool calls
      vsMessages.push(vscode.LanguageModelChatMessage.Assistant(
        toolCalls.map(tc => new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.input))
      ));

      // Execute each tool and collect results
      const toolResults: vscode.LanguageModelToolResultPart[] = [];
      
      for (const toolCall of toolCalls) {
        // Show tool call in UI
        this._sendToolCallToWebview(toolCall);
        assistantMessage.content += `\n\n🔧 **Calling tool:** ${toolCall.name}\n`;
        this._streamChunkToWebview(`\n\n🔧 **Calling tool:** ${toolCall.name}\n`);

        try {
          const result = await vscode.lm.invokeTool(toolCall.name, {
            input: toolCall.input,
            toolInvocationToken: undefined
          }, this._tokenSource!.token);

          // Format result as text
          const resultText = result.content
            .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
            .map(p => p.value)
            .join('');

          toolResults.push(new vscode.LanguageModelToolResultPart(toolCall.id, result.content));
          
          // Show result in UI
          this._sendToolResultToWebview(toolCall.id, resultText);
          const truncatedResult = resultText.length > 200 ? resultText.substring(0, 200) + '...' : resultText;
          assistantMessage.content += `\n✅ **Result:** ${truncatedResult}\n`;
          this._streamChunkToWebview(`\n✅ **Result:** ${truncatedResult}\n`);

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this._logger.error(`Tool ${toolCall.name} failed:`, error);
          
          toolResults.push(new vscode.LanguageModelToolResultPart(
            toolCall.id,
            [new vscode.LanguageModelTextPart(`Error: ${errorMsg}`)]
          ));
          
          assistantMessage.content += `\n❌ **Error:** ${errorMsg}\n`;
          this._streamChunkToWebview(`\n❌ **Error:** ${errorMsg}\n`);
        }
      }

      // Add tool results to messages
      vsMessages.push(vscode.LanguageModelChatMessage.User(toolResults));

      // Continue the loop to get the model's response to tool results
    }
  }

  /**
   * Stream response using direct provider with tool orchestration
   */
  private async _streamWithToolsDirect(
    selectedModel: ChatModel,
    vsMessages: vscode.LanguageModelChatMessage[],
    assistantMessage: ChatMessage,
    tools?: Tool[]
  ): Promise<void> {
    const modelId = selectedModel.id.replace('direct:', '');
    const MAX_TOOL_ITERATIONS = 10;
    let iteration = 0;

    while (iteration < MAX_TOOL_ITERATIONS) {
      iteration++;

      const stream = await this._openLLMProvider.sendRequestWithTools(
        modelId,
        vsMessages,
        { tools },
        this._tokenSource!.token
      );

      const toolCalls: ToolCall[] = [];

      for await (const chunk of stream) {
        if (this._tokenSource!.token.isCancellationRequested) break;

        if (chunk.type === 'text') {
          assistantMessage.content += chunk.text;
          this._streamChunkToWebview(chunk.text);
        } else if (chunk.type === 'tool_call') {
          toolCalls.push(chunk.toolCall);
        }
      }

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        break;
      }

      // Process tool calls
      this._logger.info(`Processing ${toolCalls.length} tool calls (direct)`);

      // Add assistant message with tool calls
      vsMessages.push(vscode.LanguageModelChatMessage.Assistant(
        toolCalls.map(tc => new vscode.LanguageModelToolCallPart(tc.id, tc.name, tc.input))
      ));

      // Execute each tool
      const toolResults: vscode.LanguageModelToolResultPart[] = [];

      for (const toolCall of toolCalls) {
        this._sendToolCallToWebview(toolCall);
        assistantMessage.content += `\n\n🔧 **Calling tool:** ${toolCall.name}\n`;
        this._streamChunkToWebview(`\n\n🔧 **Calling tool:** ${toolCall.name}\n`);

        try {
          const result = await vscode.lm.invokeTool(toolCall.name, {
            input: toolCall.input,
            toolInvocationToken: undefined
          }, this._tokenSource!.token);

          const resultText = result.content
            .filter((p): p is vscode.LanguageModelTextPart => p instanceof vscode.LanguageModelTextPart)
            .map(p => p.value)
            .join('');

          toolResults.push(new vscode.LanguageModelToolResultPart(toolCall.id, result.content));
          
          this._sendToolResultToWebview(toolCall.id, resultText);
          const truncatedResult = resultText.length > 200 ? resultText.substring(0, 200) + '...' : resultText;
          assistantMessage.content += `\n✅ **Result:** ${truncatedResult}\n`;
          this._streamChunkToWebview(`\n✅ **Result:** ${truncatedResult}\n`);

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this._logger.error(`Tool ${toolCall.name} failed:`, error);
          
          toolResults.push(new vscode.LanguageModelToolResultPart(
            toolCall.id,
            [new vscode.LanguageModelTextPart(`Error: ${errorMsg}`)]
          ));
          
          assistantMessage.content += `\n❌ **Error:** ${errorMsg}\n`;
          this._streamChunkToWebview(`\n❌ **Error:** ${errorMsg}\n`);
        }
      }

      // Add tool results
      vsMessages.push(vscode.LanguageModelChatMessage.User(toolResults));
    }
  }

  /**
   * Get available tools from vscode.lm
   */
  private _getAvailableTools(): Tool[] {
    try {
      const tools = vscode.lm.tools;
      this._logger.info(`Available tools from vscode.lm.tools: ${tools.length}`);
      tools.forEach(t => {
        this._logger.debug(`  Tool: ${t.name} - ${t.description?.substring(0, 50) || 'no description'}`);
      });
      return tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>
      }));
    } catch (e) {
      this._logger.error('Error getting tools:', e);
      return [];
    }
  }

  /**
   * Check if tools are enabled in settings
   */
  private _isToolsEnabled(): boolean {
    const config = vscode.workspace.getConfiguration('openLLM');
    return config.get<boolean>('chat.enableTools', true);
  }

  /**
   * Send tool call notification to webview
   */
  private _sendToolCallToWebview(toolCall: ToolCall): void {
    this._view?.webview.postMessage({
      type: 'toolCall',
      toolCall: {
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input
      }
    });
  }

  /**
   * Send tool result notification to webview
   */
  private _sendToolResultToWebview(callId: string, result: string): void {
    this._view?.webview.postMessage({
      type: 'toolResult',
      callId,
      result
    });
  }

  public clearChat(): void {
    this._createNewSession();
    this._sendFullState();
  }

  private _stopGeneration(): void {
    this._tokenSource?.cancel();
    this._isStreaming = false;
    this._sendStreamingState(false);
  }

  /**
   * Get the system prompt from settings
   */
  private _getSystemPrompt(): string {
    const config = vscode.workspace.getConfiguration('openLLM.chat');
    return config.get<string>('systemPrompt', '');
  }

  /**
   * Update system prompt in settings
   */
  private async _updateSystemPrompt(prompt: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('openLLM.chat');
    await config.update('systemPrompt', prompt, vscode.ConfigurationTarget.Global);
  }

  /**
   * Show attach menu with options
   */
  private async _showAttachMenu(): Promise<void> {
    const items: vscode.QuickPickItem[] = [];
    
    // Add current file option if there's an active editor
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.document.isUntitled) {
      const fileName = editor.document.fileName.split('/').pop() || editor.document.fileName;
      items.push({
        label: '$(file) Current File',
        description: fileName,
        detail: 'Attach the currently open file as context'
      });
    }
    
    // Add browse option
    items.push({
      label: '$(folder-opened) Browse Files...',
      description: '',
      detail: 'Select files from the workspace'
    });

    const selection = await vscode.window.showQuickPick(items, {
      placeHolder: 'Attach file as context',
      title: 'Attach Context'
    });

    if (!selection) return;

    if (selection.label.includes('Current File') && editor) {
      const content = editor.document.getText();
      const fileName = editor.document.fileName.split('/').pop() || 'file';
      
      this._view?.webview.postMessage({
        type: 'activeFile',
        file: {
          path: editor.document.fileName,
          name: fileName,
          language: editor.document.languageId,
          content: content.length > 50000 ? content.substring(0, 50000) + '\n... (truncated)' : content
        }
      });
    } else if (selection.label.includes('Browse')) {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach',
        filters: {
          'All Files': ['*']
        }
      });

      if (files) {
        for (const file of files) {
          try {
            const doc = await vscode.workspace.openTextDocument(file);
            const content = doc.getText();
            const fileName = file.path.split('/').pop() || 'file';
            
            this._view?.webview.postMessage({
              type: 'attachedFile',
              file: {
                path: file.path,
                name: fileName,
                language: doc.languageId,
                content: content.length > 50000 ? content.substring(0, 50000) + '\n... (truncated)' : content
              }
            });
          } catch (e) {
            this._logger.error('Failed to read file:', e);
          }
        }
      }
    }
  }

  /**
   * Run a command in the terminal
   */
  private async _runInTerminal(command: string): Promise<void> {
    // Reuse existing terminal if still open, otherwise create new
    let terminal = vscode.window.terminals.find(t => t.name === 'Open LLM');
    
    if (terminal) {
      // Terminal already exists and is initialized - can send immediately
      terminal.show();
      terminal.sendText(command, false);
      return;
    }
    
    // Create new terminal
    terminal = vscode.window.createTerminal('Open LLM');
    terminal.show();
    
    // Wait for shell integration if available (VS Code 1.93+)
    const hasShellIntegration = typeof vscode.window.onDidChangeTerminalShellIntegration === 'function';
    
    if (hasShellIntegration) {
      await new Promise<void>((resolve) => {
        const terminalRef = terminal!;
        const disposable = vscode.window.onDidChangeTerminalShellIntegration!(e => {
          if (e.terminal === terminalRef) {
            disposable.dispose();
            resolve();
          }
        });
        
        // Fallback timeout if shell integration not available or slow
        setTimeout(() => {
          disposable.dispose();
          resolve();
        }, 1000);
      });
    } else {
      // Fallback for older VS Code versions
      try {
        await terminal.processId;
      } catch { /* ignore */ }
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    
    terminal.sendText(command, false);
  }

  private _sendFullState(): void {
    this._view?.webview.postMessage({
      type: 'fullState',
      sessions: this._sessions.map(s => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length
      })),
      currentSessionId: this._currentSession?.id,
      messages: this._currentSession?.messages || [],
      models: this._models,
      selectedModelId: this._selectedModelId,
      isStreaming: this._isStreaming,
      systemPrompt: this._getSystemPrompt()
    });
  }

  private _sendSessionsToWebview(): void {
    this._view?.webview.postMessage({
      type: 'sessions',
      sessions: this._sessions.map(s => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length
      })),
      currentSessionId: this._currentSession?.id
    });
  }

  private _sendModelsToWebview(): void {
    this._view?.webview.postMessage({
      type: 'models',
      models: this._models,
      selectedModelId: this._selectedModelId
    });
  }

  private _sendMessageToWebview(message: ChatMessage): void {
    this._view?.webview.postMessage({ type: 'message', message });
  }

  private _streamChunkToWebview(chunk: string): void {
    this._view?.webview.postMessage({ type: 'streamChunk', chunk });
  }

  private _sendStreamComplete(): void {
    this._view?.webview.postMessage({ type: 'streamComplete' });
  }

  private _sendStreamingState(isStreaming: boolean): void {
    this._view?.webview.postMessage({ type: 'streamingState', isStreaming });
  }

  private _sendErrorToWebview(error: string): void {
    this._view?.webview.postMessage({ type: 'error', error });
  }

  private _generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const nonce = this._getNonce();
    
    // Get codicon font URI
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
    );
    
    // Get marked library URI
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', 'marked', 'lib', 'marked.umd.js')
    );
    
    // Get highlight.js URIs (offline bundle)
    const hljsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@highlightjs', 'cdn-assets', 'highlight.min.js')
    );
    const hljsStyleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'node_modules', '@highlightjs', 'cdn-assets', 'styles', 'vs2015.min.css')
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <link href="${codiconsUri}" rel="stylesheet" />
  <link href="${hljsStyleUri}" rel="stylesheet" />
  <script src="${markedUri}" nonce="${nonce}"></script>
  <script src="${hljsUri}" nonce="${nonce}"></script>
  <title>Open LLM Chat</title>
  <style>
    :root {
      --header-height: 36px;
      --input-area-min-height: 100px;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    /* ===== HEADER ===== */
    .header {
      height: var(--header-height);
      padding: 0 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      background: var(--vscode-sideBar-background);
    }

    .header-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-foreground);
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .icon-btn {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-radius: 4px;
      color: var(--vscode-foreground);
      cursor: pointer;
      opacity: 0.8;
    }

    .icon-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }

    /* ===== SESSIONS PANEL ===== */
    .sessions-panel {
      border-bottom: 1px solid var(--vscode-panel-border);
      max-height: 150px;
      overflow: hidden;
      flex-shrink: 0;
    }

    .sessions-header {
      padding: 6px 12px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
    }

    .sessions-header:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .sessions-list {
      max-height: 100px;
      overflow-y: auto;
    }

    .session-item {
      padding: 6px 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 12px;
    }

    .session-item:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .session-item.active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .session-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--vscode-textLink-foreground);
      flex-shrink: 0;
    }

    .session-item:not(.active) .session-dot {
      background: var(--vscode-descriptionForeground);
      opacity: 0.5;
    }

    .session-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-time {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      flex-shrink: 0;
    }

    .session-delete {
      opacity: 0;
      transition: opacity 0.1s;
    }

    .session-item:hover .session-delete {
      opacity: 1;
    }

    .show-more {
      padding: 4px 12px;
      font-size: 11px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      text-align: center;
    }

    .show-more:hover {
      text-decoration: underline;
    }

    /* ===== MESSAGES AREA ===== */
    .messages-container {
      flex: 1;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }

    .messages {
      padding: 16px 12px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    /* Empty state - Copilot style */
    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 32px 24px;
      text-align: center;
    }

    .empty-icon {
      width: 48px;
      height: 48px;
      margin-bottom: 16px;
      opacity: 0.6;
    }

    .empty-icon svg {
      width: 100%;
      height: 100%;
      color: var(--vscode-foreground);
    }

    .empty-title {
      font-size: 16px;
      font-weight: 500;
      margin-bottom: 8px;
      color: var(--vscode-foreground);
    }

    .empty-subtitle {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.5;
    }

    /* Messages - User bubble right, Assistant plain text */
    .message {
      display: flex;
      flex-direction: column;
    }

    .message.user {
      align-self: flex-end;
      max-width: 85%;
    }

    .message.assistant {
      align-self: stretch;
      max-width: 100%;
    }

    .message-content {
      font-size: 13px;
      line-height: 1.6;
      color: var(--vscode-foreground);
    }

    /* User messages: bubble style */
    .message.user .message-content {
      padding: 10px 14px;
      border-radius: 12px;
      border-bottom-right-radius: 4px;
      background: #2b5278;
      color: #e8e8e8;
    }

    /* Assistant messages: plain markdown */
    .message.assistant .message-content {
      padding: 4px 0;
    }

    /* Markdown elements - tight spacing */
    .message-content h1 { font-size: 1.3em; font-weight: 600; margin: 12px 0 6px 0; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .message-content h1:first-child { margin-top: 0; }
    .message-content h2 { font-size: 1.15em; font-weight: 600; margin: 10px 0 4px 0; }
    .message-content h2:first-child { margin-top: 0; }
    .message-content h3 { font-size: 1.05em; font-weight: 600; margin: 8px 0 4px 0; }
    .message-content h3:first-child { margin-top: 0; }
    .message-content p { margin: 0 0 8px 0; }
    .message-content p:last-child { margin-bottom: 0; }
    .message-content ul, .message-content ol { margin: 6px 0; padding-left: 20px; }
    .message-content li { margin: 2px 0; }
    .message-content li > p { margin: 0; }
    .message-content > *:first-child { margin-top: 0; }
    .message-content > *:last-child { margin-bottom: 0; }

    /* Code blocks with language label */
    .code-block {
      margin: 8px 0;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      overflow: hidden;
    }

    .code-block-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 10px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .code-block pre {
      margin: 0;
      padding: 10px;
      background: var(--vscode-textCodeBlock-background);
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family);
      font-size: 12px;
      line-height: 1.4;
    }
    
    .code-block:first-child { margin-top: 0; }
    .code-block:last-child { margin-bottom: 0; }

    .code-block-actions {
      display: flex;
      gap: 4px;
    }

    .code-action-btn {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .code-action-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .code-action-btn.copied {
      color: var(--vscode-testing-iconPassed);
    }

    /* Response actions (copy entire response) */
    .message.assistant .message-actions {
      display: flex;
      gap: 4px;
      margin-top: 8px;
      opacity: 0;
      transition: opacity 0.15s;
    }

    .message.assistant:hover .message-actions {
      opacity: 1;
    }

    .response-action-btn {
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .response-action-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-foreground);
    }

    .response-action-btn.copied {
      color: var(--vscode-testing-iconPassed);
      border-color: var(--vscode-testing-iconPassed);
    }

    .code-block pre code {
      background: none;
      padding: 0;
    }

    .message-content code {
      font-family: var(--vscode-editor-font-family);
      background: var(--vscode-textCodeBlock-background);
      padding: 2px 5px;
      border-radius: 3px;
      font-size: 12px;
    }

    .message.user .message-content code {
      background: rgba(0,0,0,0.2);
    }

    .message.error .message-content {
      padding: 10px 14px;
      border-radius: 8px;
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      color: var(--vscode-errorForeground);
    }

    /* Settings modal */
    .settings-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 100;
    }

    .settings-overlay.visible {
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .settings-modal {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      width: 90%;
      max-width: 500px;
      max-height: 80%;
      display: flex;
      flex-direction: column;
      box-shadow: 0 8px 32px rgba(0,0,0,0.3);
    }

    .settings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .settings-header h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }

    .settings-close {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 4px;
      opacity: 0.7;
    }

    .settings-close:hover {
      opacity: 1;
    }

    .settings-body {
      padding: 16px;
      overflow-y: auto;
    }

    .settings-body label {
      display: block;
      font-size: 12px;
      font-weight: 500;
      margin-bottom: 6px;
      color: var(--vscode-foreground);
    }

    .settings-body textarea {
      width: 100%;
      min-height: 120px;
      padding: 10px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 4px;
      font-family: var(--vscode-font-family);
      font-size: 12px;
      resize: vertical;
    }

    .settings-body textarea:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .settings-body .hint {
      margin-top: 8px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .settings-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .settings-footer button {
      padding: 6px 14px;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
    }

    .settings-footer .btn-secondary {
      background: transparent;
      border: 1px solid var(--vscode-button-secondaryBackground);
      color: var(--vscode-foreground);
    }

    .settings-footer .btn-primary {
      background: var(--vscode-button-background);
      border: none;
      color: var(--vscode-button-foreground);
    }

    /* Streaming cursor */
    .streaming-cursor {
      display: inline-block;
      width: 2px;
      height: 14px;
      background: var(--vscode-editorCursor-foreground);
      margin-left: 1px;
      animation: blink 1s step-end infinite;
      vertical-align: text-bottom;
    }

    @keyframes blink {
      50% { opacity: 0; }
    }

    /* ===== INPUT AREA ===== */
    .input-area {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 12px;
      flex-shrink: 0;
      background: var(--vscode-sideBar-background);
    }

    .input-wrapper {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      border-radius: 8px;
      overflow: hidden;
    }

    .input-wrapper:focus-within {
      border-color: var(--vscode-focusBorder);
    }

    .message-input {
      width: 100%;
      min-height: 24px;
      max-height: 200px; /* ~10 lines */
      padding: 10px 12px;
      background: transparent;
      color: var(--vscode-input-foreground);
      border: none;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      line-height: 1.5;
      resize: none;
      outline: none;
      overflow-y: auto;
    }

    .message-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }

    .input-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 8px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-input-background);
    }

    .input-controls {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* Context/attachment chips */
    .context-bar {
      display: none;
      flex-wrap: wrap;
      gap: 4px;
      padding: 6px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-input-background);
    }

    .context-bar.has-items {
      display: flex;
    }

    .context-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 10px;
      font-size: 11px;
      max-width: 200px;
    }

    .context-chip .filename {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .context-chip .remove-context {
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 0;
      display: flex;
      align-items: center;
      opacity: 0.7;
    }

    .context-chip .remove-context:hover {
      opacity: 1;
    }

    .context-chip.active-file {
      background: var(--vscode-textLink-foreground);
      color: white;
    }

    .model-dropdown {
      padding: 2px 6px;
      font-size: 11px;
      background: var(--vscode-dropdown-background);
      color: var(--vscode-dropdown-foreground);
      border: 1px solid var(--vscode-dropdown-border);
      cursor: pointer;
      border-radius: 3px;
      min-width: 100px;
      max-width: 180px;
    }

    .model-dropdown:hover {
      background: var(--vscode-dropdown-background);
      border-color: var(--vscode-focusBorder);
    }

    .model-dropdown:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }

    .model-dropdown option {
      background: var(--vscode-dropdown-listBackground);
      color: var(--vscode-dropdown-foreground);
    }

    .model-dropdown optgroup {
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-dropdown-listBackground);
      padding-top: 4px;
    }

    .send-actions {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .send-btn {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: var(--vscode-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
      opacity: 0.8;
    }

    .send-btn:hover:not(:disabled) {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }

    .send-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .send-btn.streaming {
      color: var(--vscode-errorForeground);
      opacity: 1;
    }

    .send-btn .codicon {
      font-size: 14px;
    }

    /* Codicon styling for icon buttons */
    .icon-btn .codicon {
      font-size: 14px;
    }

    .settings-close .codicon {
      font-size: 14px;
    }
  </style>
</head>
<body>
  <!-- Header -->
  <div class="header">
    <span class="header-title">Chat</span>
    <div class="header-actions">
      <button class="icon-btn" id="newChatBtn" title="New Chat">
        <i class="codicon codicon-add"></i>
      </button>
      <button class="icon-btn" id="refreshBtn" title="Refresh Models">
        <i class="codicon codicon-refresh"></i>
      </button>
    </div>
  </div>

  <!-- Sessions Panel -->
  <div class="sessions-panel" id="sessionsPanel">
    <div class="sessions-header" id="sessionsHeader">
      <span>Recent Sessions</span>
      <span id="sessionsToggle">▼</span>
    </div>
    <div class="sessions-list" id="sessionsList"></div>
  </div>

  <!-- Messages Area -->
  <div class="messages-container" id="messagesContainer">
    <div class="empty-state" id="emptyState">
      <div class="empty-title">Ask with Open LLM</div>
      <div class="empty-subtitle">AI responses may be inaccurate.<br>Select a model and start chatting.</div>
    </div>
    <div class="messages" id="messages"></div>
  </div>

  <!-- Input Area -->
  <div class="input-area">
    <div class="input-wrapper">
      <div class="context-bar" id="contextBar"></div>
      <textarea 
        class="message-input" 
        id="messageInput" 
        placeholder="Ask anything..."
        rows="1"
      ></textarea>
      <div class="input-footer">
        <div class="input-controls">
          <button class="icon-btn" id="attachBtn" title="Attach file or use current file">
            <i class="codicon codicon-attach"></i>
          </button>
          <select class="model-dropdown" id="modelSelect" title="Select model">
            <option value="">Loading...</option>
          </select>
          <button class="icon-btn" id="settingsBtn" title="System Prompt Settings">
            <i class="codicon codicon-settings-gear"></i>
          </button>
        </div>
        <div class="send-actions">
          <button class="send-btn" id="sendBtn" title="Send">
            <i class="codicon codicon-send"></i>
          </button>
        </div>
      </div>
    </div>
  </div>

  <!-- Settings Modal -->
  <div class="settings-overlay" id="settingsOverlay">
    <div class="settings-modal">
      <div class="settings-header">
        <h3>System Prompt</h3>
        <button class="settings-close" id="settingsClose">
          <i class="codicon codicon-close"></i>
        </button>
      </div>
      <div class="settings-body">
        <label for="systemPromptInput">Instructions sent to the LLM (transparency)</label>
        <textarea id="systemPromptInput" placeholder="Enter system prompt..."></textarea>
        <p class="hint">This prompt is prepended to your conversations to guide the AI's behavior and formatting.</p>
      </div>
      <div class="settings-footer">
        <button class="btn-secondary" id="settingsCancel">Cancel</button>
        <button class="btn-primary" id="settingsSave">Save</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    
    let isStreaming = false;
    let currentStreamingEl = null;
    let currentStreamingText = '';
    let models = [];
    let selectedModelId = '';
    let sessions = [];
    let currentSessionId = '';
    let sessionsExpanded = true;

    const messagesContainer = document.getElementById('messagesContainer');
    const messagesEl = document.getElementById('messages');
    const emptyState = document.getElementById('emptyState');
    const messageInput = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    const modelSelect = document.getElementById('modelSelect');
    const newChatBtn = document.getElementById('newChatBtn');
    const refreshBtn = document.getElementById('refreshBtn');
    const sessionsList = document.getElementById('sessionsList');
    const sessionsHeader = document.getElementById('sessionsHeader');
    const sessionsToggle = document.getElementById('sessionsToggle');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsOverlay = document.getElementById('settingsOverlay');
    const settingsClose = document.getElementById('settingsClose');
    const settingsCancel = document.getElementById('settingsCancel');
    const settingsSave = document.getElementById('settingsSave');
    const systemPromptInput = document.getElementById('systemPromptInput');
    const attachBtn = document.getElementById('attachBtn');
    const contextBar = document.getElementById('contextBar');
    
    let systemPrompt = '';
    let attachedFiles = []; // { path, name, content }
    let activeFile = null; // Current editor file

    // Auto-resize textarea (1 line to 10 lines max, then scroll)
    messageInput.addEventListener('input', () => {
      messageInput.style.height = 'auto';
      messageInput.style.height = Math.min(messageInput.scrollHeight, 200) + 'px';
    });

    messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    sendBtn.addEventListener('click', () => {
      if (isStreaming) {
        vscode.postMessage({ type: 'stopGeneration' });
      } else {
        sendMessage();
      }
    });

    modelSelect.addEventListener('change', () => {
      selectedModelId = modelSelect.value;
      vscode.postMessage({ type: 'selectModel', modelId: selectedModelId });
    });

    newChatBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'newChat' });
    });

    refreshBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'refreshModels' });
    });

    sessionsHeader.addEventListener('click', () => {
      sessionsExpanded = !sessionsExpanded;
      sessionsList.style.display = sessionsExpanded ? 'block' : 'none';
      sessionsToggle.textContent = sessionsExpanded ? '▼' : '▶';
    });

    // Settings modal handlers
    settingsBtn.addEventListener('click', () => {
      systemPromptInput.value = systemPrompt;
      settingsOverlay.classList.add('visible');
    });

    function closeSettings() {
      settingsOverlay.classList.remove('visible');
    }

    settingsClose.addEventListener('click', closeSettings);
    settingsCancel.addEventListener('click', closeSettings);
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) closeSettings();
    });

    settingsSave.addEventListener('click', () => {
      const newPrompt = systemPromptInput.value;
      vscode.postMessage({ type: 'updateSystemPrompt', prompt: newPrompt });
      systemPrompt = newPrompt;
      closeSettings();
    });

    // Attach button - show menu with options
    attachBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'showAttachMenu' });
    });

    function updateContextBar() {
      contextBar.innerHTML = '';
      
      // Add active file chip if available
      if (activeFile) {
        const chip = document.createElement('div');
        chip.className = 'context-chip active-file';
        chip.innerHTML = \`
          <i class="codicon codicon-file"></i>
          <span class="filename">\${activeFile.name}</span>
          <button class="remove-context" title="Remove">
            <i class="codicon codicon-close"></i>
          </button>
        \`;
        chip.querySelector('.remove-context').addEventListener('click', () => {
          activeFile = null;
          updateContextBar();
        });
        contextBar.appendChild(chip);
      }
      
      // Add attached files
      attachedFiles.forEach((file, index) => {
        const chip = document.createElement('div');
        chip.className = 'context-chip';
        chip.innerHTML = \`
          <i class="codicon codicon-file"></i>
          <span class="filename">\${file.name}</span>
          <button class="remove-context" title="Remove">
            <i class="codicon codicon-close"></i>
          </button>
        \`;
        chip.querySelector('.remove-context').addEventListener('click', () => {
          attachedFiles.splice(index, 1);
          updateContextBar();
        });
        contextBar.appendChild(chip);
      });
      
      // Show/hide bar
      if (activeFile || attachedFiles.length > 0) {
        contextBar.classList.add('has-items');
      } else {
        contextBar.classList.remove('has-items');
      }
    }

    function sendMessage() {
      const text = messageInput.value.trim();
      if (!text || isStreaming || !selectedModelId) return;
      
      // Build context from attached files
      const context = [];
      if (activeFile) {
        context.push(activeFile);
      }
      context.push(...attachedFiles);
      
      vscode.postMessage({ 
        type: 'sendMessage', 
        text,
        context: context.length > 0 ? context : undefined
      });
      
      messageInput.value = '';
      messageInput.style.height = 'auto';
      
      // Clear attachments after sending
      attachedFiles = [];
      activeFile = null;
      updateContextBar();
    }

    function formatTime(timestamp) {
      const diff = Date.now() - timestamp;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'now';
      if (mins < 60) return mins + ' mins';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + 'h';
      const days = Math.floor(hours / 24);
      return days + 'd';
    }

    function renderSessions() {
      sessionsList.innerHTML = '';
      const visibleSessions = sessions.slice(0, 5);
      
      visibleSessions.forEach(session => {
        const item = document.createElement('div');
        item.className = 'session-item' + (session.id === currentSessionId ? ' active' : '');
        item.innerHTML = \`
          <span class="session-dot"></span>
          <span class="session-title">\${escapeHtml(session.title)}</span>
          <span class="session-time">\${formatTime(session.updatedAt)}</span>
          <button class="icon-btn session-delete" title="Delete">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 8.707l3.646 3.647.708-.707L8.707 8l3.647-3.646-.707-.708L8 7.293 4.354 3.646l-.707.708L7.293 8l-3.646 3.646.707.708L8 8.707z"/></svg>
          </button>
        \`;
        
        item.addEventListener('click', (e) => {
          if (!e.target.closest('.session-delete')) {
            vscode.postMessage({ type: 'selectSession', sessionId: session.id });
          }
        });
        
        item.querySelector('.session-delete').addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
        });
        
        sessionsList.appendChild(item);
      });
    }

    function renderMessages(messages) {
      messagesEl.innerHTML = '';
      
      if (!messages || messages.length === 0) {
        emptyState.style.display = 'flex';
        messagesEl.style.display = 'none';
        return;
      }
      
      emptyState.style.display = 'none';
      messagesEl.style.display = 'flex';
      
      messages.forEach(msg => addMessage(msg, false));
      scrollToBottom();
    }

    function addMessage(message, scroll = true) {
      emptyState.style.display = 'none';
      messagesEl.style.display = 'flex';
      
      const el = document.createElement('div');
      el.className = 'message ' + message.role;
      el.dataset.rawContent = message.content; // Store raw content for copying
      
      let html = '<div class="message-content">' + formatContent(message.content) + '</div>';
      
      // Add copy button for assistant messages
      if (message.role === 'assistant') {
        html += '<div class="message-actions"><button class="response-action-btn copy-response-btn" title="Copy response"><i class="codicon codicon-copy"></i> Copy</button></div>';
      }
      
      el.innerHTML = html;
      messagesEl.appendChild(el);
      if (scroll) scrollToBottom();
      return el;
    }

    function startStreaming() {
      emptyState.style.display = 'none';
      messagesEl.style.display = 'flex';
      
      const el = document.createElement('div');
      el.className = 'message assistant';
      el.innerHTML = '<div class="message-content"><span class="streaming-cursor"></span></div>';
      
      messagesEl.appendChild(el);
      currentStreamingEl = el.querySelector('.message-content');
      currentStreamingText = '';
      scrollToBottom();
    }

    function appendChunk(chunk) {
      if (!currentStreamingEl) startStreaming();
      currentStreamingText += chunk;
      currentStreamingEl.innerHTML = formatContent(currentStreamingText) + '<span class="streaming-cursor"></span>';
      scrollToBottom();
    }

    function finishStreaming() {
      if (currentStreamingEl) {
        const messageEl = currentStreamingEl.closest('.message');
        
        // Store raw content for copying
        if (messageEl) {
          messageEl.dataset.rawContent = currentStreamingText;
        }
        
        // Update content and add copy button
        currentStreamingEl.innerHTML = formatContent(currentStreamingText);
        
        // Add copy button after content
        if (messageEl && !messageEl.querySelector('.message-actions')) {
          const actionsDiv = document.createElement('div');
          actionsDiv.className = 'message-actions';
          actionsDiv.innerHTML = '<button class="response-action-btn copy-response-btn" title="Copy response"><i class="codicon codicon-copy"></i> Copy</button>';
          messageEl.appendChild(actionsDiv);
        }
        
        currentStreamingEl = null;
        currentStreamingText = '';
      }
    }

    function updateStreamingState(streaming) {
      isStreaming = streaming;
      messageInput.disabled = streaming;
      
      if (streaming) {
        sendBtn.classList.add('streaming');
        sendBtn.innerHTML = '<i class="codicon codicon-debug-stop"></i>';
        sendBtn.title = 'Stop';
      } else {
        sendBtn.classList.remove('streaming');
        sendBtn.innerHTML = '<i class="codicon codicon-send"></i>';
        sendBtn.title = 'Send';
        messageInput.focus();
      }
    }

    function updateModels(newModels, newSelectedId) {
      models = newModels;
      selectedModelId = newSelectedId;
      
      modelSelect.innerHTML = '';
      
      if (models.length === 0) {
        modelSelect.innerHTML = '<option value="">No models</option>';
        return;
      }
      
      // Group models by vendor/provider
      const groups = {};
      models.forEach(m => {
        const vendor = m.vendor || 'Other';
        // Capitalize first letter
        const groupName = vendor.charAt(0).toUpperCase() + vendor.slice(1);
        if (!groups[groupName]) {
          groups[groupName] = [];
        }
        groups[groupName].push(m);
      });
      
      // Sort groups alphabetically, but put "Copilot" last
      const sortedGroups = Object.keys(groups).sort((a, b) => {
        if (a === 'Copilot') return 1;
        if (b === 'Copilot') return -1;
        return a.localeCompare(b);
      });
      
      sortedGroups.forEach(groupName => {
        const optgroup = document.createElement('optgroup');
        optgroup.label = groupName;
        
        groups[groupName].forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.id;
          // Show just model name within group (vendor is in group label)
          opt.textContent = m.name.replace(groupName + '/', '').replace(groupName.toLowerCase() + '/', '');
          if (m.id === selectedModelId) opt.selected = true;
          optgroup.appendChild(opt);
        });
        
        modelSelect.appendChild(optgroup);
      });
    }

    // Configure marked for clean output with custom code renderer + highlight.js
    let markedRenderer = null;
    if (typeof marked !== 'undefined') {
      markedRenderer = new marked.Renderer();
      // Override code block rendering (marked v4+ uses token object)
      markedRenderer.code = function(token) {
        // Handle both old API (code, lang) and new API (token object)
        const code = typeof token === 'object' ? token.text : token;
        const lang = typeof token === 'object' ? (token.lang || '') : (arguments[1] || '');
        const langLabel = lang ? (lang.charAt(0).toUpperCase() + lang.slice(1)) : 'Code';
        const isShell = ['bash', 'sh', 'shell', 'zsh', 'terminal', 'console'].includes(lang.toLowerCase());
        
        // Apply syntax highlighting if hljs is available
        let highlightedCode;
        if (typeof hljs !== 'undefined') {
          try {
            if (lang && hljs.getLanguage(lang)) {
              highlightedCode = hljs.highlight(code, { language: lang }).value;
            } else {
              highlightedCode = hljs.highlightAuto(code).value;
            }
          } catch (e) {
            highlightedCode = escapeHtml(code);
          }
        } else {
          highlightedCode = escapeHtml(code);
        }
        
        // Build action buttons
        const copyBtn = '<button class="code-action-btn copy-code-btn" title="Copy code"><i class="codicon codicon-copy"></i></button>';
        const terminalBtn = isShell ? '<button class="code-action-btn terminal-btn" title="Run in terminal"><i class="codicon codicon-terminal"></i></button>' : '';
        const actions = '<div class="code-block-actions">' + copyBtn + terminalBtn + '</div>';
        
        // Store raw code in data attribute for copying
        const escapedCode = escapeHtml(code).replace(/"/g, '&quot;');
        
        return '<div class="code-block" data-code="' + escapedCode + '"><div class="code-block-header"><span>' + langLabel + '</span>' + actions + '</div><pre><code class="hljs">' + highlightedCode + '</code></pre></div>';
      };
    }

    function formatContent(text) {
      if (!text) return '';
      
      // Use marked library if available
      if (typeof marked !== 'undefined' && marked.parse) {
        try {
          return marked.parse(text, { 
            renderer: markedRenderer,
            breaks: false,
            gfm: true
          });
        } catch (e) {
          console.error('Marked parse error:', e);
        }
      }
      
      // Fallback: simple formatting
      let html = escapeHtml(text);
      html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
      html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
      html = html.replace(/\\n\\n/g, '</p><p>');
      return '<p>' + html + '</p>';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function scrollToBottom() {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function showError(error) {
      finishStreaming();
      const el = document.createElement('div');
      el.className = 'message assistant error';
      el.innerHTML = \`
        <div class="message-content">\${escapeHtml(error)}</div>
      \`;
      messagesEl.appendChild(el);
      scrollToBottom();
    }

    function showToolCall(toolCall) {
      // Tool calls are shown inline in the streamed content
      // This can be used for additional UI if needed (e.g., badges, indicators)
      console.log('Tool call:', toolCall.name, toolCall.input);
    }

    function showToolResult(callId, result) {
      // Tool results are shown inline in the streamed content
      // This can be used for additional UI if needed
      console.log('Tool result:', callId, result.substring(0, 100));
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      
      switch (msg.type) {
        case 'fullState':
          sessions = msg.sessions || [];
          currentSessionId = msg.currentSessionId;
          renderSessions();
          updateModels(msg.models, msg.selectedModelId);
          renderMessages(msg.messages);
          updateStreamingState(msg.isStreaming);
          systemPrompt = msg.systemPrompt || '';
          break;
        case 'sessions':
          sessions = msg.sessions || [];
          currentSessionId = msg.currentSessionId;
          renderSessions();
          break;
        case 'models':
          updateModels(msg.models, msg.selectedModelId);
          break;
        case 'message':
          addMessage(msg.message);
          break;
        case 'streamChunk':
          appendChunk(msg.chunk);
          break;
        case 'streamComplete':
          finishStreaming();
          break;
        case 'streamingState':
          updateStreamingState(msg.isStreaming);
          break;
        case 'error':
          showError(msg.error);
          break;
        case 'toolCall':
          showToolCall(msg.toolCall);
          break;
        case 'toolResult':
          showToolResult(msg.callId, msg.result);
          break;
        case 'activeFile':
          activeFile = msg.file;
          updateContextBar();
          break;
        case 'attachedFile':
          if (msg.file && !attachedFiles.find(f => f.path === msg.file.path)) {
            attachedFiles.push(msg.file);
            updateContextBar();
          }
          break;
      }
    });

    // Event delegation for copy and terminal buttons
    document.addEventListener('click', async (e) => {
      const target = e.target.closest('button');
      if (!target) return;
      
      // Copy code button
      if (target.classList.contains('copy-code-btn')) {
        const codeBlock = target.closest('.code-block');
        if (codeBlock && codeBlock.dataset.code) {
          const code = codeBlock.dataset.code
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
          await navigator.clipboard.writeText(code);
          target.classList.add('copied');
          target.innerHTML = '<i class="codicon codicon-check"></i>';
          setTimeout(() => {
            target.classList.remove('copied');
            target.innerHTML = '<i class="codicon codicon-copy"></i>';
          }, 2000);
        }
      }
      
      // Terminal button
      if (target.classList.contains('terminal-btn')) {
        const codeBlock = target.closest('.code-block');
        if (codeBlock && codeBlock.dataset.code) {
          const code = codeBlock.dataset.code
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&');
          vscode.postMessage({ type: 'runInTerminal', command: code });
        }
      }
      
      // Copy response button
      if (target.classList.contains('copy-response-btn')) {
        const message = target.closest('.message');
        if (message && message.dataset.rawContent) {
          await navigator.clipboard.writeText(message.dataset.rawContent);
          target.classList.add('copied');
          target.innerHTML = '<i class="codicon codicon-check"></i> Copied';
          setTimeout(() => {
            target.classList.remove('copied');
            target.innerHTML = '<i class="codicon codicon-copy"></i> Copy';
          }, 2000);
        }
      }
    });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }

  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
