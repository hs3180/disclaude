import type { AgentQueryOptions, StreamQueryResult } from './types.js';

/** Process-wide reservations; multiple agents/backends can share one named LLM. */
const activeSessions = new Map<string, number>();

export class LlmSessionLimitError extends Error {
  readonly code = 'LLM_SESSION_LIMIT';
}

export function withLlmSessionLimit(
  start: () => StreamQueryResult,
  limit: AgentQueryOptions['llmSessionLimit']
): StreamQueryResult {
  if (!limit) {
    return start();
  }
  const { name, maxConcurrentSessions } = limit;
  if (!name || !Number.isSafeInteger(maxConcurrentSessions) || maxConcurrentSessions <= 0) {
    throw new Error('Invalid LLM session limit');
  }
  const active = activeSessions.get(name) ?? 0;
  if (active >= maxConcurrentSessions) {
    throw new LlmSessionLimitError(
      `LLM ${name} 的并发会话已满（${active}/${maxConcurrentSessions}）；请结束一个会话后重试。`
    );
  }
  activeSessions.set(name, active + 1);
  let released = false;
  const release = (): void => {
    if (released) {
      return;
    }
    released = true;
    const remaining = (activeSessions.get(name) ?? 1) - 1;
    if (remaining) {
      activeSessions.set(name, remaining);
    } else {
      activeSessions.delete(name);
    }
  };
  let result: StreamQueryResult;
  try {
    result = start();
  } catch (error) {
    release();
    throw error;
  }
  const stop = (): void => {
    try {
      result.handle.close();
    } finally {
      release();
    }
  };
  const iterator: StreamQueryResult['iterator'] = {
    async next(...args) {
      if (released) {
        return { done: true, value: undefined };
      }
      try {
        const value = await result.iterator.next(...args);
        if (value.done) {
          stop();
        }
        return value;
      } catch (error) {
        stop();
        throw error;
      }
    },
    return(value) {
      stop();
      return result.iterator.return(value);
    },
    async throw(error) {
      try {
        return await result.iterator.throw(error);
      } finally {
        stop();
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return {
    handle: new Proxy(result.handle, {
      get(target, key) {
        if (key === 'close' || key === 'cancel') {
          return () => {
            try {
              target[key]();
            } finally {
              release();
            }
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
    iterator,
  };
}
