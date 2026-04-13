/**
 * Tests for Claude SDK Message Adapter (packages/core/src/sdk/providers/claude/message-adapter.ts)
 *
 * Validates SDK message adaptation, tool input formatting, and user input conversion.
 */

import { describe, it, expect } from 'vitest';
import { adaptSDKMessage, adaptUserInput } from './message-adapter.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Shared base properties required by most SDKMessage subtypes in newer SDK versions
const base = {
  parent_tool_use_id: null as string | null,
  uuid: '00000000-0000-4000-8000-000000000001',
  session_id: 'test-session-001',
};

describe('adaptSDKMessage', () => {
  describe('assistant messages', () => {
    it('should handle text-only content', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Hello, world!' },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('Hello, world!');
      expect(result.role).toBe('assistant');
      expect(result.metadata?.sessionId).toBe('test-session-001');
    });

    it('should handle tool_use content', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        session_id: 'session-456',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
            { type: 'text', text: 'Listing files' },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_use');
      expect(result.content).toContain('Running: ls -la');
      expect(result.content).toContain('Listing files');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.toolInput).toEqual({ command: 'ls -la' });
    });

    it('should handle Edit tool with file_path', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Editing: /src/app.ts');
      expect(result.metadata?.toolName).toBe('Edit');
    });

    it('should handle Read tool', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Reading: /src/app.ts');
    });

    it('should handle Write tool', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Write', input: { file_path: '/src/new.ts' } },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Writing: /src/new.ts');
    });

    it('should handle Grep tool with pattern', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Searching for "TODO"');
    });

    it('should handle Glob tool with pattern', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Finding files: **/*.ts');
    });

    it('should handle unknown tool with input', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'CustomTool', input: { key: 'value' } },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('CustomTool');
      expect(result.content).toContain('key');
    });

    it('should handle tool_use without input', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'Bash', input: undefined },
          ],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Bash');
    });

    it('should handle empty content array', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        message: {
          role: 'assistant',
          content: [],
        },
      } as unknown as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle null/invalid message content', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        message: {
          role: 'assistant',
          content: 'not an array',
        },
      } as unknown as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should extract session_id when present', () => {
      const message = {
        type: 'assistant' as const,
        ...base,
        session_id: 'sess-abc',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi' }],
        },
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.metadata?.sessionId).toBe('sess-abc');
    });
  });

  describe('tool_progress messages', () => {
    it('should format tool progress with elapsed time', () => {
      const message = {
        type: 'tool_progress' as const,
        tool_use_id: 'tool-use-001',
        tool_name: 'Bash',
        ...base,
        elapsed_time_seconds: 5.3,
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_progress');
      expect(result.content).toContain('Running Bash');
      expect(result.content).toContain('5.3s');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.elapsedMs).toBe(5300);
    });

    it('should handle tool_progress without required fields', () => {
      const message = {
        type: 'tool_progress' as const,
        tool_use_id: 'tool-use-002',
        tool_name: 'UnknownTool',
        ...base,
        elapsed_time_seconds: 0,
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_progress');
    });
  });

  describe('tool_use_summary messages', () => {
    it('should format tool summary', () => {
      const message = {
        type: 'tool_use_summary' as const,
        summary: 'Files modified successfully',
        preceding_tool_use_ids: ['tool-use-001'],
        ...base,
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_result');
      expect(result.content).toContain('Files modified successfully');
    });

    it('should handle tool_use_summary with minimal fields', () => {
      const message = {
        type: 'tool_use_summary' as const,
        summary: 'minimal summary',
        preceding_tool_use_ids: [] as string[],
        uuid: '00000000-0000-4000-8000-000000000002',
        session_id: 'sess-min',
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_result');
      expect(result.content).toContain('minimal summary');
    });
  });

  describe('result messages', () => {
    it('should format success result with cost', () => {
      const message = {
        type: 'result' as const,
        subtype: 'success',
        duration_ms: 1234,
        duration_api_ms: 1100,
        is_error: false,
        num_turns: 3,
        result: 'done',
        stop_reason: 'end_turn',
        total_cost_usd: 0.0523,
        usage: {
          total_cost: 0.0523,
          total_tokens: 15000,
          input_tokens: 10000,
          output_tokens: 5000,
        },
        modelUsage: {},
        permission_denials: [],
        errors: [],
        ...base,
      } as unknown as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('result');
      expect(result.content).toContain('Complete');
      expect(result.content).toContain('$0.0523');
      expect(result.content).toContain('15.0k');
      expect(result.metadata?.costUsd).toBe(0.0523);
      expect(result.metadata?.inputTokens).toBe(10000);
      expect(result.metadata?.outputTokens).toBe(5000);
    });

    it('should format success result with zero usage', () => {
      const message = {
        type: 'result' as const,
        subtype: 'success',
        duration_ms: 500,
        duration_api_ms: 400,
        is_error: false,
        num_turns: 1,
        result: 'ok',
        stop_reason: 'end_turn',
        total_cost_usd: 0,
        usage: {
          total_cost: 0,
          total_tokens: 0,
          input_tokens: 0,
          output_tokens: 0,
        },
        modelUsage: {},
        permission_denials: [],
        errors: [],
        ...base,
      } as unknown as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('result');
      // Zero usage still produces output since total_cost=0 and total_tokens=0 are defined
      expect(result.content).toContain('Complete');
    });

    it('should format error result', () => {
      const message = {
        type: 'result' as const,
        subtype: 'error_during_execution',
        duration_ms: 100,
        duration_api_ms: 80,
        is_error: true,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0.01,
        usage: {
          total_cost: 0.01,
          total_tokens: 1000,
          input_tokens: 500,
          output_tokens: 500,
        },
        modelUsage: {},
        permission_denials: [],
        errors: ['API rate limit exceeded', 'Timeout'],
        ...base,
      } as unknown as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('error');
      expect(result.content).toContain('API rate limit exceeded');
      expect(result.content).toContain('Timeout');
    });

    it('should handle result with unknown subtype', () => {
      const message = {
        type: 'result' as const,
        subtype: 'error_max_turns',
        duration_ms: 200,
        duration_api_ms: 150,
        is_error: true,
        num_turns: 10,
        stop_reason: null,
        total_cost_usd: 0.5,
        usage: {
          total_cost: 0.5,
          total_tokens: 5000,
          input_tokens: 3000,
          output_tokens: 2000,
        },
        modelUsage: {},
        permission_denials: [],
        errors: ['Max turns reached'],
        ...base,
      } as unknown as SDKMessage;

      const result = adaptSDKMessage(message);
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
        ...base,
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('status');
      expect(result.content).toContain('Compacting');
      expect(result.role).toBe('system');
    });

    it('should ignore non-status system messages', () => {
      const message = {
        type: 'system' as const,
        subtype: 'init',
        agents: [],
        apiKeySource: 'api_key',
        betas: [],
        claude_code_version: '1.0.0',
        cwd: '/test',
        tools: [],
        mcp_servers: [],
        model: 'claude-3',
        permissionMode: 'default',
        slash_commands: [],
        output_style: 'default',
        skills: [],
        plugins: [],
        ...base,
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('user and stream_event messages', () => {
    it('should return empty text for user messages', () => {
      const message = {
        type: 'user' as const,
        message: { role: 'user', content: 'hello' },
        ...base,
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('user');
    });

    it('should return empty text for stream_event messages', () => {
      const message = {
        type: 'stream_event' as const,
        event: { type: 'message_start' },
        ...base,
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should return empty text for unknown message types', () => {
      // SDKMessage is a strict union — unknown types cannot be created.
      // We test the default branch indirectly: 'user' and 'stream_event'
      // both fall through to the default case, which returns empty text.
      const message = {
        type: 'user' as const,
        message: { role: 'user', content: 'fallback test' },
        ...base,
      } as SDKMessage;

      const result = adaptSDKMessage(message);
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
