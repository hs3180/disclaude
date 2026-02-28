/**
 * Unit tests for Claude SDK message adapter
 */

import { describe, it, expect } from 'vitest';
import {
  adaptSDKMessage,
  adaptUserInput,
} from './message-adapter.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { UserInput } from '../../types.js';

describe('message-adapter', () => {
  describe('adaptSDKMessage', () => {
    it('should handle assistant message with text content', () => {
      const message = {
        type: 'assistant',
        session_id: 'test-session',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('Hello world');
      expect(result.role).toBe('assistant');
      expect(result.metadata?.sessionId).toBe('test-session');
    });

    it('should handle assistant message with tool_use', () => {
      const message = {
        type: 'assistant',
        session_id: 'test-session',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Running command' },
            {
              type: 'tool_use',
              name: 'Bash',
              input: { command: 'ls -la' },
            },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('tool_use');
      expect(result.role).toBe('assistant');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.toolInput).toEqual({ command: 'ls -la' });
      expect(result.content).toContain('Running command');
      expect(result.content).toContain('Running: ls -la');
    });

    it('should handle assistant message without content array', () => {
      const message = {
        type: 'assistant',
        session_id: 'test-session',
        message: {
          role: 'assistant',
          content: null,
        },
      } as unknown as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('assistant');
    });

    it('should handle assistant message without message', () => {
      const message = {
        type: 'assistant',
        session_id: 'test-session',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('assistant');
    });

    it('should handle tool_progress message', () => {
      const message = {
        type: 'tool_progress',
        session_id: 'test-session',
        tool_name: 'Bash',
        elapsed_time_seconds: 5.5,
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('tool_progress');
      expect(result.content).toContain('Running Bash');
      expect(result.content).toContain('5.5s');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.elapsedMs).toBe(5500);
    });

    it('should handle tool_progress message without required fields', () => {
      const message = {
        type: 'tool_progress',
        session_id: 'test-session',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle tool_use_summary message', () => {
      const message = {
        type: 'tool_use_summary',
        session_id: 'test-session',
        summary: 'File read successfully',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('tool_result');
      expect(result.content).toContain('File read successfully');
    });

    it('should handle tool_use_summary message without summary', () => {
      const message = {
        type: 'tool_use_summary',
        session_id: 'test-session',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle result message with success', () => {
      const message = {
        type: 'result',
        subtype: 'success',
        session_id: 'test-session',
        usage: {
          total_cost: 0.0123,
          total_tokens: 5000,
          input_tokens: 3000,
          output_tokens: 2000,
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('result');
      expect(result.content).toContain('Complete');
      expect(result.content).toContain('$0.0123');
      expect(result.content).toContain('5.0k');
      expect(result.metadata?.costUsd).toBe(0.0123);
      expect(result.metadata?.inputTokens).toBe(3000);
      expect(result.metadata?.outputTokens).toBe(2000);
    });

    it('should handle result message with success but no usage', () => {
      const message = {
        type: 'result',
        subtype: 'success',
        session_id: 'test-session',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('result');
      expect(result.content).toBe('✅ Complete');
    });

    it('should handle result message with error_during_execution', () => {
      const message = {
        type: 'result',
        subtype: 'error_during_execution',
        session_id: 'test-session',
        errors: ['Error 1', 'Error 2'],
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('error');
      expect(result.content).toContain('Error 1, Error 2');
    });

    it('should handle result message with unknown subtype', () => {
      const message = {
        type: 'result',
        subtype: 'unknown',
        session_id: 'test-session',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle system message with compacting status', () => {
      const message = {
        type: 'system',
        subtype: 'status',
        status: 'compacting',
        session_id: 'test-session',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('status');
      expect(result.content).toContain('Compacting');
      expect(result.role).toBe('system');
    });

    it('should handle system message with non-compacting status', () => {
      const message = {
        type: 'system',
        subtype: 'status',
        status: 'idle',
        session_id: 'test-session',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle system message without status subtype', () => {
      const message = {
        type: 'system',
        subtype: 'other',
        session_id: 'test-session',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle user message', () => {
      const message = {
        type: 'user',
        session_id: 'test-session',
        message: {
          role: 'user',
          content: 'Hello',
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('user');
    });

    it('should handle stream_event message', () => {
      const message = {
        type: 'stream_event',
        session_id: 'test-session',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle unknown message type', () => {
      const message = {
        type: 'unknown',
        session_id: 'test-session',
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle message without session_id', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello' }],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.metadata?.sessionId).toBeUndefined();
    });

    // Tests for formatToolInput via adaptSDKMessage
    it('should format Edit tool input', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { file_path: '/path/to/file.ts' },
            },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.content).toContain('Editing: /path/to/file.ts');
    });

    it('should format Edit tool input with filePath', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Edit',
              input: { filePath: '/path/to/file.ts' },
            },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.content).toContain('Editing: /path/to/file.ts');
    });

    it('should format Read tool input', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              input: { file_path: '/path/to/file.ts' },
            },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.content).toContain('Reading: /path/to/file.ts');
    });

    it('should format Write tool input', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { file_path: '/path/to/file.ts' },
            },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.content).toContain('Writing: /path/to/file.ts');
    });

    it('should format Grep tool input', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Grep',
              input: { pattern: 'searchTerm' },
            },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.content).toContain('Searching for "searchTerm"');
    });

    it('should format Grep tool input without pattern', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Grep',
              input: {},
            },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.content).toContain('Searching');
    });

    it('should format Glob tool input', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Glob',
              input: { pattern: '**/*.ts' },
            },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.content).toContain('Finding files: **/*.ts');
    });

    it('should format unknown tool input', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'CustomTool',
              input: { foo: 'bar' },
            },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.content).toContain('CustomTool');
      expect(result.content).toContain('foo');
    });

    it('should format tool input without input object', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              input: undefined,
            },
          ],
        },
      } as unknown as SDKMessage;

      const result = adaptSDKMessage(message);

      // When input is undefined, formatToolInput returns just the tool name
      expect(result.content).toContain('🔧 Bash');
    });

    it('should handle tool_use without name', () => {
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              input: { command: 'ls' },
            },
          ],
        },
      } as unknown as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.type).toBe('tool_use');
      // Should still process but without tool name metadata
      expect(result.metadata?.toolName).toBeUndefined();
    });

    it('should handle long tool input by truncating', () => {
      const longInput = { data: 'a'.repeat(200) };
      const message = {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'CustomTool',
              input: longInput,
            },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);

      expect(result.content).toContain('CustomTool');
      // Should be truncated
      expect(result.content.length).toBeLessThan(300);
    });
  });

  describe('adaptUserInput', () => {
    it('should convert UserInput to SDKUserMessage', () => {
      const input: UserInput = {
        role: 'user',
        content: 'Hello world',
      };

      const result = adaptUserInput(input);

      expect(result.type).toBe('user');
      expect(result.message.role).toBe('user');
      expect(result.message.content).toBe('Hello world');
      expect(result.parent_tool_use_id).toBeNull();
      expect(result.session_id).toBe('');
    });

    it('should handle empty content', () => {
      const input: UserInput = {
        role: 'user',
        content: '',
      };

      const result = adaptUserInput(input);

      expect(result.message.content).toBe('');
    });

    it('should handle multiline content', () => {
      const input: UserInput = {
        role: 'user',
        content: 'Line 1\nLine 2\nLine 3',
      };

      const result = adaptUserInput(input);

      expect(result.message.content).toBe('Line 1\nLine 2\nLine 3');
    });
  });
});
