# JIRA Document Migration Guide

This guide provides step-by-step instructions for transforming the original JIRA feature request (`jira_orig.md`) into the comprehensive project specification (`jira.md`).

---

## Overview of Changes

| Aspect | Original | Updated |
|--------|----------|---------|
| Status | "New" | "In Development" |
| Goals | 4 goals | 5 goals (added Chat UI) |
| User Stories | 4 stories | 8 stories |
| Questions | 3 open | 1 resolved, 2 open |
| Out of Scope | 4 items | 6 items (refined) |
| Acceptance Criteria | 10 items | 40+ items with checkboxes |
| New Sections | — | Architecture, Provider Matrix, Configuration Options, Integration Guide, Remaining Work |

---

## Step-by-Step Migration

### Step 1: Update Metadata

**Original:**
```
Status: New Component: dev-tools, vscode-plugin
```

**Change to:**
```
Status: In Development
Component: dev-tools, vscode-plugin
```

**Rationale:** Reflects that development has progressed beyond the proposal stage.

---

### Step 2: Add Proper Markdown Formatting

The original document lacks markdown structure. Add:

- `##` headers for major sections
- `###` sub-headers where appropriate
- Numbered lists for goals
- Proper table syntax for user stories
- Checkbox syntax `- [x]` / `- [ ]` for acceptance criteria

---

### Step 3: Add Goal #5 - Production-Ready Chat UI

**Add after Goal 4:**
```markdown
5. **Provide Production-Ready Chat UI:** Offer a complete, reusable chat interface that downstream extensions can leverage without implementing their own.
```

**Rationale:** The original document listed "Chat UI" as out of scope. Based on stakeholder feedback, providing a reusable chat interface increases the extension's value to downstream consumers.

---

### Step 4: Expand Background Section

**Add to Problem Description:**
```markdown
Additionally, each extension that wants to offer AI chat capabilities must implement its own chat UI, leading to inconsistent user experiences and duplicated effort.
```

**Update Summary paragraph to include:**
- Reference to "production-ready chat interface"
- Technical implementation details (Rust core, Node.js/Python bindings)
- Integration with VS Code's native `LanguageModelChatProvider` interface

---

### Step 5: Update Assumptions

| # | Original | Updated |
|---|----------|---------|
| 1 | "likely Apache 2.0 or GPL v3" | "MIT license" |
| 4 | "focus on text/code generation APIs (chat completions) for the MVP" | "support text/code generation APIs (chat completions) with streaming and tool calling (function calling)" |
| 5 | — | Add: "The extension will integrate with VS Code's native Language Model API (`vscode.lm`), not a custom proprietary API." |
| 6 | — | Add: "The chat UI will be production-ready and reusable by downstream extensions via VS Code commands." |

---

### Step 6: Convert User Stories to Table Format

**Original format (plain text):**
```
ID
Title
User Story
Persona
Importance
1
Centralized Config
As an Enterprise Developer...
```

**Convert to proper markdown table:**
```markdown
| ID | Title | User Story | Persona | Importance |
|----|-------|------------|---------|------------|
| 1 | Centralized Config | As an Enterprise Developer... | Enterprise Developer | High |
```

---

### Step 7: Add New User Stories

Add these 4 new user stories after the original 4:

| ID | Title | User Story | Persona | Importance |
|----|-------|------------|---------|------------|
| 5 | Cross-Tool Config | As a Developer, I want my LLM configuration (providers, models, API keys) to work in VS Code, Python scripts, and CLI tools without duplication. | Platform Engineer | Medium |
| 6 | Air-Gap Support | As a Security-Conscious Developer, I want to use corporate-hosted inference servers (RHEL AI, vLLM) via custom API endpoints without internet access. | Enterprise Developer | High |
| 7 | Reusable Chat UI | As an Extension Developer, I want to invoke a production-ready chat interface from my extension so that I don't have to build my own chat UI. | Internal Dev | High |
| 8 | Tool Calling | As a Developer, I want the LLM to be able to use VS Code tools (file reading, terminal commands) so that I can have agentic workflows. | Platform Engineer | Medium |

---

### Step 8: Convert Questions to Open Questions Table

**Original:**
```
Questions
Naming: "Open LLM" is currently in use...
Governance: Will this reside under...
API Standard: Will we standardize...
```

**Convert to table with status tracking:**
```markdown
## Open Questions

| Question | Status | Notes |
|----------|--------|-------|
| **Naming:** ... | Open | Current placeholder: "Open LLM Provider". Trademark search needed. |
| **Governance:** ... | Open | Recommend `redhat-developer/` for multi-extension use. |
| **API Standard:** ... | Resolved | Uses VS Code's native `LanguageModelChatProvider` interface. |
```

---

### Step 9: Update Out of Scope Section

**Remove:**
- "UI/UX for Chat" (now IN scope)

