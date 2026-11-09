import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@disclaude/core';
import { ServiceTurnRecoveryStore, type InterruptedServiceTurn } from './service-turn-recovery.js';
import {
  INTERRUPTED_TURN_RESUME_PROMPT,
  RESUME_TRIGGER_MESSAGE_ID_PREFIX,
  resumeInterruptedInteractiveTurns,
  selectAutoResumableTurns,
} from './service-turn-resume.js';

const logger = createLogger('ServiceTurnResumeTest');

function interruptedTurn(overrides: Partial<InterruptedServiceTurn> = {}): InterruptedServiceTurn {
  return { ...baseInterruptedTurn(), ...overrides };
}

function baseInterruptedTurn() {
  return {
    chatId: 'chat-1',
    sessionKey: 'chat-1::thread-1',
    traceId: 'chat-1:om_1',
    runId: 'run-1',
    sourceMessageId: 'om_real_1',
    threadRootId: 'thread-1',
    startedAt: 100,
    origin: 'interactive' as const,
    diagnosticId: 'diag-1',
    state: 'interrupted_by_service_restart' as const,
    interruptionCause: 'service_restart' as const,
    interruptedAt: 200,
  };
}

describe('selectAutoResumableTurns (#5733)', () => {
  it('keeps only interactive-origin unresumed turns, newest per chat', () => {
    const selected = selectAutoResumableTurns([
      interruptedTurn({ runId: 'sched-run', sourceMessageId: 'sched-task-1', origin: 'scheduled' }),
      // Synthetic-but-interactive ids (push/auto nudge) share the interactive outcome:
      // their interruption notice already targets the chat channel.
      interruptedTurn({ runId: 'push-run', sourceMessageId: 'push_api_1', chatId: 'chat-9', startedAt: 10 }),
      interruptedTurn({ runId: 'resumed-run', autoResume: { attemptedAt: 300, resumeMessageId: 'x' } }),
      interruptedTurn({ runId: 'older-run', startedAt: 50 }),
      interruptedTurn({ runId: 'newest-run', startedAt: 150 }),
      interruptedTurn({ runId: 'other-chat', chatId: 'chat-2', startedAt: 10 }),
    ]);
    expect(selected.map(turn => turn.runId)).toEqual(['push-run', 'other-chat', 'newest-run']);
  });
});

describe('resumeInterruptedInteractiveTurns (#5733)', () => {
  function withStore(run: (store: ServiceTurnRecoveryStore) => void | Promise<void>): void {
    const directory = mkdtempSync(path.join(tmpdir(), 'disclaude-turn-resume-'));
    try {
      const store = new ServiceTurnRecoveryStore(path.join(directory, 'turns.json'));
      store.initialize(100);
      void run(store);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it('injects exactly one resume trigger per interrupted interactive turn, after a durable claim', async () => {
    await withStore(async store => {
      store.startTurn({ chatId: 'chat-1', sessionKey: 'chat-1', traceId: 'chat-1:om_1',
        runId: 'abcd1234abcd', sourceMessageId: 'om_real_1', startedAt: 100,
        origin: 'interactive', diagnosticId: 'diag-1' });
      store.interruptSession('chat-1', 200);
      const inject = vi.fn().mockResolvedValue(undefined);
      await resumeInterruptedInteractiveTurns({
        store,
        resolveChannel: () => ({ id: 'feishu' }),
        inject,
        logger,
      });
      expect(inject).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ runId: 'abcd1234abcd' }),
        `${RESUME_TRIGGER_MESSAGE_ID_PREFIX}abcd1234`
      );
      // Durable claim blocks a second pass (e.g. another startup raced in).
      const again = vi.fn();
      await resumeInterruptedInteractiveTurns({
        store, resolveChannel: () => ({ id: 'feishu' }), inject: again, logger,
      });
      expect(again).not.toHaveBeenCalled();
      expect(store.getInterruptedTurns()[0].autoResume?.resumeMessageId)
        .toBe(`${RESUME_TRIGGER_MESSAGE_ID_PREFIX}abcd1234`);
      expect(INTERRUPTED_TURN_RESUME_PROMPT).toContain('不要重复已完成的操作');
    });
  });

  it('skips scheduled turns and chats without an owning channel; resumes push-origin interactive turns', async () => {
    await withStore(async store => {
      store.startTurn({ chatId: 'chat-1', sessionKey: 'chat-1', traceId: 't1', runId: 'run-sched',
        sourceMessageId: 'sched-task-1', startedAt: 100, origin: 'scheduled', diagnosticId: 'd1' });
      store.startTurn({ chatId: 'chat-2', sessionKey: 'chat-2', traceId: 't2', runId: 'run-push',
        sourceMessageId: 'push_api_1', startedAt: 110, origin: 'interactive', diagnosticId: 'd2' });
      store.startTurn({ chatId: 'chat-3', sessionKey: 'chat-3', traceId: 't3', runId: 'run-real',
        sourceMessageId: 'om_real_1', startedAt: 120, origin: 'interactive', diagnosticId: 'd3' });
      store.startTurn({ chatId: 'chat-4', sessionKey: 'chat-4', traceId: 't4', runId: 'run-nochannel',
        sourceMessageId: 'om_real_2', startedAt: 130, origin: 'interactive', diagnosticId: 'd4' });
      store.interruptSession('chat-1', 200);
      store.interruptSession('chat-2', 200);
      store.interruptSession('chat-3', 200);
      store.interruptSession('chat-4', 200);
      const inject = vi.fn().mockResolvedValue(undefined);
      const resolveChannel = vi.fn((chatId: string) =>
        chatId === 'chat-4' ? undefined : { id: 'feishu' });
      await resumeInterruptedInteractiveTurns({ store, resolveChannel, inject, logger });
      expect(inject.mock.calls.map(([turn]) => turn.runId)).toEqual(['run-push', 'run-real']);
      expect(store.getInterruptedTurns().find(turn => turn.runId === 'run-real')?.autoResume).toBeDefined();
      // Scheduled: the scheduler owns recovery — never claimed.
      expect(store.getInterruptedTurns().find(turn => turn.runId === 'run-sched')?.autoResume).toBeUndefined();
      // No owning channel: notice-only outcome, claim not burned.
      expect(store.getInterruptedTurns().find(turn => turn.runId === 'run-nochannel')?.autoResume).toBeUndefined();
    });
  });

  it('keeps startup running when an injection throws', async () => {
    await withStore(async store => {
      store.startTurn({ chatId: 'chat-1', sessionKey: 'chat-1', traceId: 't1', runId: 'run-fail',
        sourceMessageId: 'om_real_1', startedAt: 100, origin: 'interactive', diagnosticId: 'd1' });
      store.interruptSession('chat-1', 200);
      const inject = vi.fn().mockRejectedValue(new Error('agent pool rejected'));
      await expect(resumeInterruptedInteractiveTurns({
        store, resolveChannel: () => ({ id: 'feishu' }), inject, logger,
      })).resolves.toBeUndefined();
    });
  });
});
