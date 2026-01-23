# Open LLM Provider

**Use any LLM with any VS Code extension** — OpenAI, Anthropic, Google, Ollama & more. The open alternative to Copilot.

## Features

- **Chat Sidebar** — Built-in chat interface in the Activity Bar, no Copilot required
- **Multi-Provider Support** — OpenAI, Anthropic Claude, Google Gemini, Ollama (local), Mistral, Azure OpenAI
- **Tool Orchestration** — Supports VS Code tools (`vscode.lm.tools`) for agent-style operations
- **Configure Once, Use Everywhere** — Set up your API keys once and use them with any compatible extension
- **Local Model Support** — Run models locally with Ollama for privacy and cost savings
- **Continue Integration** — Automatically import your existing Continue configuration
- **Secure Storage** — API keys stored securely using VS Code's secret storage
- **Streaming Support** — Real-time streaming responses from all providers

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "Open LLM Provider"
4. Click Install

## Quick Start

### Option 1: Add Provider via Command

1. Open Command Palette (Ctrl+Shift+P / Cmd+Shift+P)
2. Run `Open LLM: Add Provider`
3. Select your provider (OpenAI, Anthropic, etc.)
4. Enter your API key
5. Select models to enable

### Option 2: Import from Continue

If you already have Continue configured:

1. Open Command Palette
2. Run `Open LLM: Import Configuration from Continue`
3. Your Continue models will be automatically available

### Option 3: Manual Configuration

Add to your VS Code settings (`settings.json`):

```json
{
  "openLLM.providers": [
    {
      "name": "openai",
      "apiKey": "${{ secrets.OPENAI_API_KEY }}",
      "models": ["gpt-4o", "gpt-4o-mini"]
    },
    {
      "name": "anthropic",
      "apiKey": "${{ secrets.ANTHROPIC_API_KEY }}",
      "models": ["claude-3-5-sonnet-20241022"]
    },
    {
      "name": "ollama",
      "models": ["llama3.2", "qwen2.5-coder"]
    }
  ]
}
```

Create a `.env` file in `~/.openllm/` or `~/.continue/`:

```bash
OPENAI_API_KEY=sk-proj-...
ANTHROPIC_API_KEY=sk-ant-api03-...
```

## Chat Sidebar

Open LLM includes a built-in chat interface accessible from the Activity Bar:

1. Click the chat icon in the Activity Bar (left sidebar)
2. Select a model from the dropdown
3. Type your question and press Enter or click Send
4. Responses stream in real-time with markdown formatting

The chat sidebar works independently of GitHub Copilot, allowing you to use any configured model for conversations.

**Features:**
- Model selector with all available models (vscode.lm + direct)
- Streaming responses with real-time display
- Rich markdown formatting with code block language labels
- Chat layout: your messages in bubbles on the right, AI responses as formatted text on the left
- Session history with persistence across restarts
- Stop generation button
- New chat / clear conversation button

### System Prompt (Transparency)

Open LLM is committed to transparency. Click the gear icon (⚙) in the chat input area to view and edit the system prompt that guides the AI's behavior. This prompt is prepended to your conversations.

- `openLLM.chat.systemPrompt` — Customizable prompt sent to the LLM (also editable via gear icon in chat)

## Commands

| Command | Description |
|---------|-------------|
| `Open LLM: Providers and Models` | Configure providers, API keys, and select models |
| `Open LLM: Show Available Models` | View all configured models |
| `Open LLM: Reload Configuration` | Reload configuration from files |
| `Open LLM: Show Status Panel` | Open the status and debug panel |
| `Open LLM: Open Playground` | Compare responses from all models side-by-side |
| `Open LLM: Focus Chat Panel` | Open the Chat sidebar |
| `Open LLM: Clear Chat History` | Clear the current chat conversation |

## Supported Providers

| Provider | API Key Required | Features |
|----------|------------------|----------|
| OpenAI | Yes | GPT-4o, GPT-4, GPT-3.5, o1 |
| Anthropic | Yes | Claude 3.5 Sonnet, Claude 3 Opus |
| Google Gemini | Yes | Gemini 2.0, Gemini 1.5 Pro |
| OpenRouter | Yes | 100+ models via single API (OpenAI, Anthropic, Google, Meta, etc.) |
| Ollama | No | Local models (Llama, Mistral, etc.) |
| Mistral | Yes | Mistral Large, Codestral |
| Azure OpenAI | Yes | Azure-hosted OpenAI models |
| Red Hat OpenShift AI | Yes | Enterprise AI on OpenShift (OpenAI-compatible) |

## Configuration Options

| Setting | Default | Description |
|---------|---------|-------------|
| `openLLM.providers` | `[]` | Array of provider configurations |
| `openLLM.importContinueConfig` | `true` | Import Continue config automatically |
| `openLLM.autoReload` | `true` | Auto-reload when config changes |
| `openLLM.logLevel` | `info` | Logging level (debug, info, warn, error) |
| `openLLM.chat.systemPrompt` | *(see below)* | System prompt for guiding LLM responses (editable via gear icon) |

**Default System Prompt:**
> You are a helpful AI assistant. Format your responses using markdown when appropriate. Use code blocks with language identifiers for code snippets.

## Using with Other Extensions

Extensions can use the VS Code Language Model API to access your configured models:

```typescript
import * as vscode from 'vscode';

// Get available models
const models = await vscode.lm.selectChatModels({
  vendor: 'open-llm'
});

// Send a request
if (models.length > 0) {
  const messages = [
    vscode.LanguageModelChatMessage.User('Generate a commit message')
  ];
  
  const response = await models[0].sendRequest(messages);
  
  for await (const chunk of response.text) {
    console.log(chunk);
  }
}
```

## Local Development

```bash
# Clone the repository
git clone https://github.com/open-llm/open-llm-provider
cd open-llm-provider

# Install dependencies
npm install

# Compile
npm run compile

# Watch mode
npm run watch
```

Press F5 in VS Code to launch the extension in debug mode.

## Contributing

Contributions are welcome! Please read our [Contributing Guide](CONTRIBUTING.md) for details.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Inspired by [Continue](https://continue.dev) for configuration format
- Thanks to the VS Code team for the Language Model API