**Keep:**
- Model Hosting
- Proprietary/Paid Subscriptions  
- Telemetry for Model Performance

**Add:**
- Agent Orchestration Logic
- Model Fine-Tuning or Training
- Domain-Specific UI Components

**Format as bullet list with bold titles:**
```markdown
- **Model Hosting:** This extension will not bundle or host models itself.
- **Agent Orchestration Logic:** The extension provides tool calling primitives; multi-step agent loops are downstream responsibility.
```

---

### Step 10: Add Architecture Overview Section

Insert new section after "Out of Scope":

```markdown
## Architecture Overview

The extension consists of three layers:

1. **Rust Core (`openllm-core`):** Implements all provider logic, configuration management, and secret resolution.

2. **Language Bindings:**
   - **Node.js (NAPI-rs):** Used by the VS Code extension.
   - **Python (PyO3):** Enables CLI tools and scripts.

3. **VS Code Extension:** Three distinct roles:
   - **Configuration UI:** Provider/model management, API key input.
   - **VS Code API Proxy:** JSON-RPC server for Rust core access to VS Code APIs.
   - **Chat UI:** Production-ready chat sidebar and playground.
```

---

### Step 11: Expand Acceptance Criteria

**Convert prose to checkboxes:**

Original:
```
The extension must be able to discover and connect to standard local inference servers...
```

Updated:
```markdown
- [x] The extension must be able to discover and connect to local Ollama instances automatically or via configuration.
- [x] The extension must support Llamafile via OpenAI-compatible endpoint with custom API base URL.
```

**Add new subsections:**

#### Supported Providers (table with status)
| Provider | Status | Notes |
|----------|--------|-------|
| OpenAI | ✅ Complete | GPT-4, GPT-3.5, o1 |
| Anthropic | ✅ Complete | Claude 3.5, Claude 3 |
| ... | ... | ... |

#### Chat UI Requirements
- [x] Production-ready chat sidebar interface
- [x] Markdown rendering with syntax-highlighted code blocks
- [x] File attachment as context
- [x] Streaming responses with cancellation
- [ ] Themeable to match VS Code themes

#### Configuration Options (tables)
| Storage Type | Location | Status |
|--------------|----------|--------|
| VS Code Settings | `settings.json` | ✅ Complete |
| Native YAML (User) | `~/.config/openllm/config.yaml` | ✅ Complete |

#### Multi-Language Support
- [x] Rust core library
- [x] Node.js bindings via NAPI-rs
- [x] Python bindings via PyO3
- [ ] Published to npm registry
- [ ] Published to PyPI

---

### Step 12: Add Integration Guide Section

Insert new section showing how downstream extensions consume the API:

```markdown
## How Downstream Extensions Consume This

### Discovering Available Models
Extensions can discover all user-configured LLM models by calling:
```
vscode.lm.selectChatModels({ vendor: 'open-llm' })
```

### Sending Chat Requests
```
const response = await model.sendRequest(messages, options, token)
```

### Invoking the Chat UI
```
vscode.commands.executeCommand('openLLM.chat.send', { message, context })
```
```

---

### Step 13: Add Remaining Work Section

Add a final section tracking outstanding items:

```markdown
## Remaining Work

| Item | Status | Priority |
|------|--------|----------|
| Trademark search for project name | Not Started | High |
| Connection status API for consuming extensions | Not Started | Medium |
| DEVELOPER.md for extension authors | Not Started | Medium |
| Chat UI theming | Not Started | Low |
| Publish to VS Code Marketplace | Not Started | High |
| Publish npm/PyPI packages | Not Started | Medium |
| Validate RHEL AI endpoints | Not Started | High |
| Begin Ansible extension integration | Not Started | High |
```

---

## Summary Checklist

Use this checklist when updating the JIRA document:

- [ ] Update status from "New" to "In Development"
- [ ] Add proper markdown formatting (headers, tables, checkboxes)
- [ ] Add Goal #5 (Production-Ready Chat UI)
- [ ] Expand Background section with chat UI rationale and technical details
- [ ] Update Assumptions (license, streaming, tool calling, vscode.lm integration)
- [ ] Convert User Stories to table format
- [ ] Add 4 new User Stories (#5-8)
- [ ] Convert Questions to Open Questions table with status
- [ ] Mark API Standard question as "Resolved"
- [ ] Update Out of Scope (remove Chat UI, add new exclusions)
- [ ] Add Architecture Overview section
- [ ] Expand Acceptance Criteria with checkboxes and sub-tables
- [ ] Add Supported Providers table
- [ ] Add Chat UI requirements section
- [ ] Add Configuration Options tables
- [ ] Add Multi-Language Support section
- [ ] Add Integration Guide section
- [ ] Add Remaining Work tracking table

---

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-02-04 | Engineering | Initial JIRA proposal |
| 2.0 | 2026-02-05 | Engineering | Comprehensive update reflecting implementation progress |
