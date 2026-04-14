/**
 * Tests for Claude SDK Message Adapter (packages/core/src/sdk/providers/claude/message-adapter.ts)
 *
 * Validates SDK message adaptation, tool input formatting, and user input conversion.
 */

import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { adaptSDKMessage, adaptUserInput } from './message-adapter.js';

// ---------------------------------------------------------------------------
// Mock factory helpers — produce complete SDKMessage objects with all required
// properties so that tests remain type-safe and future-proof against SDK type
// changes (e.g. addition of new required fields).
// ---------------------------------------------------------------------------

/** Minimal counter for deterministic UUIDs in test mocks. */
let _uuidSeq = 0;
function nextUuid(): string {
  return `test-uuid-${++_uuidSeq}`;
}

/** Create a complete SDKAssistantMessage mock. */
function mockAssistant(overrides: {
  session_id?: string;
  parent_tool_use_id?: string | null;
  content: unknown[];
}): SDKMessage {
  return {
    type: 'assistant',
    session_id: overrides.session_id ?? 'test-session-id',
    parent_tool_use_id: overrides.parent_tool_use_id ?? null,
    uuid: nextUuid(),
    message: {
      role: 'assistant',
      content: overrides.content as any,
    },
  };
}

/** Create a complete SDKToolProgressMessage mock. */
function mockToolProgress(overrides: {
  tool_name?: string;
  elapsed_time_seconds?: number;
}): SDKMessage {
  return {
    type: 'tool_progress',
    tool_use_id: `tool-use-${nextUuid()}`,
    tool_name: overrides.tool_name ?? 'TestTool',
    parent_tool_use_id: null,
    elapsed_time_seconds: overrides.elapsed_time_seconds ?? 1.0,
    uuid: nextUuid(),
    session_id: 'test-session-id',
  };
}

/** Create a complete SDKToolUseSummaryMessage mock. */
function mockToolUseSummary(overrides: {
  summary?: string;
}): SDKMessage {
  return {
    type: 'tool_use_summary',
    summary: overrides.summary ?? 'Default summary',
    preceding_tool_use_ids: [],
    uuid: nextUuid(),
    session_id: 'test-session-id',
  };
}

/** Create a complete SDKResultSuccess mock. */
function mockResultSuccess(overrides?: {
  usage?: Record<string, unknown>;
}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1000,
    duration_api_ms: 800,
    is_error: false,
    num_turns: 1,
    result: 'done',
    stop_reason: 'end_turn',
    total_cost_usd: 0.01,
    usage: (overrides?.usage ?? {
      input_tokens: 500,
      output_tokens: 500,
    }) as any,
    modelUsage: {},
    permission_denials: [],
    uuid: nextUuid(),
    session_id: 'test-session-id',
  };
}

/** Create a complete SDKResultError mock. */
function mockResultError(errors: string[]): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    duration_ms: 500,
    duration_api_ms: 300,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.005,
    usage: {
      input_tokens: 250,
      output_tokens: 250,
    } as any,
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: nextUuid(),
    session_id: 'test-session-id',
  };
}

/** Create a complete SDKStatusMessage mock. */
function mockSystemStatus(overrides: {
  status: string | null;
}): SDKMessage {
  return {
    type: 'system',
    subtype: 'status',
    status: overrides.status as any,
    uuid: nextUuid(),
    session_id: 'test-session-id',
  };
}

/** Create a complete SDKUserMessage mock. */
function mockUserMessage(overrides: {
  content?: unknown;
}): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user' as const, content: (overrides.content ?? 'hello') as any },
    parent_tool_use_id: null,
    session_id: 'test-session-id',
  };
}

