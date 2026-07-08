/**
 * Tests for Claude SDK Message Adapter (packages/core/src/sdk/providers/claude/message-adapter.ts)
 *
 * Validates SDK message adaptation, tool input formatting, and user input conversion.
 */

import { describe, it, expect } from 'vitest';
import { adaptSDKMessage, adaptUserInput, TaskSubjectRegistry } from './message-adapter.js';

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

    it('should handle TaskCreate tool (subject + description)', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'TaskCreate', input: { subject: 'Fix login bug', description: 'Fix bug #123 in auth flow' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      // Issue #4200: surface subject + description (SDK TaskCreateInput has no `content` field).
      expect(result.content).toContain('Creating task: Fix login bug');
      expect(result.content).toContain('Fix bug #123 in auth flow');
    });

    it('should handle TaskCreate with subject only (no description)', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'TaskCreate', input: { subject: 'Refactor adapter' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      // No description → no parenthetical, no "<no description>" placeholder.
      expect(result.content).toContain('Creating task: Refactor adapter');
      expect(result.content).not.toContain('<no description>');
    });

    it('should truncate a long task description to 100 chars with "..."', () => {
      const longDescription = 'A'.repeat(150);
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'TaskCreate', input: { subject: 'Long task', description: longDescription } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      // Full 150-char description must NOT survive; the truncated form (97 chars + "...") does.
      expect(result.content).not.toContain(longDescription);
      expect(result.content).toContain(`${'A'.repeat(97)  }...`);
    });

    it('should handle TaskUpdate tool (includes subject, not just id+status)', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '5', subject: 'Fix login bug', status: 'completed' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      // Issue #4200: show the task content so the user knows which task is updated.
      expect(result.content).toContain('Updating task #5');
      expect(result.content).toContain('"Fix login bug"');
      expect(result.content).toContain('completed');
    });

    it('should handle TaskUpdate with only id + status (no subject/activeForm/description)', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '9', status: 'pending' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toContain('Updating task #9');
      expect(result.content).toContain('pending');
      // No label → no empty quotes.
      expect(result.content).not.toContain('""');
    });

    it('should handle TaskUpdate with activeForm when subject is absent', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '7', activeForm: 'Running tests', status: 'in_progress' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      // Issue #4200: fall back to activeForm as the human-readable label.
      expect(result.content).toContain('Running tests');
      expect(result.content).toContain('in_progress');
    });

    it('should fall back to description label in TaskUpdate when subject/activeForm are absent', () => {
      const message = {
        type: 'assistant' as const,
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'TaskUpdate', input: { taskId: '11', description: 'Investigate flaky login on Safari', status: 'in_progress' } },
          ],
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      // Issue #4200 (nit): description is a last-resort label so the id alone is not orphaned.
      expect(result.content).toContain('Updating task #11');
      expect(result.content).toContain('Investigate flaky login on Safari');
      expect(result.content).toContain('in_progress');
    });

    it('Issue #4200 part 2: recalls a recorded label for status-only TaskUpdate', () => {
      const registry = new TaskSubjectRegistry();
      // First update carries activeForm (common when starting a task) → recorded.
      const start = adaptSDKMessage(
        asMsg({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '5', activeForm: 'Running tests', status: 'in_progress' } }],
          },
        }),
        registry,
      );
      expect(start.content).toContain('Running tests');

      // Later status-only update (no subject/activeForm/description) recalls it.
      const done = adaptSDKMessage(
        asMsg({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '5', status: 'completed' } }],
          },
        }),
        registry,
      );
      expect(done.content).toContain('Updating task #5');
      expect(done.content).toContain('"Running tests"');
      expect(done.content).toContain('completed');
    });

    it('Issue #4200 part 2: status-only TaskUpdate with no prior record still falls back', () => {
      const registry = new TaskSubjectRegistry();
      const result = adaptSDKMessage(
        asMsg({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '9', status: 'pending' } }],
          },
        }),
        registry,
      );
      expect(result.content).toContain('Updating task #9');
      expect(result.content).toContain('pending');
      // No recorded label → no empty quotes.
      expect(result.content).not.toContain('""');
    });

    it('Issue #4200 part 2: a later subject-bearing update overrides the recorded label', () => {
      const registry = new TaskSubjectRegistry();
      adaptSDKMessage(
        asMsg({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '3', activeForm: 'Old label', status: 'in_progress' } }],
          },
        }),
        registry,
      );
      const result = adaptSDKMessage(
        asMsg({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '3', subject: 'New label', status: 'completed' } }],
          },
        }),
        registry,
      );
      expect(result.content).toContain('"New label"');
      expect(result.content).not.toContain('Old label');
    });

    it('Issue #4200 part 2: recall is registry-scoped (different queries stay isolated)', () => {
      // Query A records taskId '1'.
      const registryA = new TaskSubjectRegistry();
      adaptSDKMessage(
        asMsg({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '1', activeForm: 'Query A task', status: 'in_progress' } }],
          },
        }),
        registryA,
      );
      // Query B (fresh registry) does NOT see Query A's label for the same taskId.
      const registryB = new TaskSubjectRegistry();
      const result = adaptSDKMessage(
        asMsg({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }],
          },
        }),
        registryB,
      );
      expect(result.content).not.toContain('Query A task');
      expect(result.content).not.toContain('""');
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

    it('should format success result with total_cost_usd (SDK field)', () => {
      const message = {
        type: 'result' as const,
        subtype: 'success',
        total_cost_usd: 0.0789,
        usage: {
          input_tokens: 8000,
          output_tokens: 4000,
        },
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('result');
      expect(result.content).toContain('$0.0789');
      expect(result.content).toContain('12.0k');
      expect(result.metadata?.costUsd).toBe(0.0789);
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

    // 根因记录(D1):GLM + Agent Teams 产生海量未识别 system 消息(task_started 等)。
    // 此前被无差别丢弃成空 text,content 必须保持空(否则 chat-agent.ts:1065 会把
    // 它当回复发给用户),但 subtype 须保留到 metadata 供诊断。
    it('should preserve system subtype in metadata with empty content (D1)', () => {
      const message = {
        type: 'system' as const,
        subtype: 'task_started',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('text');
      expect(result.content).toBe('');
      expect(result.role).toBe('system');
      expect(result.metadata?.systemSubtype).toBe('task_started');
    });

    it('should preserve teammate_* system subtype in metadata', () => {
      const message = {
        type: 'system' as const,
        subtype: 'teammate_spawned',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toBe('');
      expect(result.metadata?.systemSubtype).toBe('teammate_spawned');
    });

    it('should leave systemSubtype undefined when subtype absent', () => {
      const message = {
        type: 'system' as const,
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.content).toBe('');
      expect(result.metadata?.systemSubtype).toBeUndefined();
    });

    it('should NOT preserve subtype for handled status messages (regression)', () => {
      // status / model_refusal_fallback 仍走各自分支,不应携带 systemSubtype
      const message = {
        type: 'system' as const,
        subtype: 'status',
        status: 'requesting',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('status');
      expect(result.metadata?.systemSubtype).toBeUndefined();
    });

    it('should format requesting status (SDK 0.3.x)', () => {
      const message = {
        type: 'system' as const,
        subtype: 'status',
        status: 'requesting',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('status');
      expect(result.content).toContain('Thinking');
      expect(result.role).toBe('system');
    });

    it('should format model_refusal_fallback system message (SDK 0.3.174+)', () => {
      const message = {
        type: 'system' as const,
        subtype: 'model_refusal_fallback',
        fallback_model: 'claude-sonnet-4-6',
      };

      const result = adaptSDKMessage(asMsg(message));
      expect(result.type).toBe('status');
      expect(result.content).toContain('fallback');
      expect(result.content).toContain('claude-sonnet-4-6');
      expect(result.role).toBe('system');
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
