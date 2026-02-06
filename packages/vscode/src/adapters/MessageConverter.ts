import * as vscode from 'vscode';
import { ChatMessage, ContentPart } from '../types';

/**
 * Convert VS Code LanguageModelChatMessage to core ChatMessage
 */
export class MessageConverter {
  /**
   * Convert VS Code messages to core format
   */
  static toCore(messages: vscode.LanguageModelChatMessage[]): ChatMessage[] {
    return messages.map(m => this.convertMessage(m));
  }

  /**
   * Convert a single VS Code message to core format
   */
  private static convertMessage(message: vscode.LanguageModelChatMessage): ChatMessage {
    let role: 'system' | 'user' | 'assistant';
    
    if (message.role === vscode.LanguageModelChatMessageRole.User) {
      role = 'user';
    } else if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      role = 'assistant';
    } else {
      role = 'user'; // Default to user for unknown roles
    }

    // Check if we have structured content (tool calls/results)
    const contentParts: ContentPart[] = [];
    let textContent = '';
    let hasStructuredContent = false;

    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        textContent += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        // Tool call from assistant
        hasStructuredContent = true;
        contentParts.push({
          type: 'tool_use',
          id: part.callId,
          name: part.name,
          input: part.input as Record<string, unknown>
        });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        // Tool result from user
        hasStructuredContent = true;
        let resultContent = '';
        for (const resultPart of part.content) {
          if (resultPart instanceof vscode.LanguageModelTextPart) {
            resultContent += resultPart.value;
          }
        }
        contentParts.push({
          type: 'tool_result',
          tool_use_id: part.callId,
          content: resultContent || '[No output]'
        });
      }
    }

    // Return structured content if we have tool calls/results
    if (hasStructuredContent) {
      if (textContent) {
        contentParts.unshift({ type: 'text', text: textContent });
      }
      return { role, content: contentParts };
    }

    // Otherwise return simple text content
    return { role, content: textContent || ' ' };
  }
}
