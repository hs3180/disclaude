/**
 * End-to-end tests for the LOOP.md-driven loop mechanism.
 *
 * These tests exercise the loop through the PRODUCTION singleton wiring — the
 * exact path the loop skill (#4040) will use: a LOOP.md file on disk →
 * `getOrCreateLoopRunner().startFromLoopMd(path)` → the runner re-reads the
 * prompt each iteration → pushes route to the registered channel's
 * `pushToAgent` (resolved via `channel.ownsChatId`).
 *
 * They complement:
 *   - `loop-runner.test.ts` — drives `LoopRunner` directly with a mock callback;
 *     does not cross the PrimaryNode ↔ channel boundary.
 *   - `primary-node.loop-wiring.test.ts` — smoke-tests the inline-prompt
 *     `loopStart` IPC circuit; does not cover the LOOP.md-driven path,
 *     multi-step push content, `maxDuration` termination, or `stop()` on a
 *     LOOP.md-driven loop.
 *
 * The loop mechanism itself (file read/parse, per-iteration re-read, real
 * `setTimeout` interval, `AbortController` stop) is exercised for real — only
 * the channel boundary (`pushToAgent`) is stubbed, matching the wiring test.
 *
 * Issue #4193 (LOOP.md spec + runner) + #4040 (loop skill entry point).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PrimaryNode } from './primary-node.js';
import type { ChannelApiHandlers, IChannel } from '@disclaude/core';

const TEST_CHAT = 'oc_loop_e2e';

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

describe('LOOP.md-driven loop end-to-end (#4193 / #4040 skill path)', () => {
  let node: TestablePrimaryNode;
  let pushToAgent: ReturnType<typeof vi.fn>;
  let tmpDir: string;
  let loopMdPath: string;

  beforeEach(() => {
    node = new TestablePrimaryNode();
    pushToAgent = vi.fn().mockResolvedValue({ success: true });
    const channel = { ownsChatId: (id: string) => id === TEST_CHAT } as unknown as IChannel;
    node.registerChannelHandlers('test', makeHandlers(pushToAgent), channel);
    tmpDir = mkdtempSync(join(tmpdir(), 'loop-e2e-'));
    loopMdPath = join(tmpDir, 'LOOP.md');
  });

  afterEach(() => {
    node.getLoopRunnerInstance()?.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Write a LOOP.md with the given prompt body and frontmatter overrides. */
  const writeLoopMd = (body: string, extra: Record<string, string | number> = {}): void => {
    const fields: Record<string, string | number> = {
      name: 'e2e',
      chatId: TEST_CHAT,
      ...extra,
    };
    const frontmatter = Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
    writeFileSync(loopMdPath, `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
  };

  it('pushes the LOOP.md prompt to the channel agent each iteration and completes', async () => {
    writeLoopMd('do the work', { maxSteps: 3, stepInterval: '5ms' });
    const runner = node.getOrCreateLoopRunner();
    const { loopId } = runner.startFromLoopMd(loopMdPath);

    // The skill path: getOrCreateLoopRunner() shares the IPC runner, and the
    // runner's pushCallback resolves the channel by chatId → pushToAgent.
    await vi.waitFor(() => {
      expect(pushToAgent).toHaveBeenCalledTimes(3);
    }, { timeout: 2000 });

    // Every push went to the LOOP.md's chatId, with the LOOP.md's prompt body.
    for (const [chatId, message] of pushToAgent.mock.calls) {
      expect(chatId).toBe(TEST_CHAT);
      expect(message).toBe('do the work');
    }

    const status = runner.status(loopId);
    expect(status?.state).toBe('completed');
    expect(status?.totalSteps).toBe(3);
    expect(status?.currentStep).toBe(3);
  });

  it('propagates a mid-run LOOP.md edit to the next channel push (re-read each iteration)', async () => {
    writeLoopMd('first', { maxSteps: 2, stepInterval: '5ms' });

    let calls = 0;
    pushToAgent.mockImplementation((_chatId: string, _message: string) => {
      calls += 1;
      if (calls === 1) {
        // An editor (or the skill) rewrites the prompt between step 1 and 2.
        // The runner re-reads LOOP.md each iteration, so step 2 must see this.
        writeLoopMd('second', { maxSteps: 2, stepInterval: '5ms' });
      }
      return Promise.resolve({ success: true });
    });

    node.getOrCreateLoopRunner().startFromLoopMd(loopMdPath);

    await vi.waitFor(() => expect(pushToAgent).toHaveBeenCalledTimes(2), { timeout: 2000 });
    const messages = pushToAgent.mock.calls.map(([, message]) => message);
    expect(messages).toEqual(['first', 'second']);
  });

  it('terminates early when maxDuration elapses before maxSteps', async () => {
    // LoopRunner clamps stepInterval/maxDuration to safety floors of 100ms /
    // 1000ms (loop-runner.ts start()/startFromLoopMd()), so a sub-floor value
    // is silently raised — use values above the floors so this arithmetic is
    // honest: 20 steps × 200ms ≈ 4000ms to exhaust, but the 1200ms duration
    // cap fires first → ≈6 pushes, then completed by duration (not by maxSteps).
    writeLoopMd('tick', { maxSteps: 20, maxDuration: '1200ms', stepInterval: '200ms' });
    const runner = node.getOrCreateLoopRunner();
    const { loopId } = runner.startFromLoopMd(loopMdPath);

    await vi.waitFor(() => {
      expect(runner.status(loopId)?.state).toBe('completed');
    }, { timeout: 2000 });

    const status = runner.status(loopId);
    // Completed by duration, NOT by exhausting all 20 steps.
    expect(status?.state).toBe('completed');
    expect(status?.totalSteps).toBe(20);
    expect(status!.currentStep).toBeGreaterThanOrEqual(1);
    expect(status!.currentStep).toBeLessThan(20);
    expect(pushToAgent.mock.calls.length).toBeLessThan(20);
  });

  it('stop() halts a LOOP.md-driven loop and bounds further channel pushes', async () => {
    writeLoopMd('run', { maxSteps: 100, stepInterval: '60ms' });
    const runner = node.getOrCreateLoopRunner();
    const { loopId } = runner.startFromLoopMd(loopMdPath);

    // Wait for the first push, then stop before the 60ms interval elapses.
    await vi.waitFor(() => expect(pushToAgent).toHaveBeenCalled(), { timeout: 1000 });
    runner.stop(loopId);

    await vi.waitFor(() => {
      expect(runner.status(loopId)?.state).toBe('stopped');
    }, { timeout: 1000 });

    const stoppedAt = pushToAgent.mock.calls.length;
    // Give the loop a window to (incorrectly) push again after stop.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pushToAgent.mock.calls.length).toBe(stoppedAt); // no further pushes
  });

  it('a LOOP.md-driven loop is visible through the IPC loopStatus/loopStop handlers', async () => {
    // The skill starts the loop via getOrCreateLoopRunner(); the shared runner
    // means it must also be queryable/controllable through the MCP↔IPC handlers.
    writeLoopMd('visible', { maxSteps: 100, stepInterval: '50ms' });
    const handlers = node.getCompositeHandlers();
    const { loopId } = node.getOrCreateLoopRunner().startFromLoopMd(loopMdPath);

    const status = await handlers.loopStatus!(loopId);
    expect(status.success).toBe(true);
    expect(status.status?.loopId).toBe(loopId);

    const stop = await handlers.loopStop!(loopId);
    expect(stop).toEqual({ success: true });

    const after = await handlers.loopStatus!(loopId);
    expect(after.success).toBe(true);
    expect(after.status?.state).toBe('stopped');
  });
});
