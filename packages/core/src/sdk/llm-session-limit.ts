import type { AgentQueryOptions, QueryHandle, StreamQueryResult } from './types.js';

/** Bound retained inputs while a named LLM's native sessions are occupied. */
export const MAX_WAITING_LLM_SESSIONS = 64;
interface Waiter { max: number; admit(): void }
interface Budget { active: number; waiters: Waiter[]; draining: boolean }
const budgets = new Map<string, Budget>();

export class LlmSessionLimitError extends Error {
  readonly code = 'LLM_SESSION_LIMIT';
}

export function withLlmSessionLimit(
  start: () => StreamQueryResult,
  limit: AgentQueryOptions['llmSessionLimit'],
  preflight?: () => void
): StreamQueryResult {
  if (!limit) { return start(); }
  const { name, maxConcurrentSessions } = limit;
  if (!name || !Number.isSafeInteger(maxConcurrentSessions) || maxConcurrentSessions <= 0) {
    throw new Error('Invalid LLM session limit');
  }
  const budget = budgets.get(name) ?? { active: 0, waiters: [], draining: false };
  const mustWait = budget.waiters.length > 0 || budget.active >= maxConcurrentSessions;
  // Known auth/configuration failures must not receive an accepted queue notice.
  if (mustWait) { preflight?.(); }
  budgets.set(name, budget);
  if (mustWait && budget.waiters.length >= MAX_WAITING_LLM_SESSIONS) {
    throw new LlmSessionLimitError(
      `LLM ${name} 的等待队列已满（${MAX_WAITING_LLM_SESSIONS}）；这条消息未被接收，请结束一个会话后重新发送。`
    );
  }
  let result: StreamQueryResult | undefined;
  let waiter: Waiter | undefined;
  let closed = false, reserved = false, failure: unknown, failed = false;
  let wake!: () => void;
  const ready = new Promise<void>(resolve => { wake = resolve; });

  const drain = (): void => {
    // A queued provider may throw synchronously; its release must not recurse.
    if (budget.draining) { return; }
    budget.draining = true;
    try {
      while (budget.waiters.length && budget.active < budget.waiters[0].max) {
        const next = budget.waiters.shift();
        if (next) { next.admit(); }
      }
    } finally {
      budget.draining = false;
      if (!budget.active && !budget.waiters.length) { budgets.delete(name); }
    }
  };
  const release = (): void => {
    if (!reserved) { return; }
    reserved = false;
    budget.active--;
    drain();
  };
  const admit = (): void => {
    waiter = undefined;
    if (closed) { wake(); return; }
    reserved = true;
    budget.active++;
    try { result = start(); }
    catch (error) { failed = true; failure = error; release(); }
    finally { wake(); }
  };
  if (mustWait) {
    waiter = { max: maxConcurrentSessions, admit };
    budget.waiters.push(waiter);
    drain();
  } else {
    admit();
    // Preserve immediate configuration/start failures; never retry them as capacity.
    if (failed) { throw failure; }
  }
  const stop = (method: 'close' | 'cancel' = 'close'): void => {
    if (closed) { return; }
    closed = true;
    if (waiter) {
      const index = budget.waiters.indexOf(waiter);
      if (index >= 0) { budget.waiters.splice(index, 1); }
      waiter = undefined;
      wake();
      drain();
    }
    try { result?.handle[method](); }
    finally { release(); }
  };
  const iterator: StreamQueryResult['iterator'] = {
    async next(...args) {
      await ready;
      if (closed) { return { done: true, value: undefined }; }
      if (failed) { closed = true; throw failure; }
      try {
        if (!result) { throw new Error('LLM query did not start'); }
        const value = await result.iterator.next(...args);
        if (value.done) { stop(); }
        return value;
      } catch (error) { stop(); throw error; }
    },
    return(value) {
      stop();
      return result?.iterator.return(value) ?? Promise.resolve({ done: true, value });
    },
    async throw(error) {
      try {
        if (result) { return await result.iterator.throw(error); }
        throw error;
      } finally { stop(); }
    },
    [Symbol.asyncIterator]() { return this; },
  };
  return {
    handle: new Proxy({ close: () => stop(), cancel: () => stop('cancel') } as QueryHandle, {
      get(target, key) {
        if (key === 'close' || key === 'cancel') { return target[key]; }
        if (key === 'capacityQueued') { return waiter !== undefined; }
        if (key === 'inputDelivery' && waiter) { return 'queued'; }
        const handle = result?.handle;
        if (!handle) { return undefined; }
        const value = Reflect.get(handle, key, handle);
        return typeof value === 'function' ? value.bind(handle) : value;
      },
    }),
    iterator,
  };
}
