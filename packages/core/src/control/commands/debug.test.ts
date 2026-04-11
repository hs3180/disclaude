/**
 * Unit tests for /debug toggle command.
 *
 * Issue #2244: Merged /show-debug and /clear-debug into single /debug toggle.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleDebug } from './debug.js';
import type { ControlHandlerContext } from '../types.js';

function createMockContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(true) },
    node: {
      nodeId: 'node-1',
      getExecNodes: vi.fn().mockReturnValue([]),
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    logger: undefined,
    ...overrides,
  };
}

describe('handleDebug', () => {
  it('should set debug group when none is set', async () => {
    const context = createMockContext();
    const result = await handleDebug({ type: 'debug', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Debug 群已设置');
    expect(context.node.setDebugGroup).toHaveBeenCalledWith('chat-1');
    expect(context.node.clearDebugGroup).not.toHaveBeenCalled();
  });

  it('should clear debug group when same chat toggles off', async () => {
    const previousGroup = { chatId: 'chat-1', name: 'Test Group', setAt: Date.now() };
    const mockClearDebugGroup = vi.fn().mockReturnValue(previousGroup);
    const context = createMockContext({
      node: {
        nodeId: 'node-1',
        getExecNodes: vi.fn().mockReturnValue([]),
        getDebugGroup: vi.fn().mockReturnValue(previousGroup),
        setDebugGroup: vi.fn(),
        clearDebugGroup: mockClearDebugGroup,
      },
    });

    const result = await handleDebug({ type: 'debug', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('已取消设置');
    expect(mockClearDebugGroup).toHaveBeenCalledOnce();
    expect(context.node.setDebugGroup).not.toHaveBeenCalled();
  });

  it('should switch debug group when a different chat sets it', async () => {
    const existingGroup = { chatId: 'chat-other', name: 'Other Group', setAt: Date.now() };
    const mockClearDebugGroup = vi.fn().mockReturnValue(existingGroup);
    const context = createMockContext({
      node: {
        nodeId: 'node-1',
        getExecNodes: vi.fn().mockReturnValue([]),
        getDebugGroup: vi.fn().mockReturnValue(existingGroup),
        setDebugGroup: vi.fn(),
        clearDebugGroup: mockClearDebugGroup,
      },
    });

    const result = await handleDebug({ type: 'debug', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('切换到当前群');
    expect(mockClearDebugGroup).toHaveBeenCalledOnce();
    expect(context.node.setDebugGroup).toHaveBeenCalledWith('chat-1');
  });
});
