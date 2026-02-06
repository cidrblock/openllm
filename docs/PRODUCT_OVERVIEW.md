# Open LLM Provider - Product Overview

**Status:** MVP Complete (In Testing)  
**Version:** 0.1.0  
**Last Updated:** February 2026

---

## Executive Summary

Open LLM Provider is a provider-agnostic middleware layer that enables VS Code extensions and applications to connect to any LLM provider through a unified interface. It fulfills the "Bring Your Own Model" (BYOM) vision by supporting both cloud providers (OpenAI, Anthropic, Google) and local models (Ollama, Llamafile).

The project implements a **Rust core** with bindings for **Node.js**, **Python**, and a **VS Code extension**, enabling consistent LLM access across the entire development toolchain.

---

## Goals Addressed

| Goal | Status | Implementation |
|------|--------|----------------|
| Decouple Provider Logic | ✅ Complete | Rust core handles all provider communication; consumers use high-level APIs |
| Enable BYOM | ✅ Complete | 7 providers supported including local (Ollama) and custom endpoints |
| Centralize Configuration | ✅ Complete | Native YAML config files + VS Code settings with bidirectional sync |
| Accelerate AI Infusion | ✅ Complete | Ready-made communication layer with standard `vscode.lm` API integration |

---

## Supported Providers

| Provider | API Type | Tool Calling | Vision | Streaming | Air-Gap Compatible |
|----------|----------|--------------|--------|-----------|-------------------|
| OpenAI | Cloud | ✓ | ✓ | ✓ | ✗ |
| Anthropic | Cloud | ✓ | ✓ | ✓ | ✗ |
| Google Gemini | Cloud | ✓ | ✓ | ✓ | ✗ |
| Mistral | Cloud | ✓ | ✗ | ✓ | ✗ |
| Azure OpenAI | Cloud/On-Prem | ✓ | ✓ | ✓ | ✓ (corporate) |
| OpenRouter | Cloud | ✓ | ✓ | ✓ | ✗ |
| Ollama | Local | ✗ | ✗ | ✓ | ✓ |

**Note:** Ollama supports any model that can run locally (Llama, Mistral, Qwen, DeepSeek, etc.)

---

## Architecture Overview

### Multi-Language Support

```
┌─────────────────────────────────────────────────────────────────┐
│                    Consumer Applications                         │
│                                                                  │
│   VS Code Extension     Python Applications     Node.js / CLI   │
│   (Ansible, etc.)       (scripts, notebooks)    (automation)    │
│         │                      │                      │          │
│    NAPI Bindings          PyO3 Bindings         NAPI Bindings   │
│         └──────────────────────┼──────────────────────┘          │
└────────────────────────────────┼────────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     openllm-core        │
                    │       (Rust)            │
                    │                         │
                    │   • 7 LLM Providers     │
                    │   • Secret Management   │
                    │   • Config Management   │
                    │   • Streaming Support   │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │    LLM Provider APIs    │
                    └─────────────────────────┘
```

### Why Rust Core?

1. **Single source of truth** - Provider logic implemented once, used everywhere
2. **Performance** - Native async streaming with minimal overhead
3. **Security** - Type safety and memory safety built-in
4. **Portability** - Same bindings work on Windows, macOS, Linux

---

## VS Code Extension

### Four Distinct Roles

| Role | Description | User Benefit |
|------|-------------|--------------|
| **Configuration UI** | Visual interface for managing providers, API keys, and model selection | No YAML editing required |
| **RPC Server** | Bridge between Rust core and VS Code's secure storage | Keys stored securely in VS Code |
| **LM Provider** | Implements VS Code's native `LanguageModelChatProvider` | Works with any VS Code AI extension |
| **Test/Playground** | Built-in chat interface and model comparison tool | Test models before integration |

### Integration with VS Code LM API

Open LLM registers as a "vendor" in VS Code's language model system:

