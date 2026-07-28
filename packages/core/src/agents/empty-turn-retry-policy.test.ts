/**
 * Tests for EmptyTurnRetryPolicy (Issue #4391 / #4194 follow-up ②).
 *
 * Locks the two contract constraints the (deferred) reset/replay mechanism
 * must honor: synthetic messages are never retried, and retry is bounded to 1.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EmptyTurnRetryPolicy } from './empty-turn-retry-policy.js';

describe('EmptyTurnRetryPolicy (Issue #4391)', () => {
  let policy: EmptyTurnRetryPolicy;

  beforeEach(() => {
    policy = new EmptyTurnRetryPolicy();
  });

  describe('isEligible', () => {
    it('returns true for an empty turn on a real open_message_id', () => {
      expect(policy.isEligible('om_abc123', true)).toBe(true);
    });

    it('returns false for a non-empty turn (nothing to recover)', () => {
      expect(policy.isEligible('om_abc123', false)).toBe(false);
    });

    it('returns false for a scheduled-task synthetic message (sched-*)', () => {
      // #4391 / #4259: synthetic sched-* messages are not valid reply roots.
      expect(policy.isEligible('sched-daily-maint-1715644800000', true)).toBe(false);
    });

    it('returns false for other synthetic message forms (push_, cli-, msg-)', () => {
      // The policy reuses isSyntheticMessageId (#4166) — all synthetic forms
      // are covered, not just sched-*.
      expect(policy.isEligible('push_xyz', true)).toBe(false);
      expect(policy.isEligible('cli-session-1', true)).toBe(false);
      expect(policy.isEligible('msg-1715644800000', true)).toBe(false);
      expect(policy.isEligible('http-push-abc', true)).toBe(false);
    });
  });

  describe('bounded-to-1 retry (cannot loop)', () => {
    it('canRetry is true for an eligible chat that has not retried', () => {
      expect(policy.canRetry('chat-1', 'om_abc', true)).toBe(true);
    });

    it('markRetried bounds subsequent canRetry to false', () => {
      policy.markRetried('chat-1');
      // Same empty turn, same real message — but the chat already used its retry.
      expect(policy.canRetry('chat-1', 'om_abc', true)).toBe(false);
    });

    it('one chat retry does not affect another chat', () => {
      policy.markRetried('chat-1');
      expect(policy.canRetry('chat-2', 'om_abc', true)).toBe(true);
    });

    it('hasRetried reflects the bound', () => {
      expect(policy.hasRetried('chat-1')).toBe(false);
      policy.markRetried('chat-1');
      expect(policy.hasRetried('chat-1')).toBe(true);
    });

    it('a synthetic-message empty turn is not retryable even before any retry', () => {
      // canRetry short-circuits on eligibility — synthetic messages never retry.
      expect(policy.canRetry('chat-1', 'sched-xyz', true)).toBe(false);
    });
  });

  describe('reset', () => {
    it('clears the retry bound so a future empty turn can retry again', () => {
      policy.markRetried('chat-1');
      expect(policy.canRetry('chat-1', 'om_abc', true)).toBe(false);
      policy.reset('chat-1');
      expect(policy.canRetry('chat-1', 'om_abc', true)).toBe(true);
    });

    it('reset is a no-op for a chat that has not retried', () => {
      policy.reset('chat-1'); // no throw, no state change
      expect(policy.canRetry('chat-1', 'om_abc', true)).toBe(true);
    });
  });
});
