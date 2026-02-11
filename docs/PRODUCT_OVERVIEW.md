# OpenLLM - Product Overview

**Status:** MVP Complete  
**Version:** 0.1.0  
**Last Updated:** February 2026

---

## Executive Summary

OpenLLM is a unified AI daemon that provides consistent access to multiple LLM providers through a single interface. It enables the "Bring Your Own Model" (BYOM) vision by supporting both cloud providers (OpenAI, Anthropic, Google) and local models (Ollama).

The project implements a **TypeScript daemon** with **gRPC API**, a **web dashboard** for configuration, and a **VS Code extension** that registers models with VS Code's Language Model API.

---

## Goals Addressed

| Goal | Status | Implementation |
|------|--------|----------------|
| Decouple Provider Logic | ✅ Complete | TypeScript daemon handles all provider communication; clients use gRPC |
| Enable BYOM | ✅ Complete | 15+ providers supported including local (Ollama) and custom endpoints |
| Centralize Configuration | ✅ Complete | YAML config files at user/workspace level; web dashboard for easy editing |
| Accelerate AI Infusion | ✅ Complete | Ready-made gRPC API; VS Code integration via Language Model API |

---

## Supported Providers

| Provider | Tool Calling | Vision | Streaming | Notes |
|----------|--------------|--------|-----------|-------|
| OpenAI | ✓ | ✓ | ✓ | GPT-4o, GPT-4 Turbo |
| Anthropic | ✓ | ✓ | ✓ | Claude 3.5, Claude 3 |
| Google Gemini | ✓ | ✓ | ✓ | Gemini Pro, Flash |
| Mistral | ✓ | ✗ | ✓ | Mistral Large, Medium |
| Azure OpenAI | ✓ | ✓ | ✓ | Corporate/on-prem |
| OpenRouter | ✓ | ✓ | ✓ | 100+ model aggregator |
| Ollama | ✗ | ✗ | ✓ | Local models |
| DeepSeek | ✓ | ✗ | ✓ | DeepSeek Coder |
| Groq | ✓ | ✗ | ✓ | Fast inference |
| Together | ✓ | ✗ | ✓ | Open models |
| Cohere | ✓ | ✗ | ✓ | Command models |
| xAI (Grok) | ✓ | ✗ | ✓ | Grok models |
| Fireworks | ✓ | ✗ | ✓ | Optimized inference |

**Notes:** 
- Ollama supports any model that can run locally (Llama, Mistral, Qwen, DeepSeek, etc.)
- Models are discovered dynamically from provider APIs when possible

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Consumer Applications                         │
│                                                                  │
│   VS Code Extension     Python Scripts      Web Dashboard        │
│   (gRPC client)         (gRPC client)       (HTTP → gRPC)        │
│         │                      │                   │             │
└─────────┼──────────────────────┼───────────────────┼─────────────┘
          │                      │                   │
          └──────────────────────┼───────────────────┘
                                 │ gRPC over Unix Socket
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                     openllm daemon (TypeScript)                  │
│                                                                  │
│   ┌─────────────────┐  ┌─────────────────┐  ┌────────────────┐  │
│   │  gRPC Server    │  │  Web Server     │  │  Session Mgmt  │  │
│   │  (@grpc/grpc-js)│  │  (Express)       │  │                │  │
│   └────────┬────────┘  └────────┬────────┘  └────────────────┘  │
│            │                    │                                │
│   ┌────────▼────────┐  ┌────────▼────────┐  ┌────────────────┐  │
│   │  LLM Providers  │  │  Unified Config │  │  Secret Store  │  │
│   │  (multi-llm-ts) │  │  Resolver       │  │  (keychain)    │  │
│   └─────────────────┘  └─────────────────┘  └────────────────┘  │
└────────────────────────────────┬────────────────────────────────┘
                                 │ HTTP
                                 ▼
                    ┌─────────────────────────┐
                    │    LLM Provider APIs    │
                    │  OpenAI, Anthropic...   │
                    └─────────────────────────┘
```

### Why TypeScript Daemon?

1. **Single source of truth** - Configuration and secrets managed centrally
2. **Session continuity** - Start a chat in VS Code, continue from CLI
3. **Performance** - Async streaming with minimal overhead
4. **Simplicity** - Clients are thin gRPC wrappers, not embedded native code

---

## Components

### 1. TypeScript Daemon (`openllm daemon`)

The core service that runs as a background process:
- Listens on Unix socket for gRPC requests
- Manages provider connections and API keys
- Handles chat streaming and session persistence
- Stores secrets in system keychain

### 2. Web Dashboard (`openllm web`)

Browser-based configuration UI:
- Configure API keys (keychain or environment variable)
- Enable/disable providers and models
- View connection status
- Choose user or workspace config level

### 3. VS Code Extension

Integrates OpenLLM with VS Code:
- Connects to daemon on activation
- Registers models with VS Code's Language Model API
- Provides workspace path info via backchannel
- Commands: "Show Daemon Status", "Open Dashboard"

---

## VS Code Integration

### How Models Appear in VS Code

```
Other VS Code Extensions (e.g., Ansible)
         │
         │  vscode.lm.selectChatModels({ vendor: 'openllm' })
         ▼
