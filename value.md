# Open LLM Provider — Value Proposition

## The Problem

### Fragmented LLM Access in VS Code

VS Code's Language Model API (`vscode.lm`) provides a powerful abstraction for extensions to consume LLM capabilities. However, in practice, this API is tightly coupled to GitHub Copilot:

- `vscode.lm.selectChatModels()` returns models registered by Copilot
- `vscode.lm.registerChatModelProvider()` is a **proposed API** — unavailable in stable VS Code without insider builds
- Extensions wanting LLM features must either:
  1. Require users to have a Copilot subscription
  2. Implement their own provider integration from scratch
  3. Bundle API keys and provider logic directly

This creates a fragmented ecosystem where:
- Users configure the same API keys in multiple extensions
- Each extension implements its own streaming, error handling, and provider quirks
- No shared infrastructure exists for teams or enterprises to manage LLM access centrally

### The Enterprise Reality

Organizations have already established relationships with LLM providers:
- Enterprise agreements with OpenAI, Anthropic, Google, or Mistral
- Self-hosted models on Red Hat OpenShift AI (RHOAI) or RHEL AI
- Local models via Ollama for privacy-sensitive workloads

These organizations need VS Code extensions to leverage their **existing** AI investments rather than requiring additional Copilot licenses or proprietary integrations.

### The Extension Developer Dilemma

Extension developers face difficult choices:

| Approach | Downsides |
|----------|-----------|
| Require Copilot | Excludes users without subscriptions; dependency on Microsoft |
| Direct API integration | Duplicated work; users configure keys per-extension |
| No LLM features | Miss out on AI-assisted functionality |

There's no open, reusable layer that extension developers can depend on.

---

## The Solution: Open LLM Provider

Open LLM Provider is an **open-source VS Code extension** that:

1. **Exposes multiple LLM providers** through a unified interface
2. **Provides a standalone chat UI** that works without Copilot
3. **Enables extension developers** to consume LLM capabilities through the standard `vscode.lm` API (when available) or direct integration

### Core Principles

| Principle | What It Means |
|-----------|---------------|
| **Open** | MIT licensed, no vendor lock-in, community-driven |
| **Transparent** | Users see exactly what prompts are sent; configurable system prompts |
| **User Choice** | Support for OpenAI, Anthropic, Google, Mistral, Azure, Ollama, and Red Hat AI |
| **Local First** | Full support for Ollama and other local inference servers |
| **No Ecosystem Tax** | Functionality without requiring proprietary subscriptions |

---

## Value Proposition

### For Extension Developers

**Before Open LLM:**
```typescript
// Each extension implements its own provider logic
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: config.get('anthropicApiKey') });
const response = await client.messages.create({ ... });
```

**With Open LLM:**
```typescript
// Use VS Code's standard LM API — Open LLM provides the models
const models = await vscode.lm.selectChatModels({ vendor: 'open-llm' });
const response = await models[0].sendRequest(messages, options, token);
```

Benefits:
- **No provider-specific code** — Open LLM handles streaming, auth, and API differences
- **User configures once** — API keys and models configured in one place
- **Graceful fallback** — If Copilot is installed, extensions can use either

### For Red Hat Extensions

A key driver for this project: **AI infusion across Red Hat extensions without requiring proprietary solutions**.

The Ansible, OpenShift, Podman, and other Red Hat extensions can:
- Offer AI-assisted features (explain, generate, troubleshoot)
- Work with user's existing LLM providers
- Support enterprise deployments with RHOAI/RHEL AI backends
- Provide consistent AI UX across the Red Hat extension portfolio

Example: The Ansible extension could offer "Explain this playbook" using whatever model the user has configured — Claude, GPT-4, a local Llama, or a model running on OpenShift AI.

### For Users

| User Need | How Open LLM Helps |
|-----------|-------------------|
| "I don't want to pay for Copilot" | Use free tiers or local models |
| "I prefer Claude/Gemini over GPT" | Configure your preferred provider |
| "I can't send code to external APIs" | Use Ollama or self-hosted models |
| "I already have API keys configured" | Import from Continue or .env files |
| "I want to know what's being sent" | Transparent system prompts, visible in UI |

---

## Technical Architecture

### How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                        VS Code                               │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────────┐     ┌─────────────────────────────────┐    │
│  │  Extension  │────▶│     vscode.lm.selectChatModels  │    │
│  │  (Ansible)  │     │     vscode.lm.sendRequest       │    │
│  └─────────────┘     └───────────────┬─────────────────┘    │
│                                      │                       │
│                      ┌───────────────▼─────────────────┐    │
│                      │      Open LLM Provider          │    │
│                      │  (LanguageModelChatProvider)    │    │
│                      └───────────────┬─────────────────┘    │
│                                      │                       │
└──────────────────────────────────────┼───────────────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────┐
          │                            │                        │
          ▼                            ▼                        ▼
   ┌─────────────┐            ┌─────────────┐          ┌─────────────┐
   │   OpenAI    │            │  Anthropic  │          │   Ollama    │
   │   Gemini    │            │   Mistral   │          │  (local)    │
   │   Azure     │            │   RHOAI     │          │             │
   └─────────────┘            └─────────────┘          └─────────────┘
