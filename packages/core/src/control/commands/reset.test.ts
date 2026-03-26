/**
 * Unit tests for reset/restart control commands.
 *
 * Issue #1617 Phase 1: Tests for control commands.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleReset, handleRestart } from './reset.js';
import type { ControlHandlerContext } from '../types.js';

function createMockContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(true) },
    node: {
      nodeId: 'node-1',
      getExecNodes: vi.fn().mockReturnValue([]),
      getDebugGroup: vi.fn().mockReturnValue(null),
      clearDebugGroup: vi.fn(),
    },
    ...overrides,
  };
}

describe('handleReset', () => {
  it('should reset agent pool for the given chatId', () => {
    const context = createMockContext();
    const result = handleReset({ type: 'reset', chatId: 'chat-123' }, context);

    expect(result.success).toBe(true);
    expect(context.agentPool.reset).toHaveBeenCalledWith('chat-123');
    expect(result.message).toContain('对话已重置');
  });
});

describe('handleRestart', () => {
  it('should reset agent pool for the given chatId', () => {
    const context = createMockContext();
    const result = handleRestart({ type: 'restart', chatId: 'chat-456' }, context);

    expect(result.success).toBe(true);
    expect(context.agentPool.reset).toHaveBeenCalledWith('chat-456');
    expect(result.message).toContain('Agent 实例已重启');
  });
});
