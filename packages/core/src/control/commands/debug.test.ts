/**
 * Unit tests for debug control command.
 *
 * Issue #2244: Merged /show-debug + /clear-debug into single /debug toggle command.
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
      setDebugGroup: vi.fn().mockReturnValue(null),
      clearDebugGroup: vi.fn(),
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
    expect(result.message).toContain('Debug 日志群');
    expect(context.node.setDebugGroup).toHaveBeenCalledWith('chat-1');
    expect(context.node.clearDebugGroup).not.toHaveBeenCalled();
  });

  it('should clear debug group when one is already set (toggle off)', async () => {
    const debugGroup = { name: 'Test Group', setAt: Date.now() };
    const context = createMockContext({
      node: {
        nodeId: 'node-1',
        getExecNodes: vi.fn().mockReturnValue([]),
        getDebugGroup: vi.fn().mockReturnValue(debugGroup),
        setDebugGroup: vi.fn().mockReturnValue(debugGroup),
        clearDebugGroup: vi.fn(),
      },
    });
    const result = await handleDebug({ type: 'debug', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('已关闭');
    expect(context.node.clearDebugGroup).toHaveBeenCalledOnce();
    expect(context.node.setDebugGroup).not.toHaveBeenCalled();
  });
});
