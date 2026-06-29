/**
 * Tests for the LoopRunner IPC wiring inside createCompositeHandlersContainer().
 *
 * Issue #4075 (part 1): verifies that the composite handlers exposed by PrimaryNode
 * lazily build a LoopRunner on first loopStart and route its pushes to the
 * registered channel's pushToAgent — the MCP -> IPC -> LoopRunner circuit.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrimaryNode } from './primary-node.js';
import type { ChannelApiHandlers, IChannel } from '@disclaude/core';

const TEST_CHAT = 'oc_loop_test';

/** Subclass to reach the protected composite-container factory and loopRunner. */
class TestablePrimaryNode extends PrimaryNode {
  getCompositeHandlers(): ChannelApiHandlers {
    return this.createCompositeHandlersContainer().handlers!;
  }
  getLoopRunnerInstance() {
    return this.loopRunner;
  }
}

/** Minimal ChannelApiHandlers stub with only the optional pushToAgent implemented. */
function makeHandlers(pushToAgent: ReturnType<typeof vi.fn>): ChannelApiHandlers {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    uploadFile: vi.fn().mockResolvedValue({ fileKey: 'k', fileType: 'f', fileName: 'n', fileSize: 0 }),
    sendInteractive: vi.fn().mockResolvedValue({ messageId: 'm' }),
    pushToAgent,
  } as unknown as ChannelApiHandlers;
}

describe('PrimaryNode composite loop handlers (Issue #4075 wiring)', () => {
  let node: TestablePrimaryNode;
  let pushToAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    node = new TestablePrimaryNode();
    pushToAgent = vi.fn().mockResolvedValue({ success: true });
    const channel = { ownsChatId: (id: string) => id === TEST_CHAT } as unknown as IChannel;
    node.registerChannelHandlers('test', makeHandlers(pushToAgent), channel);
  });

  afterEach(() => {
    node.getLoopRunnerInstance()?.dispose();
  });

  it('lazily initializes LoopRunner on first loopStart and pushes to the channel agent', async () => {
    const handlers = node.getCompositeHandlers();
    expect(node.getLoopRunnerInstance()).toBeUndefined();

    const res = await handlers.loopStart!({ chatId: TEST_CHAT, prompt: 'keep going', maxSteps: 1 });

    expect(res.success).toBe(true);
    expect(res.loopId).toMatch(/^loop-/);
    expect(node.getLoopRunnerInstance()).toBeDefined();

    await vi.waitFor(() => {
      expect(pushToAgent).toHaveBeenCalledWith(TEST_CHAT, 'keep going');
    }, { timeout: 2000 });
  });

  it('reports "No loops have been started" before any loopStart', async () => {
    const handlers = node.getCompositeHandlers();
    await expect(handlers.loopStop!('loop-1')).resolves.toEqual({ success: false, error: 'No loops have been started' });
    await expect(handlers.loopStatus!('loop-1')).resolves.toEqual({ success: false, error: 'No loops have been started' });
  });

  it('loopStop returns "Loop not found" for an unknown loopId, matching loopStatus', async () => {
    const handlers = node.getCompositeHandlers();
    // Prime the LoopRunner with a real loop so loopRunner is initialized.
    await handlers.loopStart!({ chatId: TEST_CHAT, prompt: 'p', maxSteps: 1 });

    await expect(handlers.loopStop!('loop-does-not-exist')).resolves.toEqual({ success: false, error: 'Loop not found' });
    await expect(handlers.loopStatus!('loop-does-not-exist')).resolves.toEqual({ success: false, error: 'Loop not found' });
  });

  it('loopStatus reports the loop and loopStop stops a running loop', async () => {
    const handlers = node.getCompositeHandlers();
    const start = await handlers.loopStart!({ chatId: TEST_CHAT, prompt: 'p', maxSteps: 100, stepIntervalMs: 50 });
    const loopId = start.loopId!;

    const status = await handlers.loopStatus!(loopId);
    expect(status.success).toBe(true);
    expect(status.status?.loopId).toBe(loopId);
    expect(status.status?.state).toBe('running');

    const stop = await handlers.loopStop!(loopId);
    expect(stop).toEqual({ success: true });

    const after = await handlers.loopStatus!(loopId);
    expect(after.status?.state).toBe('stopped');
  });
});
