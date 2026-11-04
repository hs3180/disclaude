/**
 * Unit tests for status control command.
 *
 * Issue #1617 Phase 1: Tests for control commands.
 * Issue #2937: Updated after getExecNodes removal (single-node mode).
 */

import { describe, it, expect, vi } from 'vitest';
import { handleStatus } from './status.js';
import type { ControlHandlerContext } from '../types.js';

// #5607: /status appends the active provider's optional runtime-stats
// capability. The factory is an internal module (not an external SDK), so a
// vi.mock here is allowed; per-test return values keep the baseline cases
// (provider without the capability) and the codex-ledger case in one file.
const { getProviderMock } = vi.hoisted(() => ({ getProviderMock: vi.fn() }));
vi.mock('../../sdk/factory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sdk/factory.js')>();
  return { ...actual, getProvider: (...args: Parameters<typeof actual.getProvider>) => getProviderMock(...args) };
});

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
    getProviderMock.mockReturnValue({});
    const context = createMockContext();
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).toContain('运行中');
    expect(result.message).toContain('服务状态');
  });

  it('does not expose removed execution roles', async () => {
    getProviderMock.mockReturnValue({});
    const context = createMockContext();
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, context);

    expect(result.success).toBe(true);
    expect(result.message).not.toContain('节点');
  });

  it('stays at the baseline report when the provider has no stats capability', async () => {
    getProviderMock.mockReturnValue({});
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, createMockContext());
    expect(result.message).not.toContain('周额度');
  });

  it('appends labeled provider runtime stats when exposed (#5607)', async () => {
    getProviderMock.mockReturnValue({
      getStatusExtra: () => ['🪙 Codex 周额度（估计）：预算 1,000 tokens/周，剩余约 500（50%，估计）'],
    });
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, createMockContext());
    expect(result.message).toContain('服务状态');
    expect(result.message).toContain('🪙 Codex 周额度（估计）');
    expect(result.message).toContain('估计');
  });

  it('swallows provider lookup failures and still reports the service', async () => {
    getProviderMock.mockImplementation(() => {
      throw new Error('Unknown provider type');
    });
    const result = await handleStatus({ type: 'status', chatId: 'chat-1' }, createMockContext());
    expect(result.success).toBe(true);
    expect(result.message).toContain('运行中');
  });
});
