[ANSTRAT-####] Create "Open LLM" Provider Extension for VS Code
Type: Feature
Priority: Major
Status: In Development
Component: dev-tools, vscode-plugin
Labels: ai-readiness, open-source, developer-experience

## Goals

1. **Decouple Provider Logic:** Abstract the complexity of connecting to various LLM providers (OpenAI, Anthropic, Ollama, Llamafile, RHEL AI) away from the core Ansible VS Code extension.
2. **Enable "Bring Your Own Model" (BYOM):** Provide a standardized, open-source mechanism for users to bring their own model endpoints (local or remote) without requiring proprietary subscriptions or specific vendor lock-in.
3. **Centralize Configuration:** Allow users to configure their LLM credentials and endpoints in a single location (the "Open LLM" extension) that can be consumed by multiple downstream Red Hat extensions.
4. **Accelerate AI Infusion:** Reduce the engineering effort required to add AI features to the Ansible portfolio by providing a ready-made communication layer.
5. **Provide Production-Ready Chat UI:** Offer a complete, reusable chat interface that downstream extensions can leverage without implementing their own.

## Background and Strategic Fit

### Problem Description

Currently, integrating AI into the Ansible VS Code extension requires implementing specific clients for every provider we wish to support (e.g., the work done in ANSTRAT-505 for Gemini and the work currently being scoped in ANSTRAT-1828 for RHEL AI). This approach is not scalable. It forces our engineering team to maintain authentication logic, API schema mapping, and connection handling for a fragmented ecosystem of providers.

Furthermore, many Enterprise Developers (a primary persona in our dev tools strategy) operate in air-gapped environments or have strict data privacy requirements that mandate the use of local models (e.g., via Ollama or Llamafile) or specific corporate-hosted inference servers. We currently lack a unified, open way to support these disparate endpoints without bloating the core Ansible extension.

Additionally, each extension that wants to offer AI chat capabilities must implement its own chat UI, leading to inconsistent user experiences and duplicated effort.

### Summary

This feature proposes the development of a new, open-source VS Code extension (currently codenamed "Open LLM"). This extension serves as a provider-agnostic middleware layer with a production-ready chat interface, allowing downstream extensions—specifically the Ansible VS Code extension—to offload both the "plumbing" of LLM connectivity and the chat UI implementation.

The implementation uses a **Rust core** with bindings for Node.js and Python, enabling the same provider configuration to be shared across VS Code, CLI tools, and scripts. The extension integrates with VS Code's native `LanguageModelChatProvider` interface, making configured models available to any VS Code extension via the standard `vscode.lm` API.

This feature directly supports our Agentic Orchestration strategy by establishing the necessary client-side infrastructure to communicate with diverse AI agents and models. It aims to fulfill the developer experience vision outlined in our cohesive toolchain strategy by meeting developers where they are, regardless of which model provider they prefer or are authorized to use.

## Assumptions

1. The "Open LLM" extension will be released as an open-source project (MIT license) to encourage community contribution.
2. The initial consumer of this provider will be the Ansible VS Code extension.
3. Users accept the responsibility of procuring their own API keys or hosting their own local models (this is a "Bring Your Own" tool, not a managed service).
4. The extension will support text/code generation APIs (chat completions) with streaming and tool calling (function calling) for providers that support it.
5. The extension will integrate with VS Code's native Language Model API (`vscode.lm`), not a custom proprietary API.
6. The chat UI will be production-ready and reusable by downstream extensions via VS Code commands.

## User Stories

| ID | Title | User Story | Persona | Importance |
|----|-------|------------|---------|------------|
| 1 | Centralized Config | As an Enterprise Developer, I want to configure my corporate LLM endpoint and API key in one place so that I don't have to re-enter credentials for every Red Hat extension I use. | Enterprise Developer | High |
| 2 | Local Model Support | As a Security-Conscious Developer, I want to connect VS Code to a local Ollama instance running on my laptop so that my code never leaves my local network. | Open Source Contributor | High |
| 3 | Simplified Integration | As an Ansible Tooling Developer, I want to query a standardized API for code generation so that I can focus on prompt engineering rather than maintaining HTTP clients for 10+ different providers. | Internal Dev | High |
| 4 | Provider Switching | As a Platform Engineer, I want to easily toggle between a fast local model for simple tasks and a powerful cloud model for complex reasoning without restarting my IDE. | Platform Engineer | Medium |
| 5 | Cross-Tool Config | As a Developer, I want my LLM configuration (providers, models, API keys) to work in VS Code, Python scripts, and CLI tools without duplication. | Platform Engineer | Medium |
| 6 | Air-Gap Support | As a Security-Conscious Developer, I want to use corporate-hosted inference servers (RHEL AI, vLLM) via custom API endpoints without internet access. | Enterprise Developer | High |
| 7 | Reusable Chat UI | As an Extension Developer, I want to invoke a production-ready chat interface from my extension so that I don't have to build my own chat UI. | Internal Dev | High |
| 8 | Tool Calling | As a Developer, I want the LLM to be able to use VS Code tools (file reading, terminal commands) so that I can have agentic workflows. | Platform Engineer | Medium |

## Open Questions

| Question | Status | Notes |
|----------|--------|-------|
| **Naming:** "Open LLM" is currently in use by other projects (BentoML's OpenLLM). What will be the official, trademark-friendly name? | Open | Current placeholder: "Open LLM Provider". Trademark search needed. |
| **Governance:** Will this reside under the ansible, redhat-developer, or standalone GitHub organization? | Open | Recommend `redhat-developer/` for multi-extension use or standalone org for community project. |
| **API Standard:** Will we standardize strictly on the OpenAI API spec for the interface between extensions, or define a custom abstract protocol? | Resolved | Uses VS Code's native `LanguageModelChatProvider` interface (based on OpenAI chat completions shape). Downstream extensions use standard `vscode.lm` API. |

## Links

- Prototype Source: GitHub - cidrblock/openllm Prototype

## Out of Scope

- **Model Hosting:** This extension will not bundle or host models itself. It connects to existing running models.
- **Proprietary/Paid Subscriptions:** This extension will not manage billing or Red Hat subscriptions.
- **Telemetry for Model Performance:** Evaluation of model quality is out of scope.
- **Agent Orchestration Logic:** The extension provides tool calling primitives; multi-step agent loops are downstream responsibility.
- **Model Fine-Tuning or Training:** This is an inference client only.
- **Domain-Specific UI Components:** Code lenses, inline completions, and domain-specific UX (e.g., Ansible playbook generation) remain the responsibility of downstream extensions.

## Architecture Overview

The extension consists of three layers:

1. **Rust Core (`openllm-core`):** Implements all provider logic, configuration management, and secret resolution. This is the single source of truth for LLM connectivity.

2. **Language Bindings:**
   - **Node.js (NAPI-rs):** Used by the VS Code extension for direct, high-performance access to the Rust core.
   - **Python (PyO3):** Enables CLI tools, scripts, and Jupyter notebooks to share the same configuration.

3. **VS Code Extension:** Three distinct roles:
   - **Configuration UI:** Provider/model management, API key input, settings modal.
   - **VS Code API Proxy:** JSON-RPC server that allows the Rust core to read/write VS Code settings and secrets when the user chooses VS Code as their storage backend.
   - **Chat UI:** Production-ready chat sidebar and playground for interacting with configured models.

The extension integrates with VS Code's native `LanguageModelChatProvider`, making configured models discoverable by any VS Code extension via the standard `vscode.lm` API.

## Acceptance Criteria

### Project Setup & Naming

- [ ] A unique, viable project name must be selected that does not infringe on existing trademarks (replacing "Open LLM").
- [x] A public GitHub repository must be established with appropriate open-source licensing (MIT).

### Core Functionality

- [x] The extension must be able to discover and connect to local Ollama instances automatically or via configuration.
- [x] The extension must support Llamafile via OpenAI-compatible endpoint with custom API base URL.
- [x] The extension must support generic OpenAI-compatible API endpoints (vLLM, RHEL AI, text-generation-inference, etc.).
- [x] The extension must securely store API keys using VS Code SecretStorage API.
- [x] The extension must support system keychain storage (macOS Keychain, Windows Credential Manager, Linux Secret Service).
- [x] The extension must support workspace-level and user-level configuration scoping.
- [x] The extension must support environment variables and .env files as fallback secret sources.

### Supported Providers

| Provider | Status | Notes |
|----------|--------|-------|
| OpenAI | ✅ Complete | GPT-4, GPT-3.5, o1, etc. |
| Anthropic | ✅ Complete | Claude 3.5, Claude 3 |
| Google Gemini | ✅ Complete | Gemini 2.0, 1.5 Pro/Flash |
| Mistral | ✅ Complete | Mistral Large, Medium, Small |
| Ollama | ✅ Complete | Any local model (Llama, Qwen, etc.) |
| Azure OpenAI | ✅ Complete | Corporate Azure endpoints |
| OpenRouter | ✅ Complete | Multi-provider aggregator |
| RHEL AI / vLLM / TGI | ✅ Complete | Via OpenAI-compatible endpoint |

### Extension API (The "Plumbing")

- [x] Models must be registered with VS Code's native `vscode.lm` API as vendor "open-llm".
- [x] Downstream extensions can discover models via `vscode.lm.selectChatModels({ vendor: 'open-llm' })`.
- [x] The API must provide standardized chat requests via `model.sendRequest(messages, options, token)`.
- [x] Tool calling (function calling) must be supported for providers that offer it.
- [ ] The API must allow consuming extensions to retrieve the current status of the connection (Ready, Error, Loading).

### Chat UI

- [x] The extension must provide a production-ready chat sidebar interface.
- [x] The chat UI must support markdown rendering with syntax-highlighted code blocks.
- [x] The chat UI must support file attachment as context.
- [x] The chat UI must support streaming responses with cancellation.
- [x] The chat UI must support session history and persistence.
- [x] The chat UI must support tool calling visualization (when tools are invoked).
- [x] Downstream extensions must be able to invoke chat via `vscode.commands.executeCommand('openLLM.chat.send', { message, context })`.
- [ ] The chat UI must be themeable and match VS Code's native look and feel.

### Configuration Options

| Storage Type | Location | Status |
|--------------|----------|--------|
| VS Code Settings | `settings.json` | ✅ Complete |
| Native YAML (User) | `~/.config/openllm/config.yaml` | ✅ Complete |
| Native YAML (Workspace) | `.config/openllm/config.yaml` | ✅ Complete |

| Secret Storage | Status |
|----------------|--------|
| VS Code SecretStorage | ✅ Complete |
| System Keychain | ✅ Complete |
| Environment Variables | ✅ Complete |
| `.env` files | ✅ Complete |

### Multi-Language Support

- [x] Rust core library (`openllm-core`) with provider implementations.
- [x] Node.js bindings via NAPI-rs (used by VS Code extension).
- [x] Python bindings via PyO3 (for CLI tools and scripts).
- [ ] Published to npm registry (@openllm/native).
- [ ] Published to PyPI (openllm).

### Documentation

- [x] README.md must be created detailing how to configure the extension for common providers.
- [ ] DEVELOPER.md must be created explaining how other extension authors can consume this provider API.
- [x] ARCHITECTURE.md documenting the system design and component relationships.

## How Downstream Extensions Consume This

### Discovering Available Models

Extensions (e.g., Ansible) can discover all user-configured LLM models by calling:

```
vscode.lm.selectChatModels({ vendor: 'open-llm' })
```

This returns models from any configured provider (OpenAI, Anthropic, Ollama, etc.) without knowing which provider is active.

### Sending Chat Requests

Once a model is selected, extensions send requests using VS Code's standard API:

```
const response = await model.sendRequest(messages, options, token)
```

The response is streamed and can include text, tool calls, or errors—all normalized by Open LLM.

### Invoking the Chat UI

Extensions can open the chat interface with pre-populated context:

```
vscode.commands.executeCommand('openLLM.chat.send', { message: 'Explain this playbook', context: fileContents })
```

This allows Ansible to add "Explain with AI" buttons that open the Open LLM chat with context already attached.

## Remaining Work

| Item | Status | Priority |
|------|--------|----------|
| Trademark search for project name | Not Started | High |
| Connection status API for consuming extensions | Not Started | Medium |
| DEVELOPER.md for extension authors | Not Started | Medium |
| Chat UI theming (match VS Code themes) | Not Started | Low |
| Publish to VS Code Marketplace | Not Started | High |
| Publish npm/PyPI packages | Not Started | Medium |
| Validate RHEL AI endpoints | Not Started | High |
| Begin Ansible extension integration | Not Started | High |