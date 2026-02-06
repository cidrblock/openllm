/**
 * Tool translation utilities for different LLM providers
 */

import { Tool, ToolCall } from '../types';

/**
 * Default empty JSON schema for tools with no input parameters
 */
const EMPTY_SCHEMA = {
  type: 'object',
  properties: {},
  required: []
};

/**
 * Ensure a valid JSON schema exists for a tool
 */
function ensureSchema(inputSchema: Record<string, unknown> | undefined | null): Record<string, unknown> {
  if (!inputSchema || Object.keys(inputSchema).length === 0) {
    return EMPTY_SCHEMA;
  }
  return inputSchema;
}

/**
 * Translates VS Code tools to OpenAI format
 * Also works for Azure OpenAI, Mistral, vLLM/RHOAI (OpenAI-compatible)
 */
export function toOpenAITools(tools: Tool[]): object[] {
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || 'No description provided',
      parameters: ensureSchema(t.inputSchema)
    }
  }));
}

/**
 * Translates VS Code tools to Anthropic format
 */
export function toAnthropicTools(tools: Tool[]): object[] {
  return tools.map(t => ({
    name: t.name,
    description: t.description || 'No description provided',
    input_schema: ensureSchema(t.inputSchema)
  }));
}

/**
 * Translates VS Code tools to Google Gemini format
 */
export function toGeminiTools(tools: Tool[]): object[] {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description || 'No description provided',
      parameters: ensureSchema(t.inputSchema)
    }))
  }];
}

/**
 * Translates VS Code tools to Ollama format
 * Ollama uses OpenAI-compatible format for tools
 */
export function toOllamaTools(tools: Tool[]): object[] {
  return toOpenAITools(tools);
}

/**
 * Parse tool calls from OpenAI response
 */
export function parseOpenAIToolCalls(toolCalls: Array<{
  id: string;
  type: string;
  function: { name: string; arguments: string };
}>): ToolCall[] {
  return toolCalls
    .filter(tc => tc.type === 'function')
    .map(tc => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}')
    }));
}

/**
 * Parse tool calls from Anthropic response content
 */
export function parseAnthropicToolCalls(content: Array<{
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}>): ToolCall[] {
  return content
    .filter(c => c.type === 'tool_use')
    .map(c => ({
      id: c.id || '',
      name: c.name || '',
      input: c.input || {}
    }));
}

/**
 * Parse tool calls from Gemini response
 */
export function parseGeminiToolCalls(functionCalls: Array<{
  name: string;
  args: Record<string, unknown>;
}>): ToolCall[] {
  return functionCalls.map((fc, index) => ({
    id: `gemini_call_${index}_${Date.now()}`,
    name: fc.name,
    input: fc.args || {}
  }));
}

/**
 * Format tool result for OpenAI
 */
export function formatOpenAIToolResult(callId: string, content: string): object {
  return {
    role: 'tool',
    tool_call_id: callId,
    content: content
  };
}

/**
 * Format tool result for Anthropic
 */
export function formatAnthropicToolResult(callId: string, content: string, isError?: boolean): object {
  return {
    type: 'tool_result',
    tool_use_id: callId,
    content: content,
    is_error: isError
  };
}

/**
 * Format tool result for Gemini
 */
export function formatGeminiToolResult(name: string, response: Record<string, unknown>): object {
  return {
    functionResponse: {
      name: name,
      response: response
    }
  };
}

/**
 * Get provider-specific tool translator
 */
export function getToolTranslator(providerType: string): {
  translateTools: (tools: Tool[]) => object[];
  parseToolCalls: (response: unknown) => ToolCall[];
} {
  switch (providerType.toLowerCase()) {
    case 'openai':
    case 'azure':
    case 'azureopenai':
    case 'mistral':
    case 'ollama':
    case 'rhoai':
    case 'vllm':
      return {
        translateTools: toOpenAITools,
        parseToolCalls: (response: unknown) => {
          const r = response as { tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> };
          return r.tool_calls ? parseOpenAIToolCalls(r.tool_calls) : [];
        }
      };
    case 'anthropic':
      return {
        translateTools: toAnthropicTools,
        parseToolCalls: (response: unknown) => {
          const r = response as { content?: Array<{ type: string; id?: string; name?: string; input?: Record<string, unknown> }> };
          return r.content ? parseAnthropicToolCalls(r.content) : [];
        }
      };
    case 'gemini':
    case 'google':
      return {
        translateTools: toGeminiTools,
        parseToolCalls: (response: unknown) => {
          const r = response as { functionCalls?: Array<{ name: string; args: Record<string, unknown> }> };
          return r.functionCalls ? parseGeminiToolCalls(r.functionCalls) : [];
        }
      };
    default:
      return {
        translateTools: toOpenAITools,
        parseToolCalls: () => []
      };
  }
}
