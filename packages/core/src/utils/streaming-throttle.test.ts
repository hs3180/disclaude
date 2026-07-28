/**
 * Tests for StreamingThrottle (Issue #4399 / #4208 P2-b, part 1).
 *
 * Uses an injected fake clock (no vi.useFakeTimers needed) so timing is
 * deterministic and the test owns the scheduler.
 */
import { describe, it, expect, vi } from 'vitest';
import { StreamingThrottle } from './streaming-throttle.js';

/** Minimal fake clock: controlled `now`, and setTimeout fires only on tick(). */
function fakeClock() {
  let t = 0;
  const timers = new Map<number, { fire: () => void; at: number }>();
  let nextId = 1;
  return {
    now: () => t,
    advance(ms: number): void {
      const target = t + ms;
      while (true) {
        // Fire the earliest timer due at/before target.
        let earliest: { id: number; at: number } | undefined;
        for (const [id, tmr] of timers) {
          if (tmr.at <= target && (earliest === undefined || tmr.at < earliest.at)) {
            earliest = { id, at: tmr.at };
          }
        }
        if (!earliest) {break;}
        t = earliest.at;
        const tmr = timers.get(earliest.id)!;
        timers.delete(earliest.id);
        tmr.fire();
      }
      t = target;
    },
    setTimeout: ((fire: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fire, at: t + ms });
      return id as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
      timers.delete(id as unknown as number);
    }) as typeof clearTimeout,
  };
}

function makeThrottle(opts?: { minIntervalMs?: number; maxBackoffMs?: number }) {
  const clock = fakeClock();
  const emit = vi.fn((_content: string) => Promise.resolve());
  const throttle = new StreamingThrottle(emit, {
    minIntervalMs: opts?.minIntervalMs ?? 100,
    maxBackoffMs: opts?.maxBackoffMs ?? 1000,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  return { throttle, emit, clock };
}

describe('StreamingThrottle (Issue #4399 / #4208 P2-b)', () => {
  it('leading: first schedule emits immediately', () => {
    const { throttle, emit } = makeThrottle();
    throttle.schedule('a');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('a');
  });

  it('trailing: rapid calls within the window stash the latest content', () => {
    const { throttle, emit, clock } = makeThrottle({ minIntervalMs: 100 });
    throttle.schedule('a'); // leading emit
    throttle.schedule('b'); // stashed (within window)
    throttle.schedule('c'); // stashed (latest wins)
    expect(emit).toHaveBeenCalledTimes(1); // only leading so far
    expect(emit).toHaveBeenLastCalledWith('a');

    clock.advance(100); // trailing edge
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith('c'); // latest content emitted
  });

  it('does not emit a trailing event if no calls followed the leading one', () => {
    const { throttle, emit, clock } = makeThrottle({ minIntervalMs: 100 });
    throttle.schedule('a');
    clock.advance(100);
    expect(emit).toHaveBeenCalledTimes(1); // no trailing duplicate
  });

  it('respects minIntervalMs between leading emissions across windows', () => {
    const { throttle, emit, clock } = makeThrottle({ minIntervalMs: 100 });
    throttle.schedule('a'); // emit (leading)
    clock.advance(99); // not yet past window
    throttle.schedule('b'); // stashed
    expect(emit).toHaveBeenCalledTimes(1);
    clock.advance(1); // trailing edge
    expect(emit).toHaveBeenLastCalledWith('b');
  });

  it('note429 applies exponential backoff (capped at maxBackoffMs)', () => {
    const { throttle, emit, clock } = makeThrottle({ minIntervalMs: 100, maxBackoffMs: 1000 });
    throttle.schedule('a'); // emit immediately (leading, no backoff yet)
    expect(emit).toHaveBeenCalledTimes(1);

    throttle.note429(); // backoff: 200
    expect(throttle.effectiveIntervalMs).toBe(200);
    throttle.schedule('b'); // within 200ms window → stashed
    expect(emit).toHaveBeenCalledTimes(1);
    clock.advance(100); // would be trailing edge at minInterval, but backoff is 200
    expect(emit).toHaveBeenCalledTimes(1); // not yet
    clock.advance(100); // now 200ms elapsed
    expect(emit).toHaveBeenLastCalledWith('b');

    throttle.note429(); // backoff: 400
    throttle.note429(); // backoff: 800
    throttle.note429(); // backoff: 1000 (capped)
    throttle.note429(); // still 1000 (cap)
    expect(throttle.effectiveIntervalMs).toBe(1000);
  });

  it('note429 first backoff is capped at maxBackoffMs when 2*minIntervalMs exceeds it', () => {
    // Regression: the first note429() used minIntervalMs*2 *without* the cap,
    // so a low maxBackoffMs (< 2*minIntervalMs) backed off past the cap on the
    // very first 429 (only later doublings were capped). min=200/max=300 ⇒ the
    // first backoff must be 300, not 400.
    const { throttle } = makeThrottle({ minIntervalMs: 200, maxBackoffMs: 300 });
    throttle.note429(); // 2*200=400, capped at 300
    expect(throttle.effectiveIntervalMs).toBe(300);
    throttle.note429(); // already at cap, stays 300
    expect(throttle.effectiveIntervalMs).toBe(300);
  });

  it('noteSuccess resets the backoff', () => {
    const { throttle } = makeThrottle({ minIntervalMs: 100 });
    throttle.note429();
    expect(throttle.effectiveIntervalMs).toBe(200);
    throttle.noteSuccess();
    expect(throttle.effectiveIntervalMs).toBe(100);
  });

  it('finalize cancels the pending trailing emit (no leak)', () => {
    const { throttle, emit, clock } = makeThrottle({ minIntervalMs: 100 });
    throttle.schedule('a'); // leading
    throttle.schedule('b'); // stashed, trailing armed
    throttle.finalize();
    clock.advance(1000); // well past the window
    expect(emit).toHaveBeenCalledTimes(1); // trailing never fired
    expect(emit).toHaveBeenLastCalledWith('a');
  });

  it('schedule after finalize is a no-op', () => {
    const { throttle, emit } = makeThrottle();
    throttle.finalize();
    throttle.schedule('a');
    expect(emit).not.toHaveBeenCalled();
  });
});