```

### Key Components

| Component | Purpose |
|-----------|---------|
| `ConfigManager` | Loads models from VS Code settings, Continue config, .env files |
| `ProviderRegistry` | Factory for provider-specific implementations |
| `OpenLLMProvider` | Implements `vscode.lm.LanguageModelChatProvider` interface |
| `ChatViewProvider` | Standalone chat sidebar (WebviewView) |
| `BaseProvider` | Abstract class handling streaming, message conversion |

### The vscode.lm API Challenge

Currently, `vscode.lm.registerChatModelProvider()` is a **proposed API** — it's not available in stable VS Code or Cursor. This means:

- We **cannot** register our models into `vscode.lm.selectChatModels()` in production
- Extensions **cannot** seamlessly discover Open LLM models via the standard API
- The code is ready (`OpenLLMProvider.registerWithVSCodeLM()`), but gated on API availability

**Workaround:** Extensions can directly import and use `OpenLLMProvider.sendRequest()` for now.

**Future:** When the API becomes stable, extensions will automatically see Open LLM models alongside Copilot models.

---

## Comparison to Alternatives

### vs. GitHub Copilot

| Aspect | Copilot | Open LLM |
|--------|---------|----------|
| Cost | $10-39/month | Free (BYOK) |
| Models | GPT-4, Claude (limited) | Any provider |
| Local models | No | Yes (Ollama) |
| Transparency | Closed prompts | Visible, editable prompts |
| Enterprise control | Microsoft-managed | Self-managed |

Open LLM is **not anti-Copilot** — they can coexist. Open LLM provides choice for users and organizations where Copilot isn't the right fit.

### vs. Continue

[Continue](https://continue.dev) is an excellent open-source project with similar goals. Open LLM draws inspiration from their configuration format and multi-provider approach.

Key differences:
- **Continue** is a full IDE experience (chat, autocomplete, agents)
- **Open LLM** focuses on being a **provider layer** for other extensions
- **Continue** has its own UI paradigm
- **Open LLM** aims to integrate with VS Code's native patterns

We import Continue's config format to ease migration.

---

## Roadmap Considerations

### Current State (v0.1)
- ✅ Multi-provider support (6 providers)
- ✅ Standalone chat sidebar
- ✅ Configuration import from Continue
- ✅ Streaming responses
- ✅ Syntax-highlighted code blocks
- ✅ Copy/terminal integration

### Near-term
- [ ] Stable `vscode.lm` registration (pending API)
- [ ] Red Hat AI provider (RHOAI, RHEL AI)
- [ ] Context attachment (files, selections)
- [ ] Conversation export/import

### Long-term Vision: Agents
The long-term goal is agent capabilities — autonomous multi-step operations like:
- "Refactor this module to use dependency injection"
- "Write tests for these functions"
- "Debug why this playbook is failing"

This requires:
1. Tool/function calling support (partially implemented)
2. File system access patterns
3. Safe execution boundaries
4. Integration with VS Code's proposed agent APIs

The agent space is rapidly evolving. We're monitoring:
- `vscode.chat.createChatParticipant()` API
- Anthropic's computer use patterns
- OpenAI's Assistants API approach

---

## Integration Guide: Using Open LLM in Your Extension

### Option 1: Via vscode.lm API (When Available)

This is the cleanest approach and works when the `vscode.lm` API is fully available:

```typescript
import * as vscode from 'vscode';

async function askLLM(prompt: string): Promise<string> {
  // Get available models — includes Open LLM models when registered
  const models = await vscode.lm.selectChatModels({
    vendor: 'open-llm'  // Filter to Open LLM models only
  });

  if (models.length === 0) {
    // Fallback: try any available model (including Copilot)
    const anyModels = await vscode.lm.selectChatModels({});
    if (anyModels.length === 0) {
      throw new Error('No LLM models available. Install Open LLM Provider or GitHub Copilot.');
    }
    models.push(anyModels[0]);
  }

  const messages = [
    vscode.LanguageModelChatMessage.User(prompt)
  ];

  const response = await models[0].sendRequest(messages, {}, new vscode.CancellationTokenSource().token);

  // Collect streaming response
  let result = '';
  for await (const chunk of response.text) {
    result += chunk;
  }

  return result;
}
```

### Option 2: Direct Extension Dependency

For tighter integration or when `vscode.lm` isn't available, your extension can directly depend on Open LLM:

**In your extension's `package.json`:**
```json
{
  "extensionDependencies": [
    "open-llm.open-llm-provider"
  ]
}
```

**In your extension code:**
```typescript
import * as vscode from 'vscode';

