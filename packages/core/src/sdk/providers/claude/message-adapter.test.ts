/**
 * Tests for Claude SDK Message Adapter (packages/core/src/sdk/providers/claude/message-adapter.ts)
 *
 * Validates SDK message adaptation, tool input formatting, and user input conversion.
 */

import { describe, it, expect } from 'vitest';
import { adaptSDKMessage, adaptUserInput } from './message-adapter.js';

// Test helper: SDK message types require fields (parent_tool_use_id, uuid, etc.)
// that are optional in practice. Cast test fixtures to bypass strict type checking.
const asMsg = (m: object) => m as any;

describe('adaptSDKMessage', () => {
  describe('assistant messages', () => {
    it('should handle text-only content', () => {
      const message = {
        type: 'assistant' as const,
        session_id: 'session-123',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello, world!' },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('Hello, world!');
      expect(result.role).toBe('assistant');
      expect(result.metadata?.sessionId).toBe('session-123');
    });

    it('should handle tool_use content', () => {
      const message = {
        type: 'assistant' as const,
        session_id: 'session-456',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
            { type: 'text', text: 'Listing files' },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('tool_use');
      expect(result.content).toContain('Running: ls -la');
      expect(result.content).toContain('Listing files');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.toolInput).toEqual({ command: 'ls -la' });
    });

    it('should handle Edit tool with file_path', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Editing: /src/app.ts');
      expect(result.metadata?.toolName).toBe('Edit');
    });

    it('should handle Read tool', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Reading: /src/app.ts');
    });

    it('should handle Write tool', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/src/new.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Writing: /src/new.ts');
    });

    it('should handle Grep tool with pattern', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Searching for "TODO"');
    });

    it('should handle Glob tool with pattern', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Finding files: **/*.ts');
    });

    it('should handle unknown tool with input', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'CustomTool', input: { key: 'value' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('CustomTool');
      expect(result.content).toContain('key');
    });

    it('should handle tool_use without input', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: undefined },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Bash');
    });

    it('should handle empty content array', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle null/invalid message content', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: 'not an array',
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should extract session_id when present', () => {
      const message = {
        type: 'assistant' as const,
        session_id: 'sess-abc',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.metadata?.sessionId).toBe('sess-abc');
    });

    it('should safely skip non-conforming content blocks via runtime guard', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            42,
            null,
            'invalid',
            { type: 'text', text: 'valid text' },
            { notType: 'missing type field' },
            { type: 'tool_use', name: 'Bash', input: { command: 'echo' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      // Runtime guard should filter out 42, null, 'invalid', and { notType: ... }
      // Only the valid text and tool_use blocks should remain
      expect(result.type).toBe('tool_use');
      expect(result.content).toContain('valid text');
      expect(result.content).toContain('Running: echo');
      expect(result.metadata?.toolName).toBe('Bash');
    });
  });

  describe('tool_progress messages', () => {
    it('should format tool progress with elapsed time', () => {
      const message = {
        type: 'tool_progress' as const,
        tool_name: 'Bash',
        elapsed_time_seconds: 5.3,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('tool_progress');
      expect(result.content).toContain('Running Bash');
      expect(result.content).toContain('5.3s');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.elapsedMs).toBe(5300);
    });

    it('should handle tool_progress without required fields', () => {
      const message = {
        type: 'tool_progress' as const,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('tool_use_summary messages', () => {
    it('should format tool summary', () => {
      const message = {
        type: 'tool_use_summary' as const,
        summary: 'Files modified successfully',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('tool_result');
      expect(result.content).toContain('Files modified successfully');
    });

    it('should handle tool_use_summary without summary', () => {
      const message = {
        type: 'tool_use_summary' as const,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('result messages', () => {
    it('should format success result with cost', () => {
      const message = {
        type: 'result' as const,
        subtype: 'success',
        usage: {
          total_cost: 0.0523,
          total_tokens: 15000,
          input_tokens: 10000,
          output_tokens: 5000,
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('result');
      expect(result.content).toContain('Complete');
      expect(result.content).toContain('$0.0523');
      expect(result.content).toContain('15.0k');
      expect(result.metadata?.costUsd).toBe(0.0523);
      expect(result.metadata?.inputTokens).toBe(10000);
      expect(result.metadata?.outputTokens).toBe(5000);
    });

    it('should format success result without usage', () => {
      const message = {
        type: 'result' as const,
        subtype: 'success',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('result');
      expect(result.content).toBe('✅ Complete');
    });

    it('should format error result', () => {
      const message = {
        type: 'result' as const,
        subtype: 'error_during_execution',
        errors: ['API rate limit exceeded', 'Timeout'],
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('error');
      expect(result.content).toContain('API rate limit exceeded');
      expect(result.content).toContain('Timeout');
    });

    it('should handle result with unknown subtype', () => {
      const message = {
        type: 'result' as const,
        subtype: 'unknown',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('system messages', () => {
    it('should format compacting status', () => {
      const message = {
        type: 'system' as const,
        subtype: 'status',
        status: 'compacting',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('status');
      expect(result.content).toContain('Compacting');
      expect(result.role).toBe('system');
    });

    it('should ignore non-status system messages', () => {
      const message = {
        type: 'system' as const,
        subtype: 'other',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('user and stream_event messages', () => {
    it('should return empty text for user messages', () => {
      const message = {
        type: 'user' as const,
        message: { role: 'user', content: 'hello' },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('user');
    });

    it('should return empty text for stream_event messages', () => {
      const message = {
        type: 'stream_event' as const,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should return empty text for unknown message types', () => {
      const message = {
        type: 'unknown_type' as const,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });
});

describe('adaptUserInput', () => {
  it('should convert UserInput to SDKUserMessage', () => {
    const input = {
      role: 'user' as const,
      content: 'Hello, Claude!',
    };

    const result = adaptUserInput(input);
    expect(result.type).toBe('user');
    expect(result.message.role).toBe('user');
    expect(result.message.content).toBe('Hello, Claude!');
    expect(result.parent_tool_use_id).toBeNull();
    expect(result.session_id).toBe('');
  });

  it('should handle content array', () => {
    const input = {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Hello' }],
    };

    const result = adaptUserInput(input);
    expect(result.type).toBe('user');
    expect(result.message.content).toBeDefined();
  });
});
