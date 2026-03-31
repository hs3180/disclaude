/**
 * Unit tests for Claude SDK Message Adapter
 *
 * Tests conversion between Claude SDK messages and unified AgentMessage types.
 */

import { describe, it, expect } from 'vitest';
import { adaptSDKMessage, adaptUserInput } from './message-adapter.js';

describe('adaptSDKMessage', () => {
  describe('assistant messages', () => {
    it('should convert text-only assistant message', () => {
      const message = {
        type: 'assistant' as const,
        session_id: 'session-123',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello, world!' }],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('Hello, world!');
      expect(result.role).toBe('assistant');
      expect(result.metadata?.sessionId).toBe('session-123');
    });

    it('should convert assistant message with tool_use', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
            { type: 'text', text: 'Listing files' },
          ],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_use');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.toolInput).toEqual({ command: 'ls -la' });
      expect(result.content).toContain('🔧 Running: ls -la');
      expect(result.content).toContain('Listing files');
    });

    it('should format Bash tool input with command', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          ],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.content).toBe('🔧 Running: npm test');
    });

    it('should format Edit tool input with file_path', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.content).toBe('🔧 Editing: /src/app.ts');
    });

    it('should format Read tool input with file_path', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.content).toBe('🔧 Reading: /src/app.ts');
    });

    it('should format Write tool input with file_path', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/src/new.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.content).toBe('🔧 Writing: /src/new.ts');
    });

    it('should format Grep tool input with pattern', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
          ],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.content).toBe('🔧 Searching for "TODO"');
    });

    it('should format Glob tool input with pattern', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } },
          ],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.content).toBe('🔧 Finding files: **/*.ts');
    });

    it('should handle unknown tool name with JSON input', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'CustomTool', input: { key: 'value' } },
          ],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('🔧 CustomTool:');
      expect(result.content).toContain('"key"');
    });

    it('should handle tool_use with no input', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'SomeTool', input: undefined },
          ],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.content).toBe('🔧 SomeTool');
    });

    it('should handle empty content array', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [],
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle missing or non-array content', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: null,
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle long tool input with truncation', () => {
      const longInput = { data: 'x'.repeat(200) };
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'CustomTool', input: longInput },
          ],
        },
      };

      const result = adaptSDKMessage(message);
      // Should be truncated to ~60 chars + "..."
      expect(result.content.length).toBeLessThan(200);
    });
  });

  describe('tool_progress messages', () => {
    it('should convert tool_progress with tool_name and elapsed_time', () => {
      const message = {
        type: 'tool_progress' as const,
        tool_name: 'Bash',
        elapsed_time_seconds: 5.5,
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_progress');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.elapsedMs).toBe(5500);
      expect(result.content).toContain('⏳ Running Bash');
      expect(result.content).toContain('5.5s');
    });

    it('should return empty text when tool_progress fields are missing', () => {
      const message = {
        type: 'tool_progress' as const,
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('tool_use_summary messages', () => {
    it('should convert tool_use_summary with summary text', () => {
      const message = {
        type: 'tool_use_summary' as const,
        summary: 'Files listed successfully',
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_result');
      expect(result.content).toBe('✓ Files listed successfully');
    });

    it('should return empty text when summary is missing', () => {
      const message = {
        type: 'tool_use_summary' as const,
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('result messages', () => {
    it('should convert success result with usage stats', () => {
      const message = {
        type: 'result' as const,
        subtype: 'success',
        usage: {
          total_cost: 0.05,
          total_tokens: 15000,
          input_tokens: 10000,
          output_tokens: 5000,
        },
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('result');
      expect(result.content).toContain('✅ Complete');
      expect(result.content).toContain('$0.0500');
      expect(result.content).toContain('15.0k');
      expect(result.metadata?.costUsd).toBe(0.05);
      expect(result.metadata?.inputTokens).toBe(10000);
      expect(result.metadata?.outputTokens).toBe(5000);
    });

    it('should convert success result without usage stats', () => {
      const message = {
        type: 'result' as const,
        subtype: 'success',
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('result');
      expect(result.content).toBe('✅ Complete');
    });

    it('should convert error_during_execution result', () => {
      const message = {
        type: 'result' as const,
        subtype: 'error_during_execution',
        errors: ['Timeout', 'Connection refused'],
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('error');
      expect(result.content).toBe('❌ Error: Timeout, Connection refused');
    });

    it('should return empty text for unknown result subtypes', () => {
      const message = {
        type: 'result' as const,
        subtype: 'unknown',
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('system messages', () => {
    it('should convert compacting status system message', () => {
      const message = {
        type: 'system' as const,
        subtype: 'status',
        status: 'compacting',
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('status');
      expect(result.content).toContain('🔄 Compacting conversation history...');
      expect(result.role).toBe('system');
    });

    it('should return empty text for other system messages', () => {
      const message = {
        type: 'system' as const,
        subtype: 'other',
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('system');
    });
  });

  describe('user and stream_event messages', () => {
    it('should return empty text for user messages', () => {
      const message = {
        type: 'user' as const,
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('user');
    });

    it('should return empty text for stream events', () => {
      const message = {
        type: 'stream_event' as const,
      };

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('user');
    });
  });

  describe('session_id extraction', () => {
    it('should extract session_id when present', () => {
      const message = {
        type: 'assistant' as const,
        session_id: 'my-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      };

      const result = adaptSDKMessage(message);
      expect(result.metadata?.sessionId).toBe('my-session');
    });

    it('should not set sessionId when absent', () => {
      const message = {
        type: 'assistant' as const,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      };

      const result = adaptSDKMessage(message);
      expect(result.metadata?.sessionId).toBeUndefined();
    });

    it('should not set sessionId when empty string', () => {
      const message = {
        type: 'assistant' as const,
        session_id: '',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
      };

      const result = adaptSDKMessage(message);
      expect(result.metadata?.sessionId).toBeUndefined();
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
});
