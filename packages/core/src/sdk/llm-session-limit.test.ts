import { describe, expect, it, vi } from 'vitest';
import { withLlmSessionLimit } from './llm-session-limit.js';
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
    try {
      expect(() => withLlmSessionLimit(blockedStart, limit)).toThrow('1/1');
      expect(blockedStart).not.toHaveBeenCalled();
      const independent = withLlmSessionLimit(() => query(), { ...limit, name: 'independent' });
      independent.handle.close();
      expect(first.handle.sessionId).toBe('native-session');
      expect(first.handle.inputDelivery).toBe('streaming');
    } finally {
      first.handle.close();
    }
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
    try {
      expect((await conversation.iterator.next()).value?.type).toBe('result');
      expect(() => withLlmSessionLimit(() => query(), limit)).toThrow('并发会话已满');
      expect((await conversation.iterator.next()).value?.content).toBe('follow-up');
    } finally {
      await conversation.iterator.return(undefined);
    }
  });
});
