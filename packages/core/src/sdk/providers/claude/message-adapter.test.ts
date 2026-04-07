/**
 * Tests for Claude SDK message adapter (packages/core/src/sdk/providers/claude/message-adapter.ts)
 *
 * Tests message adaptation between Claude SDK format and unified AgentMessage format:
 * - adaptSDKMessage: Convert SDKMessage → AgentMessage for all message types
 * - adaptUserInput: Convert UserInput → SDKUserMessage
 * - formatToolInput: Tool input formatting for display
 *
 * Issue #1617: test: 提升单元测试覆盖率至 70%
 */

import { describe, it, expect } from 'vitest';
import { adaptSDKMessage, adaptUserInput } from './message-adapter.js';
import type { AgentMessage } from '../../types.js';

describe('adaptSDKMessage', () => {
  describe('assistant messages', () => {
    it('should adapt text-only assistant message', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        session_id: 'session-123',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('text');
      expect(result.content).toBe('Hello world');
      expect(result.role).toBe('assistant');
      expect(result.metadata?.sessionId).toBe('session-123');
    });

    it('should adapt assistant message with tool_use', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        session_id: 'session-456',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me search' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
          ],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('tool_use');
      expect(result.content).toContain('Running');
      expect(result.content).toContain('ls -la');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.toolInput).toEqual({ command: 'ls -la' });
    });

    it('should handle assistant message with empty content', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        session_id: 's1',
        message: {
          role: 'assistant',
          content: [],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle assistant message with missing/invalid content', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        session_id: 's1',
        message: null,
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should format Bash tool input correctly', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.content).toBe('🔧 Running: npm test');
    });

    it('should format Edit tool input correctly', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.content).toBe('🔧 Editing: /src/app.ts');
    });

    it('should format Read tool input correctly', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.content).toBe('🔧 Reading: /src/app.ts');
    });

    it('should format Write tool input correctly', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/out/file.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.content).toBe('🔧 Writing: /out/file.ts');
    });

    it('should format Grep tool input correctly', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
          ],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.content).toBe('🔧 Searching for "TODO"');
    });

    it('should format Glob tool input correctly', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.content).toBe('🔧 Finding files: **/*.ts');
    });

    it('should format unknown tool with JSON input', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'CustomTool', input: { key: 'value' } },
          ],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.content).toContain('🔧 CustomTool:');
      expect(result.content).toContain('key');
    });

    it('should handle tool_use with undefined input', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: undefined },
          ],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      // formatToolInput returns `🔧 ${toolName}` when input is falsy
      expect(result.content).toBe('🔧 Bash');
    });
  });

  describe('tool_progress messages', () => {
    it('should adapt tool_progress with name and elapsed time', () => {
      const sdkMessage = {
        type: 'tool_progress' as const,
        tool_name: 'Bash',
        elapsed_time_seconds: 5.5,
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('tool_progress');
      expect(result.content).toContain('Running Bash');
      expect(result.content).toContain('5.5s');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.elapsedMs).toBe(5500);
    });

    it('should return empty text for tool_progress without required fields', () => {
      const sdkMessage = {
        type: 'tool_progress' as const,
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('tool_use_summary messages', () => {
    it('should adapt tool_use_summary with summary text', () => {
      const sdkMessage = {
        type: 'tool_use_summary' as const,
        summary: 'Found 3 files',
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('tool_result');
      expect(result.content).toContain('Found 3 files');
    });

    it('should return empty text for tool_use_summary without summary', () => {
      const sdkMessage = {
        type: 'tool_use_summary' as const,
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('result messages', () => {
    it('should adapt success result with usage stats', () => {
      const sdkMessage = {
        type: 'result' as const,
        subtype: 'success',
        usage: {
          total_cost: 0.0523,
          total_tokens: 15000,
          input_tokens: 10000,
          output_tokens: 5000,
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('result');
      expect(result.content).toContain('Complete');
      expect(result.content).toContain('$0.0523');
      expect(result.content).toContain('15.0k');
      expect(result.metadata?.costUsd).toBe(0.0523);
      expect(result.metadata?.inputTokens).toBe(10000);
      expect(result.metadata?.outputTokens).toBe(5000);
    });

    it('should adapt success result without usage stats', () => {
      const sdkMessage = {
        type: 'result' as const,
        subtype: 'success',
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('result');
      expect(result.content).toBe('✅ Complete');
    });

    it('should adapt error result with error messages', () => {
      const sdkMessage = {
        type: 'result' as const,
        subtype: 'error_during_execution',
        errors: ['Network timeout', 'API rate limit'],
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('error');
      expect(result.content).toContain('Network timeout');
      expect(result.content).toContain('API rate limit');
    });

    it('should return empty text for unknown result subtype', () => {
      const sdkMessage = {
        type: 'result' as const,
        subtype: 'unknown_subtype',
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('system messages', () => {
    it('should adapt compacting status system message', () => {
      const sdkMessage = {
        type: 'system' as const,
        subtype: 'status',
        status: 'compacting',
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('status');
      expect(result.content).toContain('Compacting');
      expect(result.role).toBe('system');
    });

    it('should return empty text for non-compacting system status', () => {
      const sdkMessage = {
        type: 'system' as const,
        subtype: 'status',
        status: 'idle',
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should return empty text for non-status system messages', () => {
      const sdkMessage = {
        type: 'system' as const,
        subtype: 'other',
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('user and stream_event messages', () => {
    it('should return empty text for user messages', () => {
      const sdkMessage = {
        type: 'user' as const,
        message: { role: 'user', content: 'hello' },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('user');
    });

    it('should return empty text for stream_event messages', () => {
      const sdkMessage = {
        type: 'stream_event' as const,
        data: 'some event data',
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('session_id extraction', () => {
    it('should extract session_id from messages that have it', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        session_id: 'my-session',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.metadata?.sessionId).toBe('my-session');
    });

    it('should not set sessionId when session_id is missing', () => {
      const sdkMessage = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      };

      const result = adaptSDKMessage(sdkMessage);

      expect(result.metadata?.sessionId).toBeUndefined();
    });
  });
});

describe('adaptUserInput', () => {
  it('should adapt string content user input', () => {
    const input = {
      role: 'user' as const,
      content: 'Hello world',
    };

    const result = adaptUserInput(input);

    expect(result.type).toBe('user');
    expect(result.message.content).toBe('Hello world');
    expect(result.parent_tool_use_id).toBeNull();
    expect(result.session_id).toBe('');
  });

  it('should adapt content block array user input', () => {
    const input = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'Hello' },
        { type: 'image' as const, data: 'base64data', mimeType: 'image/png' },
      ],
    };

    const result = adaptUserInput(input);

    expect(result.type).toBe('user');
    expect(result.message.content).toBeDefined();
  });
});