async function getOpenLLMProvider() {
  const openLLMExtension = vscode.extensions.getExtension('open-llm.open-llm-provider');
  
  if (!openLLMExtension) {
    vscode.window.showErrorMessage('Open LLM Provider extension is required.');
    return null;
  }

  if (!openLLMExtension.isActive) {
    await openLLMExtension.activate();
  }

  // The extension exports its API
  return openLLMExtension.exports;
}

async function explainCode(code: string): Promise<string> {
  const openLLM = await getOpenLLMProvider();
  if (!openLLM) return '';

  const models = openLLM.getAvailableModels();
  if (models.length === 0) {
    vscode.window.showWarningMessage('No LLM models configured in Open LLM.');
    return '';
  }

  // Use the first available model
  const messages = [
    vscode.LanguageModelChatMessage.User(`Explain this code:\n\n${code}`)
  ];

  let result = '';
  const stream = await openLLM.sendRequest(models[0].id, messages, {});
  
  for await (const chunk of stream) {
    result += chunk;
  }

  return result;
}
```

### Option 3: Graceful Fallback Pattern

Support multiple LLM sources with graceful fallback:

```typescript
import * as vscode from 'vscode';

interface LLMProvider {
  name: string;
  sendMessage: (prompt: string) => Promise<string>;
}

async function getLLMProvider(): Promise<LLMProvider | null> {
  // Try 1: vscode.lm API (works with Copilot or Open LLM when registered)
  try {
    const models = await vscode.lm.selectChatModels({});
    if (models.length > 0) {
      return {
        name: `${models[0].vendor}/${models[0].name}`,
        sendMessage: async (prompt) => {
          const messages = [vscode.LanguageModelChatMessage.User(prompt)];
          const response = await models[0].sendRequest(messages, {});
          let result = '';
          for await (const chunk of response.text) {
            result += chunk;
          }
          return result;
        }
      };
    }
  } catch (e) {
    // vscode.lm not available or no models
  }

  // Try 2: Open LLM extension direct API
  const openLLM = vscode.extensions.getExtension('open-llm.open-llm-provider');
  if (openLLM) {
    if (!openLLM.isActive) await openLLM.activate();
    const api = openLLM.exports;
    const models = api.getAvailableModels();
    
    if (models.length > 0) {
      return {
        name: `Open LLM: ${models[0].name}`,
        sendMessage: async (prompt) => {
          const messages = [vscode.LanguageModelChatMessage.User(prompt)];
          let result = '';
          const stream = await api.sendRequest(models[0].id, messages, {});
          for await (const chunk of stream) {
            result += chunk;
          }
          return result;
        }
      };
    }
  }

  return null;
}

// Usage in a command
vscode.commands.registerCommand('myExtension.explainSelection', async () => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const selection = editor.document.getText(editor.selection);
  if (!selection) {
    vscode.window.showWarningMessage('Select some code first.');
    return;
  }

  const provider = await getLLMProvider();
  if (!provider) {
    vscode.window.showErrorMessage(
      'No LLM available. Install GitHub Copilot or Open LLM Provider.'
    );
    return;
  }

  vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: `Asking ${provider.name}...`,
    cancellable: false
  }, async () => {
    const explanation = await provider.sendMessage(
      `Explain this code concisely:\n\n${selection}`
    );
    
    // Show in a new document
    const doc = await vscode.workspace.openTextDocument({
      content: explanation,
      language: 'markdown'
    });
    vscode.window.showTextDocument(doc, { preview: true });
  });
});
```

### Real-World Example: Ansible Extension Integration

Here's how the Ansible extension could add "Explain Playbook" functionality using the Open LLM chat UI:

```typescript
// src/features/explainPlaybook.ts
import * as vscode from 'vscode';

export class PlaybookExplainer {
  async explain(document: vscode.TextDocument): Promise<void> {
    const content = document.getText();
    const fileName = document.fileName.split('/').pop() || 'playbook.yml';
    
    // Check if Open LLM is available
    const openLLM = vscode.extensions.getExtension('open-llm.open-llm-provider');
    if (!openLLM) {
      vscode.window.showErrorMessage(
        'Open LLM Provider is required. Please install it from the marketplace.'
      );
      return;
    }

    // Send to Open LLM chat UI - this opens the chat sidebar,
    // shows the playbook context, and streams the explanation
    await vscode.commands.executeCommand('openLLM.chat.send', {
      message: 'Explain this Ansible playbook. Describe what each play and task does, highlight any potential issues, and suggest best practices.',
      context: [{
        path: document.fileName,
        name: fileName,
        language: 'yaml',
        content: content
      }],
      newSession: true
    });
  }
}

