/**
 * ACP 消息适配器测试
 *
 * 测试所有 ACP session/update 类型到 AgentMessage 的映射。
 * 不使用 vi.mock()，纯函数测试。
 */

import { describe, it, expect } from 'vitest';
import type { AcpSessionUpdate, AcpPromptResult } from './types.js';
import { adaptSessionUpdate, adaptPromptResult } from './message-adapter.js';

// ============================================================================
// adaptSessionUpdate 测试
// ============================================================================

describe('adaptSessionUpdate', () => {
  // --------------------------------------------------------------------------
  // agent_message_chunk
  // --------------------------------------------------------------------------
  describe('agent_message_chunk', () => {
    it('maps text content to AgentMessage type=text', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello, world!' },
      };

      const result = adaptSessionUpdate(update);

      expect(result).toEqual({
        type: 'text',
        content: 'Hello, world!',
        role: 'assistant',
        raw: update,
      });
    });

    it('maps image content to text with placeholder', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'base64data', mimeType: 'image/png' },
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('text');
      expect(result!.content).toContain('image');
      expect(result!.content).toContain('image/png');
    });

  });

  // --------------------------------------------------------------------------
  // tool_call (new tool invocation)
  // --------------------------------------------------------------------------
  describe('tool_call', () => {
    it('maps to AgentMessage type=tool_use', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        content: { type: 'text', text: '{"command":"ls -la"}' },
      };

      const result = adaptSessionUpdate(update);

      expect(result).toEqual({
        type: 'tool_use',
        content: '🔧 Bash',
        role: 'assistant',
        metadata: {
          toolName: 'Bash',
          messageId: 'tc-1',
          toolInput: { command: 'ls -la' },
        },
        raw: update,
      });
    });

    it('handles tool_call with non-JSON content as raw string', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-2',
        toolName: 'Read',
        content: { type: 'text', text: 'not valid json' },
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('tool_use');
      expect(result!.metadata!.toolName).toBe('Read');
      expect(result!.metadata!.toolInput).toBe('not valid json');
    });

    it('handles tool_call without content', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-3',
        toolName: 'Glob',
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('tool_use');
      expect(result!.content).toBe('🔧 Glob');
    });

    it('handles tool_call without toolName', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'tool_call',
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('tool_use');
      expect(result!.content).toBe('🔧 unknown');
    });
  });

  // --------------------------------------------------------------------------
  // tool_call_update (in_progress)
  // --------------------------------------------------------------------------
  describe('tool_call_update in_progress', () => {
    it('maps to AgentMessage type=tool_progress', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        state: 'in_progress',
      };

      const result = adaptSessionUpdate(update);

      expect(result).toEqual({
        type: 'tool_progress',
        content: '⏳ Running Bash...',
        role: 'assistant',
        metadata: {
          toolName: 'Bash',
          messageId: 'tc-1',
        },
        raw: update,
      });
    });

    it('handles missing toolName', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'tool_call_update',
        state: 'in_progress',
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('tool_progress');
      expect(result!.content).toContain('Running');
    });
  });

  // --------------------------------------------------------------------------
  // tool_call_update (completed)
  // --------------------------------------------------------------------------
  describe('tool_call_update completed', () => {
    it('maps to AgentMessage type=tool_result', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        state: 'completed',
        content: { type: 'text', text: 'file1.txt\nfile2.txt' },
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('tool_result');
      expect(result!.content).toContain('✓');
      expect(result!.content).toContain('Bash');
      expect(result!.metadata!.toolOutput).toBe('file1.txt\nfile2.txt');
    });

    it('handles completed without content', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-2',
        toolName: 'Read',
        state: 'completed',
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('tool_result');
      expect(result!.content).toBe('✓ Read');
    });
  });

  // --------------------------------------------------------------------------
  // tool_call_update (other states)
  // --------------------------------------------------------------------------
  describe('tool_call_update other states', () => {
    it('maps unknown state to tool_progress', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        state: 'pending',
        content: { type: 'text', text: 'Waiting...' },
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('tool_progress');
      expect(result!.content).toContain('Waiting...');
    });

    it('handles missing state', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'tool_call_update',
        toolName: 'Bash',
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('tool_progress');
      expect(result!.content).toContain('unknown state');
    });
  });

  // --------------------------------------------------------------------------
  // plan
  // --------------------------------------------------------------------------
  describe('plan', () => {
    it('maps plan with title and content to status', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'plan',
        planId: 'plan-1',
        title: 'Implementation Plan',
        content: { type: 'text', text: 'Step 1: Read files\nStep 2: Write code' },
      };

      const result = adaptSessionUpdate(update);

      expect(result).toEqual({
        type: 'status',
        content: 'Step 1: Read files\nStep 2: Write code',
        role: 'system',
        raw: update,
      });
    });

    it('maps plan with only title', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'plan',
        title: 'My Plan',
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('status');
      expect(result!.content).toBe('📋 My Plan');
    });

    it('maps plan with no title or content', () => {
      const update: AcpSessionUpdate = {
        sessionUpdate: 'plan',
      };

      const result = adaptSessionUpdate(update);

      expect(result).toBeDefined();
      expect(result!.type).toBe('status');
      expect(result!.content).toBe('📋 Plan');
    });
  });

  // --------------------------------------------------------------------------
  // Unknown types
  // --------------------------------------------------------------------------
  describe('unknown sessionUpdate type', () => {
    it('returns undefined for unknown update type', () => {
      const update = {
        sessionUpdate: 'unknown_type',
      } as unknown as AcpSessionUpdate;

      const result = adaptSessionUpdate(update);

      expect(result).toBeUndefined();
    });
  });
});

// ============================================================================
// adaptPromptResult 测试
// ============================================================================

describe('adaptPromptResult', () => {
  it('maps result with usage to AgentMessage type=result', () => {
    const result: AcpPromptResult = {
      stopReason: 'end_turn',
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
      },
    };

    const msg = adaptPromptResult(result);

    expect(msg.type).toBe('result');
    expect(msg.role).toBe('assistant');
    expect(msg.content).toContain('✅ Complete');
    expect(msg.content).toContain('1.0k tokens');
    expect(msg.metadata!.inputTokens).toBe(1000);
    expect(msg.metadata!.outputTokens).toBe(500);
    expect(msg.metadata!.stopReason).toBe('end_turn');
  });

  it('maps result without usage', () => {
    const result: AcpPromptResult = {
      stopReason: 'tool_use',
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    const msg = adaptPromptResult(result);

    expect(msg.type).toBe('result');
    expect(msg.content).toContain('✅ Complete');
    expect(msg.metadata!.stopReason).toBe('tool_use');
  });

  it('handles minimal result', () => {
    const result: AcpPromptResult = {
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    };

    const msg = adaptPromptResult(result);

    expect(msg.type).toBe('result');
    expect(msg.role).toBe('assistant');
    expect(msg.metadata).toBeDefined();
  });
});