```
Other VS Code Extensions (e.g., Ansible)
         │
         │  vscode.lm.selectChatModels({ vendor: 'open-llm' })
         ▼
Open LLM Extension → Returns configured models
         │
         │  model.sendRequest(messages, options)
         ▼
Rust Core → Streams response from actual provider
```

This means **any extension that uses VS Code's standard LM API can automatically use Open LLM providers** without custom integration code.

---

## Configuration & Secrets

### Configuration Storage Options

| Option | Location | Best For |
|--------|----------|----------|
| VS Code Settings | `settings.json` | VS Code-only users, syncs with Settings Sync |
| Native YAML (User) | `~/.config/openllm/config.yaml` | Shared across all tools (CLI, Python, VS Code) |
| Native YAML (Workspace) | `.config/openllm/config.yaml` | Project-specific provider/model selection |

Users can switch between VS Code and Native config via extension settings.

### API Key Storage Options

| Option | Persistence | Scope | Best For |
|--------|-------------|-------|----------|
| VS Code SecretStorage | Synced | Per-workspace or global | VS Code users, cloud sync |
| System Keychain | OS-level | Global | Shared across all tools, highest security |
| Environment Variables | Session | Process | CI/CD, Docker, scripts |
| `.env` Files | File | Directory | Development, dotenv workflows |

**Resolution Priority:** Environment → VS Code → System Keychain → .env

### Import/Export Capabilities

The extension supports bidirectional migration:
- **Export to Native:** Copy VS Code settings → YAML files (for CLI/Python use)
- **Import from Native:** Copy YAML files → VS Code settings
- **Export Keys:** Copy keys between VS Code, Keychain, and .env

---

## User Stories - Implementation Status

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| 1 | Centralized Config | ✅ Complete | Native YAML config shared across all tools; VS Code settings also supported |
| 2 | Local Model Support | ✅ Complete | Ollama provider with auto-discovery; custom API base URLs supported |
| 3 | Simplified Integration | ✅ Complete | Standard `vscode.lm` API; downstream extensions need zero provider-specific code |
| 4 | Provider Switching | ✅ Complete | Enable/disable providers via UI; switch models without restart |

---

## Acceptance Criteria - Status

### Project Setup & Naming

| Criterion | Status | Notes |
|-----------|--------|-------|
| Unique, viable project name | ⚠️ In Progress | "Open LLM" placeholder; trademark search needed |
| Public GitHub repository | ⚠️ Not Started | Currently in private prototype repository |
| Open-source licensing | ✅ Complete | MIT license applied |

### Core Functionality

| Criterion | Status | Notes |
|-----------|--------|-------|
| Discover/connect to Ollama | ✅ Complete | Auto-connects to localhost:11434 |
| Discover/connect to Llamafile | ⚠️ Partial | Works via custom API base URL (OpenAI-compatible) |
| OpenAI-compatible endpoints | ✅ Complete | vLLM, RHEL AI, text-generation-inference all work via OpenAI provider |
| Secure API key storage | ✅ Complete | VS Code SecretStorage + System Keychain |

### Extension API ("The Plumbing")

| Criterion | Status | Notes |
|-----------|--------|-------|
| Public API for other extensions | ✅ Complete | `vscode.lm.selectChatModels({ vendor: 'open-llm' })` |
| Standardized completion/chat | ✅ Complete | `model.sendRequest(messages, options, token)` |
| Connection status retrieval | ⚠️ Partial | Status panel shows provider status; API access in progress |

### Documentation

| Criterion | Status | Notes |
|-----------|--------|-------|
| README.md for configuration | ✅ Complete | Includes Python, Node.js, and VS Code quick start |
| DEVELOPER.md for extension authors | ⚠️ In Progress | Architecture docs exist; API reference needed |

---

## Out of Scope Items - Confirmed

| Item | Status | Notes |
|------|--------|-------|
| UI/UX for Chat | Clarification | Extension includes test chat UI; production chat UIs remain responsibility of downstream extensions |
| Model Hosting | Confirmed | Extension connects to existing running models only |
| Proprietary/Paid Subscriptions | Confirmed | No billing or subscription management |
| Telemetry for model performance | Confirmed | No model evaluation or quality metrics |