describe('adaptSDKMessage', () => {
  describe('assistant messages', () => {
    it('should handle text-only content', () => {
      const message = mockAssistant({
        session_id: 'session-123',
        content: [
          { type: 'text', text: 'Hello, world!' },
        ],
      });

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('Hello, world!');
      expect(result.role).toBe('assistant');
      expect(result.metadata?.sessionId).toBe('session-123');
    });

    it('should handle tool_use content', () => {
      const message = mockAssistant({
        session_id: 'session-456',
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
          { type: 'text', text: 'Listing files' },
        ],
      });

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_use');
      expect(result.content).toContain('Running: ls -la');
      expect(result.content).toContain('Listing files');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.toolInput).toEqual({ command: 'ls -la' });
    });

    it('should handle Edit tool with file_path', () => {
      const message = mockAssistant({
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
        ],
      });

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Editing: /src/app.ts');
      expect(result.metadata?.toolName).toBe('Edit');
    });

    it('should handle Read tool', () => {
      const message = mockAssistant({
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/src/app.ts' } },
        ],
      });

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Reading: /src/app.ts');
    });

    it('should handle Write tool', () => {
      const message = mockAssistant({
        content: [
          { type: 'tool_use', name: 'Write', input: { file_path: '/src/new.ts' } },
        ],
      });

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Writing: /src/new.ts');
    });

    it('should handle Grep tool with pattern', () => {
      const message = mockAssistant({
        content: [
          { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
        ],
      });

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Searching for "TODO"');
    });

    it('should handle Glob tool with pattern', () => {
      const message = mockAssistant({
        content: [
          { type: 'tool_use', name: 'Glob', input: { pattern: '**/*.ts' } },
        ],
      });

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Finding files: **/*.ts');
    });

    it('should handle unknown tool with input', () => {
      const message = mockAssistant({
        content: [
          { type: 'tool_use', name: 'CustomTool', input: { key: 'value' } },
        ],
      });

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('CustomTool');
      expect(result.content).toContain('key');
    });

    it('should handle tool_use without input', () => {
      const message = mockAssistant({
        content: [
          { type: 'tool_use', name: 'Bash', input: undefined },
        ],
      });

      const result = adaptSDKMessage(message);
      expect(result.content).toContain('Bash');
    });

    it('should handle empty content array', () => {
      const message = mockAssistant({
        content: [],
      });

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should handle null/invalid message content', () => {
      const message = mockAssistant({
        content: 'not an array' as any,
      });

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should extract session_id when present', () => {
      const message = mockAssistant({
        session_id: 'sess-abc',
        content: [{ type: 'text', text: 'hi' }],
      });

      const result = adaptSDKMessage(message);
      expect(result.metadata?.sessionId).toBe('sess-abc');
    });
  });

  describe('tool_progress messages', () => {
    it('should format tool progress with elapsed time', () => {
      const message = mockToolProgress({
        tool_name: 'Bash',
        elapsed_time_seconds: 5.3,
      });

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_progress');
      expect(result.content).toContain('Running Bash');
      expect(result.content).toContain('5.3s');
      expect(result.metadata?.toolName).toBe('Bash');
      expect(result.metadata?.elapsedMs).toBe(5300);
    });

    it('should handle tool_progress without required fields', () => {
      // Deliberately test a partial message missing tool_name/elapsed_time_seconds
      const message = { type: 'tool_progress' as const } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('tool_use_summary messages', () => {
    it('should format tool summary', () => {
      const message = mockToolUseSummary({
        summary: 'Files modified successfully',
      });

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('tool_result');
      expect(result.content).toContain('Files modified successfully');
    });

    it('should handle tool_use_summary without summary', () => {
      // Deliberately test a partial message missing summary
      const message = { type: 'tool_use_summary' as const } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('result messages', () => {
    it('should format success result with cost', () => {
      const message = mockResultSuccess({
        usage: {
          total_cost: 0.0523,
          total_tokens: 15000,
          input_tokens: 10000,
          output_tokens: 5000,
        },
      });

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('result');
      expect(result.content).toContain('Complete');
      expect(result.content).toContain('$0.0523');
      expect(result.content).toContain('15.0k');
      expect(result.metadata?.costUsd).toBe(0.0523);
      expect(result.metadata?.inputTokens).toBe(10000);
      expect(result.metadata?.outputTokens).toBe(5000);
    });

    it('should format success result without usage', () => {
      const base = mockResultSuccess();
      // Remove usage to test the no-usage branch
      const message = { ...base, usage: undefined } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('result');
      expect(result.content).toBe('✅ Complete');
    });

    it('should format error result', () => {
      const message = mockResultError(['API rate limit exceeded', 'Timeout']);

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('error');
      expect(result.content).toContain('API rate limit exceeded');
      expect(result.content).toContain('Timeout');
    });

    it('should handle result with unknown subtype', () => {
      // Test a result message with a subtype that is not 'success' or 'error_during_execution'
      const message = {
        type: 'result' as const,
        subtype: 'unknown',
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('system messages', () => {
    it('should format compacting status', () => {
      const message = mockSystemStatus({ status: 'compacting' });

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('status');
      expect(result.content).toContain('Compacting');
      expect(result.role).toBe('system');
    });

    it('should ignore non-status system messages', () => {
      // Non-'status' subtype system messages should be ignored
      const message = {
        type: 'system' as const,
        subtype: 'other',
      } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });
  });

  describe('user and stream_event messages', () => {
    it('should return empty text for user messages', () => {
      const message = mockUserMessage({ content: 'hello' });

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('user');
    });

    it('should return empty text for stream_event messages', () => {
      // stream_event messages are not fully mocked here — testing that the
      // adapter gracefully ignores them regardless.
      const message = { type: 'stream_event' as const } as SDKMessage;

      const result = adaptSDKMessage(message);
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
    });

    it('should return empty text for unknown message types', () => {
      const message = { type: 'unknown_type' as const } as SDKMessage;

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