// Register the command
export function activate(context: vscode.ExtensionContext) {
  const explainer = new PlaybookExplainer();
  
  context.subscriptions.push(
    vscode.commands.registerCommand('ansible.explainPlaybook', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.languageId === 'yaml') {
        await explainer.explain(editor.document);
      }
    })
  );
}
```

This approach:
- Uses the Open LLM chat UI for a rich, interactive experience
- Shows the playbook content as context with proper syntax highlighting
- Allows users to ask follow-up questions about the explanation
- Persists the conversation for future reference

### Option 4: Using the Open LLM Chat UI

Other extensions can open and interact with the Open LLM chat sidebar:

**Open the chat panel:**
```typescript
// Focus the Open LLM chat sidebar
await vscode.commands.executeCommand('openLLM.chatView.focus');
```

**Send a message to chat (with file context):**
```typescript
// Send a message with optional file context - this opens the chat UI,
// displays the message, and streams the response in the chat panel

await vscode.commands.executeCommand('openLLM.chat.send', {
  message: 'Explain this code',
  context: [
    {
      path: editor.document.fileName,
      name: 'myfile.ts',
      language: editor.document.languageId,
      content: selectedText
    }
  ],
  newSession: true  // Optional: start a fresh chat session
});
```

**Full example: "Ask Open LLM" from any extension:**
```typescript
import * as vscode from 'vscode';

export function registerAskOpenLLM(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('myExtension.askOpenLLM', async () => {
      const editor = vscode.window.activeTextEditor;
      
      // Check if Open LLM is installed
      const openLLM = vscode.extensions.getExtension('open-llm.open-llm-provider');
      if (!openLLM) {
        const install = await vscode.window.showErrorMessage(
          'Open LLM Provider is required for this feature.',
          'Install'
        );
        if (install === 'Install') {
          vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            'open-llm.open-llm-provider'
          );
        }
        return;
      }

      // Get selected text or prompt for input
      let message: string;
      let context: Array<{ path: string; name: string; language: string; content: string }> | undefined;
      
      if (editor && !editor.selection.isEmpty) {
        const selection = editor.document.getText(editor.selection);
        const language = editor.document.languageId;
        const fileName = editor.document.fileName.split('/').pop() || 'file';
        
        message = 'Explain this code';
        context = [{
          path: editor.document.fileName,
          name: fileName,
          language: language,
          content: selection
        }];
      } else {
        const input = await vscode.window.showInputBox({
          prompt: 'What would you like to ask?',
          placeHolder: 'e.g., How do I write a unit test for...'
        });
        if (!input) return;
        message = input;
      }

      // Send to the Open LLM chat UI - this will:
      // 1. Focus the chat sidebar
      // 2. Display the message with context
      // 3. Stream the AI response in the chat panel
      await vscode.commands.executeCommand('openLLM.chat.send', {
        message,
        context,
        newSession: true
      });
    })
  );
}
```

**Adding a context menu action:**
```json
// In your extension's package.json
{
  "contributes": {
    "menus": {
      "editor/context": [
        {
          "command": "myExtension.askOpenLLM",
          "when": "editorHasSelection",
          "group": "1_openllm"
        }
      ]
    },
    "commands": [
      {
        "command": "myExtension.askOpenLLM",
        "title": "Ask Open LLM",
        "icon": "$(comment-discussion)"
      }
    ]
  }
}
```

This lets users right-click selected code and choose "Ask Open LLM" to get an explanation in the chat sidebar.

> **Note:** For the `openLLM.chat.send` command to work, Open LLM needs to expose it. This is on the roadmap. Currently, you can open the chat view and the user can paste/type their question.

---

## Getting Started (Development)

```bash
# Clone and install
git clone https://github.com/open-llm/open-llm-provider
cd open-llm-provider
npm install

# Build
npm run compile

# Debug
# Press F5 in VS Code to launch extension host

# Package
npm run package
```

### Configuration

Users configure providers via VS Code settings or by importing Continue config:

```json
{
  "openLLM.providers": [
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

API keys can be stored in:
- `~/.openllm/.env`
- `~/.continue/.env`
- VS Code's secure secret storage

---

## Summary

Open LLM Provider fills a critical gap in the VS Code ecosystem:

> **An open, transparent, provider-agnostic LLM layer that enables AI features in any extension without requiring proprietary subscriptions.**

For Red Hat specifically, it enables AI infusion across our extension portfolio while respecting user choice and enterprise requirements.

The project is intentionally focused: provide the plumbing so extensions can build great AI features without reinventing LLM integration.

---

*Document version: January 2026*
*Contact: [maintainer info]*
