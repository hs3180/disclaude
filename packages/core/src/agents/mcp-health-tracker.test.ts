/**
 * Unit tests for McpHealthTracker (Issue #4179 part 1).
 *
 * Covers: default threshold (2), consecutive-failure reset on success,
 * degraded-state persistence, fast-trip predicate, manual trip, clear/reset,
 * injectable clock for deterministic timestamps, and threshold floor.
 */

import { describe, it, expect } from 'vitest';
import { McpHealthTracker } from './mcp-health-tracker.js';

describe('McpHealthTracker', () => {
  it('defaults to degrading after 2 consecutive failures (per #4179)', () => {
    const tracker = new McpHealthTracker();
    expect(tracker.isDegraded('searxng')).toBe(false);

    tracker.recordFailure('searxng');
    expect(tracker.isDegraded('searxng')).toBe(false); // 1 failure — still healthy

    tracker.recordFailure('searxng');
    expect(tracker.isDegraded('searxng')).toBe(true); // 2 consecutive — degraded
  });

  it('does not degrade after a single failure', () => {
    const tracker = new McpHealthTracker();
    tracker.recordFailure('web_reader');
    expect(tracker.isDegraded('web_reader')).toBe(false);
    expect(tracker.getDegradedTools()).toEqual([]);
  });

  it('resets the consecutive-failure counter on success', () => {
    const tracker = new McpHealthTracker();
    tracker.recordFailure('searxng');
    tracker.recordSuccess('searxng'); // reset to 0
    tracker.recordFailure('searxng'); // back to 1 — not yet degraded
    expect(tracker.isDegraded('searxng')).toBe(false);
  });

  it('keeps totalFailures accumulating across successes', () => {
    const tracker = new McpHealthTracker();
    tracker.recordFailure('searxng');
    tracker.recordSuccess('searxng');
    tracker.recordFailure('searxng');
    const health = tracker.getHealth('searxng');
    expect(health?.totalFailures).toBe(2);
    expect(health?.consecutiveFailures).toBe(1);
  });

  it('does NOT clear an already-degraded tool on success (#4179: stop retrying in-session)', () => {
    const tracker = new McpHealthTracker();
    tracker.recordFailure('searxng');
    tracker.recordFailure('searxng'); // degraded
    expect(tracker.isDegraded('searxng')).toBe(true);

    tracker.recordSuccess('searxng'); // success does not revive a tripped tool
    expect(tracker.isDegraded('searxng')).toBe(true);
    const health = tracker.getHealth('searxng');
    expect(health?.consecutiveFailures).toBe(0); // counter reset, but degraded stays
  });

  it('fast-trips immediately when the isFastTripFailure predicate matches', () => {
    const tracker = new McpHealthTracker({
      isFastTripFailure: (_name, err) =>
        err instanceof Error && /fetch failed/i.test(err.message),
    });
    tracker.recordFailure('searxng', new Error('Network Error: fetch failed'));
    expect(tracker.isDegraded('searxng')).toBe(true); // tripped on first failure
  });

  it('does not fast-trip when the predicate returns false', () => {
    const tracker = new McpHealthTracker({
      isFastTripFailure: () => false,
    });
    tracker.recordFailure('searxng', new Error('parse error'));
    expect(tracker.isDegraded('searxng')).toBe(false);
  });

  it('respects a custom degradationThreshold', () => {
    const tracker = new McpHealthTracker({ degradationThreshold: 3 });
    tracker.recordFailure('searxng');
    tracker.recordFailure('searxng');
    expect(tracker.isDegraded('searxng')).toBe(false); // 2 < 3
    tracker.recordFailure('searxng');
    expect(tracker.isDegraded('searxng')).toBe(true); // 3 >= 3
  });

  it('floors a non-positive threshold at 1 (caller-bug guard)', () => {
    const tracker = new McpHealthTracker({ degradationThreshold: 0 });
    tracker.recordFailure('searxng');
    expect(tracker.isDegraded('searxng')).toBe(true); // first failure degrades
  });

  it('records degradedAt via the injectable clock', () => {
    const fixed = new Date('2026-07-11T00:00:00.000Z');
    const tracker = new McpHealthTracker({ now: () => fixed });
    tracker.recordFailure('searxng');
    tracker.recordFailure('searxng');
    expect(tracker.getHealth('searxng')?.degradedAt).toBe(fixed.toISOString());
  });

  it('getDegradedTools returns sorted names of all degraded tools', () => {
    const tracker = new McpHealthTracker();
    // Degrade web_reader (2 failures) and playwright (fast-trip)
    tracker.recordFailure('web_reader');
    tracker.recordFailure('web_reader');
    tracker.trip('playwright');
    tracker.recordFailure('searxng'); // only 1 — not degraded
    expect(tracker.getDegradedTools()).toEqual(['playwright', 'web_reader']);
  });

  it('getHealth returns a defensive copy (mutations do not leak)', () => {
    const tracker = new McpHealthTracker();
    tracker.recordFailure('searxng');
    const snapshot = tracker.getHealth('searxng');
    expect(snapshot).toBeDefined();
    // Mutating the returned object must not affect internal state.
    snapshot!.consecutiveFailures = 99;
    expect(tracker.getHealth('searxng')?.consecutiveFailures).toBe(1);
  });

  it('returns undefined / false for unseen tools', () => {
    const tracker = new McpHealthTracker();
    expect(tracker.getHealth('unknown')).toBeUndefined();
    expect(tracker.isDegraded('unknown')).toBe(false);
  });

  it('trip manually marks a tool degraded without recording a failure', () => {
    const tracker = new McpHealthTracker({ now: () => new Date('2026-07-11T00:00:00.000Z') });
    tracker.trip('playwright');
    expect(tracker.isDegraded('playwright')).toBe(true);
    const health = tracker.getHealth('playwright');
    expect(health?.totalFailures).toBe(0); // manual trip does not inflate counts
    expect(health?.degradedAt).toBe('2026-07-11T00:00:00.000Z');
  });

  it('trip is idempotent (does not re-stamp degradedAt)', () => {
    const calls: Date[] = [];
    const tracker = new McpHealthTracker({
      now: () => {
        const d = new Date('2026-07-11T00:00:00.000Z');
        d.setMinutes(d.getMinutes() + calls.length);
        calls.push(d);
        return d;
      },
    });
    tracker.trip('playwright');
    const firstAt = tracker.getHealth('playwright')?.degradedAt;
    tracker.trip('playwright'); // second trip must not overwrite timestamp
    expect(tracker.getHealth('playwright')?.degradedAt).toBe(firstAt);
  });

  it('clear removes a single tool, leaving others intact', () => {
    const tracker = new McpHealthTracker();
    tracker.recordFailure('searxng');
    tracker.recordFailure('searxng');
    tracker.recordFailure('web_reader');
    tracker.recordFailure('web_reader');
    tracker.clear('searxng');
    expect(tracker.isDegraded('searxng')).toBe(false);
    expect(tracker.getHealth('searxng')).toBeUndefined();
    expect(tracker.isDegraded('web_reader')).toBe(true);
  });

  it('reset clears all tool health', () => {
    const tracker = new McpHealthTracker();
    tracker.recordFailure('searxng');
    tracker.recordFailure('searxng');
    tracker.trip('playwright');
    tracker.reset();
    expect(tracker.getDegradedTools()).toEqual([]);
    expect(tracker.getHealth('searxng')).toBeUndefined();
  });

  it('further failures on an already-degraded tool do not re-stamp degradedAt', () => {
    const fixed = new Date('2026-07-11T00:00:00.000Z');
    let ticks = 0;
    const tracker = new McpHealthTracker({
      now: () => {
        const d = new Date(fixed.getTime() + ticks * 60_000);
        ticks += 1;
        return d;
      },
    });
    tracker.recordFailure('searxng'); // t+0
    tracker.recordFailure('searxng'); // t+1min — degraded, stamped
    const stampedAt = tracker.getHealth('searxng')?.degradedAt;
    tracker.recordFailure('searxng'); // t+2min — already degraded, should not re-stamp
    tracker.recordFailure('searxng'); // t+3min
    expect(tracker.getHealth('searxng')?.degradedAt).toBe(stampedAt);
    expect(tracker.getHealth('searxng')?.totalFailures).toBe(4);
  });
});
