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