OpenLLM Extension → Returns configured models
         │
         │  model.sendRequest(messages, options)
         ▼
Daemon → Streams response from actual provider
```

Any extension using VS Code's standard LM API can use OpenLLM providers without custom code.

---

## Configuration & Secrets

### Configuration Files

| Location | Purpose |
|----------|---------|
| `~/.openllm/config.yaml` | User-level (global) settings |
| `<workspace>/.openllm/config.yaml` | Workspace-specific settings |

### API Key Storage

Two mutually exclusive options per provider:

| Option | Field | Best For |
|--------|-------|----------|
| Keychain | `api_key_keychain_name` | Personal development, highest security |
| Environment Variable | `api_key_env_var_name` | CI/CD, containers, shared environments |

Example config:
```yaml
providers:
  openai:
    api_key_keychain_name: "OPENAI_API_KEY"
    enabled_models:
      - gpt-4o
      - gpt-4o-mini
  anthropic:
    api_key_env_var_name: "ANTHROPIC_API_KEY"
    enabled_models:
      - claude-3-5-sonnet-20241022
```

---

## User Stories - Implementation Status

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| 1 | Centralized Config | ✅ Complete | YAML config shared across all tools |
| 2 | Local Model Support | ✅ Complete | Ollama provider with auto-discovery |
| 3 | Simplified Integration | ✅ Complete | Standard VS Code LM API |
| 4 | Provider Switching | ✅ Complete | Enable/disable via web dashboard |
| 5 | Session Continuity | ✅ Complete | Sessions persist across clients |

---

## Acceptance Criteria - Status

### Core Functionality

| Criterion | Status | Notes |
|-----------|--------|-------|
| Discover/connect to Ollama | ✅ Complete | Auto-connects to localhost:11434 |
| OpenAI-compatible endpoints | ✅ Complete | vLLM, RHEL AI, TGI all work |
| Secure API key storage | ✅ Complete | System keychain + env var support |
| Dynamic model discovery | ✅ Complete | Models fetched from provider APIs |

### Extension Integration

| Criterion | Status | Notes |
|-----------|--------|-------|
| VS Code Language Model API | ✅ Complete | `vscode.lm.selectChatModels({ vendor: 'openllm' })` |
| Connection status | ✅ Complete | Status bar item + status panel |
| Web-based configuration | ✅ Complete | Dashboard at localhost:8787 |

---

## Out of Scope

| Item | Notes |
|------|-------|
| Chat UI | Extension provides status, not chat interface |
| Model Hosting | Connects to existing running models only |
| Telemetry | No model evaluation or quality metrics |
| Billing | No subscription or payment management |

---

## Session Continuity

A key feature is session continuity across tools:

```bash
# List sessions from any client
$ openllm session list
ID        MODEL           TOPIC                    MESSAGES  SOURCE   AGE
abc123    openai/gpt-4o   Debugging auth module    15        vscode   5m ago
def456    anthropic/...   Code review              8         cli      2h ago

# Continue in CLI
$ openllm session attach abc123

# Export for teammate
$ openllm session export abc123 > debugging-session.json
```

Sessions are JSON files - searchable, diffable, version-controllable.

---

## Deployment

| Component | Distribution |
|-----------|--------------|
| TypeScript Daemon | Node.js package (Linux/macOS/Windows) |
| VS Code Extension | VSIX package → Marketplace |
| Python Client | pip package |
| Web Dashboard | Served by daemon (embedded in process) |

---

## Next Steps

1. **Public Repository** - Move to GitHub organization
2. **Marketplace Publishing** - Submit VS Code extension
3. **PyPI Publishing** - Publish Python gRPC client
4. **RHEL AI Testing** - Validate with RHEL AI endpoints
5. **Ansible Extension Integration** - Enable Ansible extension to use OpenLLM

---

## Appendix: Provider-Specific Notes

### Ollama
- Default endpoint: `http://localhost:11434`
- No API key required
- Model list fetched dynamically

### Azure OpenAI
- Requires custom API base URL
- Model names may differ from OpenAI standard

### OpenRouter
- Aggregator supporting 100+ models
- Single API key for all providers
- Model IDs prefixed with provider

### RHEL AI / vLLM / TGI
- Use OpenAI-compatible provider
- Set custom API base URL
- API key optional depending on server config
