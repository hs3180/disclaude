/**
 * Unit tests for debug control commands.
 *
 * Issue #1617 Phase 1: Tests for control commands.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleShowDebug, handleClearDebug } from './debug.js';
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
    logger: undefined,
    ...overrides,
  };
}

describe('handleShowDebug', () => {
  it('should return message when no debug group is set', async () => {
    const context = createMockContext();
    const result = await handleShowDebug({ type: 'show-debug', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('没有设置 Debug 组');
  });

  it('should return debug group info when set', async () => {
    const debugGroup = { name: 'Test Group', setAt: Date.now() };
    const context = createMockContext({
      node: {
        nodeId: 'node-1',
        getExecNodes: vi.fn().mockReturnValue([]),
        getDebugGroup: vi.fn().mockReturnValue(debugGroup),
        clearDebugGroup: vi.fn(),
      },
    });
    const result = await handleShowDebug({ type: 'show-debug', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Test Group');
  });
});

describe('handleClearDebug', () => {
  it('should clear debug group and return success', async () => {
    const context = createMockContext();
    const result = await handleClearDebug({ type: 'clear-debug', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(context.node.clearDebugGroup).toHaveBeenCalledOnce();
    expect(result.message).toContain('已清除');
  });
});
