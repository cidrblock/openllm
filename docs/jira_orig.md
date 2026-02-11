[ANSTRAT-####] Create "Open LLM" Provider Extension for VS Code
Type: Feature
Priority: Major
Status: New Component: dev-tools, vscode-plugin
Labels: ai-readiness, open-source, developer-experience
Goals
Decouple Provider Logic: Abstract the complexity of connecting to various LLM providers (OpenAI, Anthropic, Ollama, Llamafile, RHEL AI) away from the core Ansible VS Code extension.
Enable "Bring Your Own Model" (BYOM): Provide a standardized, open-source mechanism for users to bring their own model endpoints (local or remote) without requiring proprietary subscriptions or specific vendor lock-in.
Centralize Configuration: Allow users to configure their LLM credentials and endpoints in a single location (the "Open LLM" extension) that can be consumed by multiple downstream Red Hat extensions.
Accelerate AI Infusion: Reduce the engineering effort required to add AI features to the Ansible portfolio by providing a ready-made communication layer.
Background and Strategic Fit
Problem Description
Currently, integrating AI into the Ansible VS Code extension requires implementing specific clients for every provider we wish to support (e.g., the work done in ANSTRAT-505 for Gemini and the work currently being scoped in ANSTRAT-1828 for RHEL AI). This approach is not scalable. It forces our engineering team to maintain authentication logic, API schema mapping, and connection handling for a fragmented ecosystem of providers.
Furthermore, many Enterprise Developers (a primary persona in our dev tools strategy) operate in air-gapped environments or have strict data privacy requirements that mandate the use of local models (e.g., via Ollama or Llamafile) or specific corporate-hosted inference servers. We currently lack a unified, open way to support these disparate endpoints without bloating the core Ansible extension.
Summary
This feature proposes the development of a new, open-source VS Code extension (currently codenamed "Open LLM"). This extension would serve as a provider-agnostic middleware layer, allowing downstream extensions—specifically the Ansible VS Code extension—to offload the "plumbing" of LLM connectivity.
This feature directly supports our Agentic Orchestration strategy by establishing the necessary client-side infrastructure to communicate with diverse AI agents and models. It aims to fulfill the developer experience vision outlined in our cohesive toolchain strategy by meeting developers where they are, regardless of which model provider they prefer or are authorized to use.
Assumptions
The "Open LLM" extension will be released as an open-source project (likely Apache 2.0 or GPL v3) to encourage community contribution.
The initial consumer of this provider will be the Ansible VS Code extension.
Users accept the responsibility of procuring their own API keys or hosting their own local models (this is a "Bring Your Own" tool, not a managed service).
The extension will focus on text/code generation APIs (chat completions) for the MVP.
User Stories
ID
Title
User Story
Persona
Importance
1
Centralized Config
As an Enterprise Developer, I want to configure my corporate LLM endpoint and API key in one place so that I don't have to re-enter credentials for every Red Hat extension I use.
Enterprise Developer
High
2
Local Model Support
As a Security-Conscious Developer, I want to connect VS Code to a local Ollama instance running on my laptop so that my code never leaves my local network.
Open Source Contributor
High
3
Simplified Integration
As an Ansible Tooling Developer, I want to query a standardized API for code generation so that I can focus on prompt engineering rather than maintaining HTTP clients for 10+ different providers.
Internal Dev
High
4
Provider Switching
As a Platform Engineer, I want to easily toggle between a fast local model for simple tasks and a powerful cloud model for complex reasoning without restarting my IDE.
Platform Engineer
Medium

Questions
Naming: "Open LLM" is currently in use by other projects. What will be the official, trademark-friendly name for this extension?
Governance: Will this reside under the ansible GitHub organization or a broader redhat-developer organization?
API Standard: Will we standardize strictly on the OpenAI API spec for the interface between extensions, or define a custom abstract protocol?
Links
Prototype Source: GitHub - cidrblock/openllm Prototype
Out of Scope
UI/UX for Chat: This extension provides the connection, not the chat interface. The actual chat window, code lenses, and interaction UI remain the responsibility of the Ansible VS Code extension.
Model Hosting: This extension will not bundle or host models itself. It connects to existing running models.
Proprietary/Paid Subscriptions: This extension will not manage billing or Red Hat subscriptions.
Telemetry logic for model performance: Evaluation of model quality is out of scope.
Acceptance Criteria
Project Setup & Naming
A unique, viable project name must be selected that does not infringe on existing trademarks (replacing "Open LLM").
A public GitHub repository must be established with appropriate open-source licensing.
Core Functionality
The extension must be able to discover and connect to standard local inference servers (specifically Ollama and Llamafile) automatically or via simple configuration.
The extension must support generic OpenAI-compatible API endpoints (allowing connection to vLLM, RHEL AI, etc.).
The extension must securely store API keys using the VS Code Secret Storage API.
Extension API (The "Plumbing")
The extension must expose a public API (exports) that other VS Code extensions (specifically the Ansible extension) can import.
The API must provide a standardized method for completion and chat requests, normalizing the differences between backend providers.
The API must allow consuming extensions to retrieve the current status of the connection (Ready, Error, Loading).
Documentation
README.md must be created detailing how to configure the extension for common providers (Ollama, OpenAI, RHEL AI).
DEVELOPER.md must be created explaining how other extension authors can consume this provider API.
