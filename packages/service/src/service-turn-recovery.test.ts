import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ServiceTurnRecoveryStore } from './service-turn-recovery.js';

function withJournal(run: (filePath: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), 'disclaude-turn-recovery-'));
  try {
    run(path.join(directory, 'turns.json'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const turn = {
  chatId: 'chat-1',
  sessionKey: 'chat-1::thread-1',
  traceId: 'chat-1:source-1',
  runId: 'run-1',
  sourceMessageId: 'source-1',
  threadRootId: 'thread-1',
  startedAt: 100,
};

async function withAsyncJournal(run: (store: ServiceTurnRecoveryStore, filePath: string) => Promise<void>): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), 'disclaude-turn-recovery-'));
  const filePath = path.join(directory, 'turns.json');
  try {
    const store = new ServiceTurnRecoveryStore(filePath);
    store.initialize(100);
    store.startTurn(turn);
    store.interruptSession(turn.sessionKey, 200);
    await run(store, filePath);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('ServiceTurnRecoveryStore (#5273)', () => {
  it('persists unfinished work as an interruption on startup and keeps notice state until delivery', () => {
    withJournal((filePath) => {
      const firstProcess = new ServiceTurnRecoveryStore(filePath);
      firstProcess.initialize(100);
      firstProcess.startTurn(turn);

      const nextProcess = new ServiceTurnRecoveryStore(filePath);
      const recovered = nextProcess.initialize(200);

      expect(recovered).toEqual([
        expect.objectContaining({
          ...turn,
          state: 'interrupted_by_service_restart',
          interruptionCause: 'service_restart',
          interruptedAt: 200,
        }),
      ]);
      expect(nextProcess.getPendingNotifications(turn.sessionKey)).toHaveLength(1);

      nextProcess.markNotificationsDelivered([turn.runId], 300);
      const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
      expect(persisted.turns[0]).toMatchObject({
        runId: turn.runId,
        state: 'interrupted_by_service_restart',
        noticeDeliveredAt: 300,
      });
      expect(nextProcess.getPendingNotifications(turn.sessionKey)).toEqual([]);
    });
  });

  it('does not recover a normally completed turn or interrupt another session', () => {
    withJournal((filePath) => {
      const store = new ServiceTurnRecoveryStore(filePath);
      store.initialize(100);
      store.startTurn(turn);
      store.startTurn({
        ...turn,
        runId: 'run-other',
        sessionKey: 'chat-1::other-thread',
        sourceMessageId: 'source-other',
      });
      store.completeTurn(turn.runId);
      expect(store.interruptSession(turn.sessionKey, 200)).toEqual([]);

      const nextProcess = new ServiceTurnRecoveryStore(filePath);
      expect(nextProcess.initialize(300)).toEqual([
        expect.objectContaining({
          runId: 'run-other',
          state: 'interrupted_by_service_restart',
        }),
      ]);
      expect(nextProcess.getPendingNotifications(turn.sessionKey)).toEqual([]);
      expect(nextProcess.getPendingNotifications('chat-1::other-thread')).toHaveLength(1);
    });
  });

  it('refuses to overwrite a malformed journal', () => {
    withJournal((filePath) => {
      writeFileSync(filePath, '{broken', 'utf8');
      const store = new ServiceTurnRecoveryStore(filePath);
      expect(() => store.initialize()).toThrow();
      expect(readFileSync(filePath, 'utf8')).toBe('{broken');
    });
  });

  it('keeps an in-flight notice claimed across timeout and acknowledges late success durably', async () => {
    await withAsyncJournal(async (store, filePath) => {
      let delivered!: (messageId: string) => void;
      const receipt = new Promise<string>(resolve => { delivered = resolve; });
      const send = vi.fn(() => receipt);
      await store.deliverPendingNotifications(send, { timeoutMs: 1 });
      await store.deliverPendingNotifications(send, { timeoutMs: 1 });
      expect(send).toHaveBeenCalledExactlyOnceWith(turn.chatId,
        expect.stringContaining(turn.sourceMessageId), turn.threadRootId);
      expect(store.getPendingNotifications()).toHaveLength(1);
      delivered('late-message-receipt');
      await vi.waitFor(() => expect(store.getPendingNotifications()).toEqual([]));
      const restarted = new ServiceTurnRecoveryStore(filePath);
      restarted.initialize();
      await restarted.deliverPendingNotifications(send);
      expect(send).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(filePath, 'utf8')).turns[0].noticeMessageId).toBe('late-message-receipt');
    });
  });

  it('retains failed delivery for the next path and keeps each original thread separate', async () => {
    await withAsyncJournal(async store => {
      const fail = vi.fn().mockRejectedValue(new Error('Channel unavailable'));
      await store.deliverPendingNotifications(fail);
      expect(store.getPendingNotifications()).toHaveLength(1);
      store.startTurn({ ...turn, runId: 'second-run', sourceMessageId: 'second-source',
        threadRootId: 'second-thread', sessionKey: 'second-session' });
      store.interruptSession('second-session', 300);
      const send = vi.fn().mockResolvedValue('message-receipt');
      await store.deliverPendingNotifications(send);
      expect(send.mock.calls.map(([chatId, , threadRoot]) => [chatId, threadRoot])).toEqual([
        [turn.chatId, turn.threadRootId], [turn.chatId, 'second-thread'],
      ]);
      expect(store.getPendingNotifications()).toEqual([]);
    });
  });

  it('does not claim delivery when a channel only queues or silently drops a notice', async () => {
    await withAsyncJournal(async store => {
      await store.deliverPendingNotifications(vi.fn().mockResolvedValue(undefined));
      expect(store.getPendingNotifications()).toHaveLength(1);
      await store.deliverPendingNotifications(vi.fn().mockResolvedValue('visible-notice-id'));
      expect(store.getPendingNotifications()).toEqual([]);
    });
  });

  it('persists retention pruning and rejects duplicate journal identities without overwriting', () => {
    withJournal(filePath => {
      const store = new ServiceTurnRecoveryStore(filePath);
      store.initialize(100);
      store.startTurn(turn);
      store.interruptSession(turn.sessionKey, 200);
      store.markNotificationsDelivered([turn.runId], 300);
      new ServiceTurnRecoveryStore(filePath).initialize(300 + 91 * 24 * 60 * 60 * 1_000);
      expect(JSON.parse(readFileSync(filePath, 'utf8')).turns).toEqual([]);
      const duplicate = JSON.stringify({ version: 1, turns: [
        { ...turn, state: 'active' }, { ...turn, state: 'active' },
      ] });
      writeFileSync(filePath, duplicate);
      expect(() => new ServiceTurnRecoveryStore(filePath).initialize()).toThrow('Duplicate runId');
      expect(readFileSync(filePath, 'utf8')).toBe(duplicate);
    });
  });
});
