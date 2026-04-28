/**
 * Unit tests for list-nodes control command.
 *
 * Issue #1617 Phase 1: Tests for control commands.
 * Issue #2937: Updated after getExecNodes removal (single-node mode).
 */

import { describe, it, expect, vi } from 'vitest';
import { handleListNodes } from './list-nodes.js';
import type { ControlHandlerContext } from '../types.js';

function createMockContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(true) },
    node: {
      nodeId: 'node-1',
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn(),
      clearDebugGroup: vi.fn().mockReturnValue(null),
    },
    ...overrides,
  };
}

describe('handleListNodes', () => {
  it('should return local single-node message', async () => {
    const context = createMockContext();
    const result = await handleListNodes({ type: 'list-nodes', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('本地节点');
    expect(result.message).toContain('node-1');
    expect(result.message).toContain('1 个节点');
  });
});
