/**
 * Tests for the codex session/run governor — Issue #4634 (S7 of #4627).
 *
 * Pure-logic coverage of the governance policy: session cap + LRU eviction
 * (deterministic via the injectable clock), FIFO run queue, lease
 * idempotency, the registration-identity guard (a chat's dying old stream
 * must not unregister its replacement — cf. #3378), runtime limit changes,
 * and stats. Provider-level integration (real subprocesses) lives in
 * provider.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { CodexSessionGovernor } from './session-governor.js';

/** Deterministic clock: tests advance it explicitly. */
function makeClock() {
  let t = 1_000;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const NOOP = (): void => {};

describe('CodexSessionGovernor session cap (Issue #4634)', () => {
  it('defaults to 3 sessions / 2 runs', () => {
    const g = new CodexSessionGovernor();
    const stats = g.getStats();
    expect(stats.maxActiveSessions).toBe(3);
    expect(stats.maxConcurrentRuns).toBe(2);
  });

  it('evicts the IDLEST session when a new one arrives at cap (LRU)', () => {
    const clock = makeClock();
    const g = new CodexSessionGovernor({ maxActiveSessions: 2, now: clock.now });
    const evicted: string[] = [];
    g.registerSession('a', { evict: () => evicted.push('a') });
    clock.advance(10);
    g.registerSession('b', { evict: () => evicted.push('b') });
    clock.advance(10);
    // 'a' becomes active again — 'b' is now the idlest.
    g.touchSession('a');
    clock.advance(10);

    const notice = g.registerSession('c', { evict: NOOP });
    expect(notice.evictedKey).toBe('b');
    expect(evicted).toEqual(['b']);
    expect(g.getStats().activeSessions).toBe(2);
    expect(g.getStats().evictedSessions).toBe(1);
  });

  it('breaks LRU ties by registration order (oldest registration first)', () => {
    const clock = makeClock();
    const g = new CodexSessionGovernor({ maxActiveSessions: 2, now: clock.now });
    // Same activity timestamp for both (no clock advance between).
    g.registerSession('old', { evict: NOOP });
    g.registerSession('new', { evict: NOOP });
    const notice = g.registerSession('c', { evict: NOOP });
    expect(notice.evictedKey).toBe('old');
  });

  it('re-registration of a known key replaces in place (no eviction)', () => {
    const g = new CodexSessionGovernor({ maxActiveSessions: 2 });
    g.registerSession('a', { evict: NOOP });
    g.registerSession('b', { evict: NOOP });
    const notice = g.registerSession('a', { evict: NOOP }); // chat restart
    expect(notice.evictedKey).toBeUndefined();
    expect(g.getStats().activeSessions).toBe(2);
  });

  it('unregister removes its own registration only (identity guard, cf. #3378)', () => {
    const g = new CodexSessionGovernor();
    const first = g.registerSession('a', { evict: NOOP });
    const second = g.registerSession('a', { evict: NOOP }); // replacement registered
    first.unregister(); // dying OLD stream must not unregister the NEW one
    expect(g.getStats().activeSessions).toBe(1);
    second.unregister();
    expect(g.getStats().activeSessions).toBe(0);
  });
});

describe('CodexSessionGovernor run cap (Issue #4634)', () => {
  it('serializes runs beyond maxConcurrentRuns and hands slots out FIFO', async () => {
    const g = new CodexSessionGovernor({ maxConcurrentRuns: 1 });
    const first = await g.acquireRun();
    expect(first.queuedBehind).toBe(0);
    expect(g.getStats().runningRuns).toBe(1);

    const order: string[] = [];
    const second = g.acquireRun().then((lease) => {
      order.push('second');
      return lease;
    });
    const third = g.acquireRun().then((lease) => {
      order.push('third');
      return lease;
    });
    // Neither extra run may start while the slot is held.
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(g.getStats().queuedRuns).toBe(2);

    first.release();
    const secondLease = await second;
    expect(order).toEqual(['second']);
    expect(secondLease.queuedBehind).toBe(0); // first in line
    secondLease.release(); // free the slot for the third waiter

    const thirdLease = await third;
    expect(order).toEqual(['second', 'third']);
    expect(g.getStats().runningRuns).toBe(1); // third still held
    thirdLease.release();
    expect(g.getStats().runningRuns).toBe(0);
  });

  it('release() is idempotent — cannot double-free a slot', async () => {
    const g = new CodexSessionGovernor({ maxConcurrentRuns: 1 });
    const lease = await g.acquireRun();
    lease.release();
    lease.release();
    expect(g.getStats().runningRuns).toBe(0);
    // The double-release must not have manufactured a slot for a waiter.
    const next = await g.acquireRun();
    expect(g.getStats().runningRuns).toBe(1);
    next.release();
  });

  it('setLimits applies the run cap to future acquisitions immediately', async () => {
    const g = new CodexSessionGovernor({ maxConcurrentRuns: 2 });
    const a = await g.acquireRun();
    const b = await g.acquireRun();
    g.setLimits({ maxConcurrentRuns: 1 }); // tighten below current usage
    let queuedResolved = false;
    const c = g.acquireRun().then((lease) => {
      queuedResolved = true;
      return lease;
    });
    await Promise.resolve();
    expect(queuedResolved).toBe(false); // still blocked: one run must finish
    a.release();
    b.release(); // drains; c finally gets the slot
    const leaseC = await c;
    expect(queuedResolved).toBe(true);
    leaseC.release();
  });

  it('lowering the session cap does not proactively evict live sessions', () => {
    const g = new CodexSessionGovernor({ maxActiveSessions: 3 });
    g.registerSession('a', { evict: NOOP });
    g.registerSession('b', { evict: NOOP });
    g.setLimits({ maxActiveSessions: 1 });
    expect(g.getStats().activeSessions).toBe(2); // untouched
    // The cap re-engages on the next registration: evict down TO the cap
    // (both incumbents go — the lowered cap is enforced, not advisory).
    const notice = g.registerSession('c', { evict: NOOP });
    expect(notice.evictedKey).toBeDefined();
    expect(g.getStats().activeSessions).toBe(1);
  });
});

describe('CodexSessionGovernor review hardening (S7 review)', () => {
  it('setLimits rejects non-positive caps (event-loop freeze guard)', () => {
    const g = new CodexSessionGovernor({ maxActiveSessions: 2 });
    expect(() => g.setLimits({ maxActiveSessions: 0 })).toThrow(/positive number/);
    expect(() => g.setLimits({ maxConcurrentRuns: -1 })).toThrow(/positive number/);
    // Valid change still applies.
    g.setLimits({ maxActiveSessions: 1 });
    expect(g.getStats().maxActiveSessions).toBe(1);
  });

  it('pumpQueue re-checks the cap — a lowered run cap is not refilled by releases', async () => {
    const g = new CodexSessionGovernor({ maxConcurrentRuns: 2 });
    const a = await g.acquireRun();
    const b = await g.acquireRun();
    g.setLimits({ maxConcurrentRuns: 1 }); // tighten below current usage
    const waiter = g.acquireRun();
    a.release();
    b.release();
    await new Promise((r) => setTimeout(r, 20));
    // Both slots freed, but the cap is 1: exactly one run may be in flight.
    const stats = g.getStats();
    expect(stats.runningRuns).toBe(1);
    expect(stats.queuedRuns).toBe(0);
    // Drain cleanly.
    const lease = await waiter;
    lease.release();
    const c = await g.acquireRun(); // fast path — slot free under cap 1
    c.release();
  });
});
