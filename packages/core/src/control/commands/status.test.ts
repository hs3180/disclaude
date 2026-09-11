/**
 * Unit tests for status control command.
 *
 * Issue #1617 Phase 1: Tests for control commands.
 * Issue #2937: Updated after getExecNodes removal (single-node mode).
 */

import { describe, it, expect, vi } from 'vitest';
import { handleStatus } from './status.js';
import type { ControlHandlerContext } from '../types.js';

function createMockContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(true) },
    debugGroups: {
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    ...overrides,
  };
}

describe('handleStatus', () => {
  it('reports the running service', async () => {
    const context = createMockContext();
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('运行中');
    expect(result.message).toContain('服务状态');
  });

  it('does not expose removed execution roles', async () => {
    const context = createMockContext();
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).not.toContain('节点');
  });
});
