import * as assert from 'assert';
import * as vscode from 'vscode';
import { MessageConverter } from '../MessageConverter';

describe('MessageConverter', () => {
  describe('toCore', () => {
    it('should convert simple text message', () => {
      const vscodeMessages: vscode.LanguageModelChatMessage[] = [
        new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.User,
          'Hello, world!'
        )
      ];

      const coreMessages = MessageConverter.toCore(vscodeMessages);

      assert.strictEqual(coreMessages.length, 1);
      assert.strictEqual(coreMessages[0].role, 'user');
      assert.strictEqual(coreMessages[0].content, 'Hello, world!');
    });

    it('should convert assistant message', () => {
      const vscodeMessages: vscode.LanguageModelChatMessage[] = [
        new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.Assistant,
          'I can help you with that.'
        )
      ];

      const coreMessages = MessageConverter.toCore(vscodeMessages);

      assert.strictEqual(coreMessages.length, 1);
      assert.strictEqual(coreMessages[0].role, 'assistant');
      assert.strictEqual(coreMessages[0].content, 'I can help you with that.');
    });

    it('should handle empty content', () => {
      const vscodeMessages: vscode.LanguageModelChatMessage[] = [
        new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.User,
          ''
        )
      ];

      const coreMessages = MessageConverter.toCore(vscodeMessages);

      assert.strictEqual(coreMessages.length, 1);
      assert.strictEqual(coreMessages[0].role, 'user');
      assert.strictEqual(coreMessages[0].content, ' '); // Should have placeholder
    });

    it('should convert tool call parts to structured content', () => {
      const textPart = new vscode.LanguageModelTextPart('Let me check the weather.');
      const toolCallPart = new vscode.LanguageModelToolCallPart(
        'call_123',
        'get_weather',
        { location: 'San Francisco' }
      );

      const vscodeMessages: vscode.LanguageModelChatMessage[] = [
        new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.Assistant,
          [textPart, toolCallPart]
        )
      ];

      const coreMessages = MessageConverter.toCore(vscodeMessages);

      assert.strictEqual(coreMessages.length, 1);
      assert.strictEqual(coreMessages[0].role, 'assistant');
      assert.ok(Array.isArray(coreMessages[0].content));
      
      const content = coreMessages[0].content as any[];
      assert.strictEqual(content.length, 2);
      
      // Text part
      assert.strictEqual(content[0].type, 'text');
      assert.strictEqual(content[0].text, 'Let me check the weather.');
      
      // Tool call part
      assert.strictEqual(content[1].type, 'tool_use');
      assert.strictEqual(content[1].id, 'call_123');
      assert.strictEqual(content[1].name, 'get_weather');
      assert.deepStrictEqual(content[1].input, { location: 'San Francisco' });
    });

    it('should convert tool result parts to structured content', () => {
      const resultTextPart = new vscode.LanguageModelTextPart('Sunny, 72°F');
      const toolResultPart = new vscode.LanguageModelToolResultPart(
        'call_123',
        [resultTextPart]
      );

      const vscodeMessages: vscode.LanguageModelChatMessage[] = [
        new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.User,
          [toolResultPart]
        )
      ];

      const coreMessages = MessageConverter.toCore(vscodeMessages);

      assert.strictEqual(coreMessages.length, 1);
      assert.strictEqual(coreMessages[0].role, 'user');
      assert.ok(Array.isArray(coreMessages[0].content));
      
      const content = coreMessages[0].content as any[];
      assert.strictEqual(content.length, 1);
      
      assert.strictEqual(content[0].type, 'tool_result');
      assert.strictEqual(content[0].tool_use_id, 'call_123');
      assert.strictEqual(content[0].content, 'Sunny, 72°F');
    });

    it('should handle multiple messages in conversation', () => {
      const vscodeMessages: vscode.LanguageModelChatMessage[] = [
        new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.User,
          'What is the capital of France?'
        ),
        new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.Assistant,
          'The capital of France is Paris.'
        ),
        new vscode.LanguageModelChatMessage(
          vscode.LanguageModelChatMessageRole.User,
          'What about Spain?'
        )
      ];

      const coreMessages = MessageConverter.toCore(vscodeMessages);

      assert.strictEqual(coreMessages.length, 3);
      assert.strictEqual(coreMessages[0].role, 'user');
      assert.strictEqual(coreMessages[1].role, 'assistant');
      assert.strictEqual(coreMessages[2].role, 'user');
    });
  });
});
