import { describe, expect, it, vi } from 'vitest';
import { MAX_WAITING_LLM_SESSIONS, withLlmSessionLimit } from './llm-session-limit.js';
import type { AgentMessage, StreamQueryResult } from './types.js';

function query(iterator?: AsyncGenerator<AgentMessage>): StreamQueryResult {
  return {
    handle: {
      close: vi.fn(),
      cancel: vi.fn(),
      sessionId: 'native-session',
      inputDelivery: 'streaming',
      steer: vi.fn(() => Promise.resolve({ turnId: 'native-turn' })),
    },
    iterator:
      iterator ??
      (async function* () {
        yield { type: 'text', role: 'assistant', content: 'ok' } as AgentMessage;
      })(),
  };
}

describe('LLM session admission', () => {
  it('shares one budget across agents and lets other named LLMs progress', () => {
    const limit = { name: 'shared', maxConcurrentSessions: 1 };
    const first = withLlmSessionLimit(() => query(), limit);
    const blockedStart = vi.fn(() => query());
    const waiting = withLlmSessionLimit(blockedStart, limit);
    try {
      expect(blockedStart).not.toHaveBeenCalled();
      expect(waiting.handle.capacityQueued).toBe(true);
      expect(waiting.handle.inputDelivery).toBe('queued');
      expect(waiting.handle.steer).toBeUndefined();
      const independent = withLlmSessionLimit(() => query(), { ...limit, name: 'independent' });
      independent.handle.close();
      expect(first.handle.sessionId).toBe('native-session');
      expect(first.handle.inputDelivery).toBe('streaming');
    } finally {
      first.handle.close();
    }
    expect(blockedStart).toHaveBeenCalledTimes(1);
    expect(waiting.handle.capacityQueued).toBe(false);
    expect(waiting.handle.inputDelivery).toBe('streaming');
    waiting.handle.close();
    const replacement = withLlmSessionLimit(() => query(), limit);
    replacement.handle.close();
  });
  it('releases on completion, provider errors, cancel and an unstarted iterator return', async () => {
    const limit = { name: 'lifecycle', maxConcurrentSessions: 1 };
    expect(() =>
      withLlmSessionLimit(() => {
        throw new Error('startup failure');
      }, limit)
    ).toThrow('startup failure');
    const failing = withLlmSessionLimit(
      () =>
        query(
          (async function* () {
            throw new Error('stream failure');
          })()
        ),
      limit
    );
    await expect(failing.iterator.next()).rejects.toThrow('stream failure');
    const completed = withLlmSessionLimit(() => query(), limit);
    await completed.iterator.next();
    expect((await completed.iterator.next()).done).toBe(true);
    const canceled = withLlmSessionLimit(() => query(), limit);
    await expect(canceled.handle.steer!('next')).resolves.toEqual({ turnId: 'native-turn' });
    canceled.handle.cancel();
    canceled.handle.close();
    const unstarted = withLlmSessionLimit(() => query(), limit);
    await unstarted.iterator.return(undefined);
    const final = withLlmSessionLimit(() => query(), limit);
    final.handle.close();
  });
  it('keeps a reservation across intermediate turn results until the session ends', async () => {
    const limit = { name: 'conversation', maxConcurrentSessions: 1 };
    const conversation = withLlmSessionLimit(
      () =>
        query(
          (async function* () {
            yield { type: 'result', role: 'assistant', content: 'turn complete' } as AgentMessage;
            yield { type: 'text', role: 'assistant', content: 'follow-up' } as AgentMessage;
          })()
        ),
      limit
    );
    const blockedStart = vi.fn(() => query());
    let waiting: StreamQueryResult | undefined;
    try {
      expect((await conversation.iterator.next()).value?.type).toBe('result');
      waiting = withLlmSessionLimit(blockedStart, limit);
      expect(waiting.handle.capacityQueued).toBe(true);
      expect(blockedStart).not.toHaveBeenCalled();
      expect((await conversation.iterator.next()).value?.content).toBe('follow-up');
    } finally {
      await conversation.iterator.return(undefined);
      waiting?.handle.close();
    }
  });

  it('admits retained inputs once in FIFO order when leases are released', async () => {
    const limit = { name: 'fifo', maxConcurrentSessions: 1 };
    const first = withLlmSessionLimit(() => query(), limit);
    const starts: number[] = [];
    const queued = [1, 2, 3].map(id => withLlmSessionLimit(() => {
      starts.push(id);
      return query();
    }, limit));
    try {
      expect(starts).toEqual([]);
      const next = queued[0].iterator.next();
      first.handle.close();
      await expect(next).resolves.toMatchObject({ done: false, value: { content: 'ok' } });
      expect(starts).toEqual([1]);
      await queued[0].iterator.next(); // Actual stream completion frees the lease.
      expect(starts).toEqual([1, 2]);
      queued[1].handle.cancel();
      queued[1].handle.close();
      expect(starts).toEqual([1, 2, 3]);
    } finally { first.handle.close(); queued.forEach(q => q.handle.close()); }
  });

  it.each(['close', 'cancel', 'return', 'throw'] as const)(
    'removes a waiting reservation and wakes its reader on %s without starting it', async method => {
      const limit = { name: `cancel-${method}`, maxConcurrentSessions: 1 };
      const first = withLlmSessionLimit(() => query(), limit);
      const start = vi.fn(() => query());
      const canceled = withLlmSessionLimit(start, limit);
      const followingStart = vi.fn(() => query());
      const following = withLlmSessionLimit(followingStart, limit);
      try {
        const blockedRead = canceled.iterator.next();
        if (method === 'return') { await canceled.iterator.return(undefined); }
        else if (method === 'throw') { await expect(canceled.iterator.throw(new Error('stop'))).rejects.toThrow('stop'); }
        else { canceled.handle[method](); }
        await expect(blockedRead).resolves.toMatchObject({ done: true });
        first.handle.close();
        expect(start).not.toHaveBeenCalled();
        expect(followingStart).toHaveBeenCalledTimes(1);
      } finally { first.handle.close(); canceled.handle.close(); following.handle.close(); }
    }
  );

  it('bounds the queue, rejects overflow before acceptance, and reuses canceled capacity', () => {
    const limit = { name: 'bounded', maxConcurrentSessions: 1 };
    const first = withLlmSessionLimit(() => query(), limit);
    const waiting = Array.from({ length: MAX_WAITING_LLM_SESSIONS }, () =>
      withLlmSessionLimit(() => query(), limit));
    const overflow = vi.fn(() => query());
    try {
      expect(() => withLlmSessionLimit(overflow, limit)).toThrow('这条消息未被接收');
      expect(overflow).not.toHaveBeenCalled();
      waiting[0].handle.cancel();
      const replacement = withLlmSessionLimit(overflow, limit);
      expect(replacement.handle.capacityQueued).toBe(true);
      replacement.handle.close();
    } finally { waiting.forEach(q => q.handle.close()); first.handle.close(); }
  });

  it('propagates a queued provider failure without retry and continues the next waiter', async () => {
    const limit = { name: 'queued-error', maxConcurrentSessions: 1 };
    const first = withLlmSessionLimit(() => query(), limit);
    const start = vi.fn(() => { throw new Error('authentication failed'); });
    const failing = withLlmSessionLimit(start, limit);
    const nextStart = vi.fn(() => query());
    const next = withLlmSessionLimit(nextStart, limit);
    try {
      first.handle.close();
      await expect(failing.iterator.next()).rejects.toThrow('authentication failed');
      expect(start).toHaveBeenCalledTimes(1);
      expect(nextStart).toHaveBeenCalledTimes(1);
      expect(next.handle.capacityQueued).toBe(false);
    } finally { first.handle.close(); failing.handle.close(); next.handle.close(); }
  });

  it('rejects known configuration/auth failures before retaining a capacity waiter', () => {
    const limit = { name: 'invalid-credentials', maxConcurrentSessions: 1 };
    const first = withLlmSessionLimit(() => query(), limit);
    const start = vi.fn(() => query());
    const preflight = vi.fn(() => { throw new Error('Codex auth missing'); });
    try {
      expect(() => withLlmSessionLimit(start, limit, preflight)).toThrow('Codex auth missing');
      expect(preflight).toHaveBeenCalledTimes(1);
      expect(start).not.toHaveBeenCalled();
      first.handle.close();
      expect(start).not.toHaveBeenCalled();
    } finally { first.handle.close(); }
  });
});
