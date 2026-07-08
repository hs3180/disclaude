/**
 * Tests for McpHealthTracker (Issue #4179 part 1).
 *
 * Verifies the per-session circuit-breaker primitive: consecutive-failure
 * counting, threshold-based degradation, fast-trip, session-scoped persistence
 * of the degraded state, and reset semantics.
 */

import { describe, it, expect } from 'vitest';
import { McpHealthTracker } from './mcp-health-tracker.js';

describe('McpHealthTracker', () => {
  describe('threshold-based degradation (default N=2, per #4179)', () => {
    it('does not degrade after a single failure', () => {
      const tracker = new McpHealthTracker();
      tracker.recordFailure('SearXNG');
      expect(tracker.isDegraded('SearXNG')).toBe(false);
      expect(tracker.getDegradedTools()).toEqual([]);
    });

    it('degrades after 2 consecutive failures', () => {
      const tracker = new McpHealthTracker();
      tracker.recordFailure('SearXNG');
      tracker.recordFailure('SearXNG');
      expect(tracker.isDegraded('SearXNG')).toBe(true);
      expect(tracker.getDegradedTools()).toEqual(['SearXNG']);
    });

    it('honors a custom degradationThreshold', () => {
      const tracker = new McpHealthTracker({ degradationThreshold: 3 });
      tracker.recordFailure('web_reader');
      tracker.recordFailure('web_reader');
      expect(tracker.isDegraded('web_reader')).toBe(false);
      tracker.recordFailure('web_reader');
      expect(tracker.isDegraded('web_reader')).toBe(true);
    });

    it('floors a non-positive degradationThreshold at 1 (caller bug guard)', () => {
      // 0 / negative would otherwise be nonsensical; floor keeps "first failure
      // degrades" semantics without degrading before any failure.
      for (const bad of [0, -1, -5]) {
        const tracker = new McpHealthTracker({ degradationThreshold: bad });
        expect(tracker.isDegraded('x')).toBe(false); // not degraded before any failure
        tracker.recordFailure('x');
        expect(tracker.isDegraded('x')).toBe(true); // first failure degrades
      }
    });
  });

  describe('getDegradedTools ordering', () => {
    it('returns degraded tool names sorted for stable display', () => {
      const tracker = new McpHealthTracker();
      // Trip in non-sorted insertion order.
      tracker.trip('web_reader');
      tracker.trip('SearXNG');
      tracker.trip('playwright');
      expect(tracker.getDegradedTools()).toEqual(['SearXNG', 'playwright', 'web_reader']);
    });
  });

  describe('consecutive vs total failures', () => {
    it('a success resets the consecutive counter (no false trip)', () => {
      const tracker = new McpHealthTracker();
      tracker.recordFailure('SearXNG');
      tracker.recordSuccess('SearXNG');
      tracker.recordFailure('SearXNG'); // consecutive is 1 again, not 2
      expect(tracker.isDegraded('SearXNG')).toBe(false);
    });

    it('totalFailures accumulates across successes (observability)', () => {
      const tracker = new McpHealthTracker();
      tracker.recordFailure('SearXNG');
      tracker.recordFailure('SearXNG');
      tracker.recordSuccess('SearXNG');
      tracker.recordFailure('SearXNG');
      expect(tracker.getHealth('SearXNG')?.totalFailures).toBe(3);
      expect(tracker.getHealth('SearXNG')?.consecutiveFailures).toBe(1);
    });
  });

  describe('session-scoped degradation', () => {
    it('stays degraded after a success (do not retry in the same session)', () => {
      const tracker = new McpHealthTracker();
      tracker.recordFailure('SearXNG');
      tracker.recordFailure('SearXNG');
      expect(tracker.isDegraded('SearXNG')).toBe(true);
      tracker.recordSuccess('SearXNG');
      expect(tracker.isDegraded('SearXNG')).toBe(true);
    });

    it('clear() lifts degradation for a single tool', () => {
      const tracker = new McpHealthTracker();
      tracker.recordFailure('SearXNG');
      tracker.recordFailure('SearXNG');
      tracker.clear('SearXNG');
      expect(tracker.isDegraded('SearXNG')).toBe(false);
      // Counters also gone — a fresh failure starts from 1.
      tracker.recordFailure('SearXNG');
      expect(tracker.isDegraded('SearXNG')).toBe(false);
      expect(tracker.getHealth('SearXNG')?.consecutiveFailures).toBe(1);
    });

    it('reset() clears all tools', () => {
      const tracker = new McpHealthTracker();
      tracker.recordFailure('a');
      tracker.recordFailure('a');
      tracker.recordFailure('b');
      tracker.recordFailure('b');
      expect(tracker.getDegradedTools().sort()).toEqual(['a', 'b']);
      tracker.reset();
      expect(tracker.getDegradedTools()).toEqual([]);
    });
  });

  describe('circuit-breaker fast-trip', () => {
    it('trips immediately when the fast-trip predicate matches', () => {
      const isConnError = (_tool: string, err: unknown) =>
        err instanceof Error && /fetch failed|ECONNRESET/i.test(err.message);
      const tracker = new McpHealthTracker({ isFastTripFailure: isConnError });

      tracker.recordFailure('SearXNG', new Error('Network Error: fetch failed'));
      expect(tracker.isDegraded('SearXNG')).toBe(true);
    });

    it('does not fast-trip when the predicate returns false', () => {
      const never = () => false;
      const tracker = new McpHealthTracker({ isFastTripFailure: never });
      tracker.recordFailure('SearXNG', new Error('boom'));
      expect(tracker.isDegraded('SearXNG')).toBe(false);
    });

    it('trip() manually marks a tool degraded', () => {
      const tracker = new McpHealthTracker();
      tracker.trip('Playwright');
      expect(tracker.isDegraded('Playwright')).toBe(true);
    });
  });

  describe('multi-tool independence', () => {
    it('tracks each tool separately', () => {
      const tracker = new McpHealthTracker();
      tracker.recordFailure('SearXNG');
      tracker.recordFailure('SearXNG');
      tracker.recordFailure('web_reader');
      expect(tracker.getDegradedTools()).toEqual(['SearXNG']);
      expect(tracker.isDegraded('web_reader')).toBe(false);
    });
  });

  describe('observability', () => {
    it('getHealth returns undefined for an unseen tool', () => {
      const tracker = new McpHealthTracker();
      expect(tracker.getHealth('nope')).toBeUndefined();
    });

    it('records degradedAt with the injected clock', () => {
      const fixed = new Date('2026-07-08T00:00:00Z');
      const tracker = new McpHealthTracker({ now: () => fixed });
      tracker.recordFailure('SearXNG');
      tracker.recordFailure('SearXNG');
      expect(tracker.getHealth('SearXNG')?.degradedAt).toBe(fixed.toISOString());
    });

    it('getHealth returns a defensive copy (mutations do not leak)', () => {
      const tracker = new McpHealthTracker();
      tracker.recordFailure('SearXNG');
      const snap = tracker.getHealth('SearXNG');
      snap!.consecutiveFailures = 999;
      expect(tracker.getHealth('SearXNG')?.consecutiveFailures).toBe(1);
    });
  });
});
