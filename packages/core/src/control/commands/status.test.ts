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
    node: {
      nodeId: 'test-node-id',
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    ...overrides,
  };
}

describe('handleStatus', () => {
  it('should return status with node ID', async () => {
    const context = createMockContext();
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('test-node-id');
    expect(result.message).toContain('服务状态');
  });

  it('should show local single-node mode', async () => {
    const context = createMockContext();
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('本地单节点模式');
  });
});
