/**
 * Unit tests for status control command.
 *
 * Issue #1617 Phase 1: Tests for control commands.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleStatus } from './status.js';
import type { ControlHandlerContext } from '../types.js';

function createMockContext(overrides?: Partial<ControlHandlerContext>): ControlHandlerContext {
  return {
    agentPool: { reset: vi.fn(), stop: vi.fn().mockReturnValue(true) },
    node: {
      nodeId: 'test-node-id',
      getExecNodes: vi.fn().mockReturnValue([]),
      getDebugGroup: vi.fn().mockReturnValue(null),
      setDebugGroup: vi.fn().mockReturnValue(null),
      clearDebugGroup: vi.fn(),
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

  it('should show 0 connected nodes', async () => {
    const context = createMockContext();
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('连接节点数');
    expect(result.message).toContain('无远程节点');
  });

  it('should list connected nodes', async () => {
    const nodes = [
      { nodeId: 'n1', name: 'Node A', status: 'connected' as const, activeChats: 2, isLocal: true },
      { nodeId: 'n2', name: 'Node B', status: 'connected' as const, activeChats: 0, isLocal: false },
    ];
    const context = createMockContext({
      node: {
        nodeId: 'test-node-id',
        getExecNodes: vi.fn().mockReturnValue(nodes),
        getDebugGroup: vi.fn().mockReturnValue(null),
        clearDebugGroup: vi.fn(),
      },
    });
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Node A');
    expect(result.message).toContain('Node B');
    expect(result.message).toContain('连接节点数');
  });
});
