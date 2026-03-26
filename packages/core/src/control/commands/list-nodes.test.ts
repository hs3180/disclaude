/**
 * Unit tests for list-nodes control command.
 *
 * Issue #1617 Phase 1: Tests for control commands.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleListNodes } from './list-nodes.js';
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

describe('handleListNodes', () => {
  it('should return message when no nodes connected', async () => {
    const context = createMockContext();
    const result = await handleListNodes({ type: 'list-nodes', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('无已连接的远程节点');
  });

  it('should list connected nodes', async () => {
    const nodes = [
      { nodeId: 'node-1', name: 'Local Node', status: 'connected' as const, activeChats: 3, isLocal: true },
      { nodeId: 'node-2', name: 'Remote Node', status: 'connected' as const, activeChats: 1, isLocal: false },
    ];
    const context = createMockContext({
      node: {
        nodeId: 'node-1',
        getExecNodes: vi.fn().mockReturnValue(nodes),
        getDebugGroup: vi.fn().mockReturnValue(null),
        clearDebugGroup: vi.fn(),
      },
    });
    const result = await handleListNodes({ type: 'list-nodes', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Local Node');
    expect(result.message).toContain('Remote Node');
    expect(result.message).toContain('2 个节点');
  });
});