---

## Open Questions

### 1. Naming ("Open LLM")

**Issue:** "OpenLLM" is an existing BentoML project for LLM serving.

**Options:**
- "Open LLM Provider" (current marketplace name)
- "Universal LLM" 
- "LLM Bridge"
- "Ansible AI Provider" (if staying Ansible-specific)

**Recommendation:** Proceed with trademark search for "Open LLM Provider" as distinct from "OpenLLM"

### 2. Governance (GitHub Organization)

**Options:**
- `ansible/` organization - ties to Ansible ecosystem
- `redhat-developer/` organization - broader developer tools scope
- `open-llm/` organization - standalone project

**Recommendation:** `redhat-developer/` if intended for multiple Red Hat extensions; standalone org if true open-source community project

### 3. API Standard

**Current Implementation:** Extension uses VS Code's native `LanguageModelChatProvider` interface, which is based on OpenAI's chat completions API shape.

**For Non-VS Code Consumers:** The Rust core exposes a streaming chat API modeled on OpenAI's API:
- Messages array with roles (user, assistant, system)
- Tool calling support (function definitions, tool results)
- Streaming via async iterators

**Recommendation:** Document the OpenAI-compatible interface as the standard; add OpenAPI spec for direct integrations

---

## Technical Capabilities Beyond Original Scope

The current implementation includes several features beyond the original JIRA scope:

### Tool Calling Support
Models that support function calling (OpenAI, Anthropic, Gemini, Mistral) can invoke VS Code's registered tools. This enables agentic workflows where the LLM can read files, run commands, etc.

### Multi-Model Playground
Built-in UI to send the same prompt to multiple models and compare responses side-by-side. Useful for model evaluation and prompt testing.

### Python & Node.js Bindings
The Rust core is exposed via NAPI (Node.js) and PyO3 (Python) bindings, enabling:
- Python scripts to use the same provider configuration as VS Code
- CLI tools built on the same infrastructure
- Jupyter notebook integration
- Ansible modules/plugins using the same config

### Workspace vs User Scoping
Configuration and secrets can be scoped to user-level (global) or workspace-level (project-specific), enabling:
- Personal API keys at user level
- Team-specific endpoints at workspace level
- Per-project model selection

---

## Deployment Artifacts

| Artifact | Status | Distribution |
|----------|--------|--------------|
| VS Code Extension (.vsix) | ✅ Ready | VS Code Marketplace (pending) |
| Python Package | ⚠️ In Progress | PyPI (pending) |
| npm Package | ✅ Ready | npm registry (pending) |
| Rust Crate | ⚠️ In Progress | crates.io (pending) |

---

## Next Steps

1. **Trademark Search** - Confirm "Open LLM Provider" is viable
2. **Public Repository** - Move to target GitHub organization
3. **Marketplace Publishing** - Submit VS Code extension
4. **API Documentation** - Complete DEVELOPER.md for extension authors
5. **RHEL AI Testing** - Validate with RHEL AI inference endpoints
6. **Ansible Extension Integration** - Begin integration with Ansible VS Code extension

---

## Appendix: Provider-Specific Notes

### Ollama
- Default endpoint: `http://localhost:11434`
- No API key required
- Model list fetched dynamically from running instance
- Supports any GGUF model

### Azure OpenAI
- Requires custom API base URL (resource endpoint)
- Uses API key or Azure AD authentication
- Model names may differ from OpenAI standard

### OpenRouter
- Aggregator supporting 100+ models
- Single API key for all providers
- Model IDs prefixed with provider (e.g., `anthropic/claude-3-opus`)

### RHEL AI / vLLM / TGI
- Use OpenAI provider with custom API base URL
- Works with any OpenAI-compatible inference server
- API key may or may not be required depending on server config
