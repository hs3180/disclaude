/**
 * Unit tests for RestartManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RestartManager } from './restart-manager.js';
import { createLogger } from '../utils/logger.js';
import { tagErrorCategory } from '../utils/error-handler.js';

describe('RestartManager', () => {
  let manager: RestartManager;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(() => {
    logger = createLogger('TestRestartManager');
    manager = new RestartManager({
      logger,
      maxRestarts: 3,
      initialBackoffMs: 1000,
      maxBackoffMs: 30000,
      backoffMultiplier: 2,
      resetWindowMs: 10000,
    });
  });

  describe('constructor', () => {
    it('should create a RestartManager with default config', () => {
      const defaultManager = new RestartManager({ logger });
      expect(defaultManager).toBeDefined();
    });

    it('should use custom config values', () => {
      const customManager = new RestartManager({
        logger,
        maxRestarts: 5,
        initialBackoffMs: 2000,
      });
      expect(customManager).toBeDefined();
    });
  });

  describe('shouldRestart', () => {
    it('Issue #4314 (L2): blocks restart for non-transient errors', () => {
      const decision = manager.shouldRestart('chat-1', 'validation failed: invalid input');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('non_transient');
      expect(decision.restartCount).toBe(0); // doesn't consume a restart slot
    });

    it('Issue #4314 (L2): allows restart for transient (network) errors', () => {
      const decision = manager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(decision.allowed).toBe(true);
    });

    // Issue #4314 (L2): shouldRestart must reuse L0's pre-computed tag on the
    // error object (acceptance: "复用 L0 的 tag, 不重复分类") instead of
    // re-classifying a bare message string. classifyError keys off the error's
    // constructor NAME as well as its message, so `isTransient(new Error(msg))`
    // loses the name and misclassifies — e.g. a TimeoutError whose message has
    // no "timeout" keyword classifies as UNKNOWN (non-transient) and would
    // WRONGLY suppress a restart. These tests lock the tag-reuse path.

    it('Issue #4314 (L2): reuses L0 tag — name-classified transient error allows restart', () => {
      // A TimeoutError whose message lacks any transient keyword. classifyError
      // keys off the constructor name → NETWORK (the NETWORK branch matches
      // names containing 'timeout' before the TIMEOUT branch) → transient. But
      // re-classifying `new Error(message)` would drop the name → UNKNOWN →
      // non-transient.
      class TimeoutError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'TimeoutError';
        }
      }
      const error = new TimeoutError('upstream stream ended unexpectedly');
      tagErrorCategory(error); // attach the L0 tag (as chat-agent does before calling)
      expect(tagErrorCategory(error).transient).toBe(true); // sanity: name → NETWORK (transient)

      // With the fix: reads the tag → transient → restart allowed.
      const decision = manager.shouldRestart('chat-1', error.message, error);
      expect(decision.allowed).toBe(true);
      // True regression: without the error arg (legacy message-only path), the
      // bare-message re-classification says UNKNOWN/non-transient → refused.
      const legacyDecision = manager.shouldRestart('chat-2', error.message);
      expect(legacyDecision.allowed).toBe(false);
      expect(legacyDecision.reason).toBe('non_transient');
    });

    it('Issue #4314 (L2): reuses L0 tag — name-classified persistent error refuses restart without consuming quota', () => {
      // A ValidationError whose message lacks the "invalid/required/missing"
      // keywords. classifyError keys off the name → VALIDATION → non-transient.
      class ValidationError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'ValidationError';
        }
      }
      const error = new ValidationError('schema mismatch');
      tagErrorCategory(error);
      expect(tagErrorCategory(error).transient).toBe(false); // sanity

      const decision = manager.shouldRestart('chat-1', error.message, error);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('non_transient');
      // Persistent errors must NOT consume a restart slot (so a later transient
      // error can still use the full quota).
      expect(decision.restartCount).toBe(0);
    });

    it('Issue #4314 (L2): untagged passed error is classified by name (fallback must not wrap as new Error)', () => {
      // nit: when the caller passes an error that has NO L0 tag, the fallback
      // must classify the original error object (preserving constructor name),
      // NOT `new Error(message)` — otherwise it reintroduces the exact
      // name-loss bug locked above. A name-classified transient error with no
      // tag must still be seen as transient.
      class TimeoutError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'TimeoutError';
        }
      }
      const error = new TimeoutError('upstream stream ended unexpectedly');
      // Deliberately NOT calling tagErrorCategory(error): simulates an untagged
      // error reaching shouldRestart (no L0 tag to read).
      const decision = manager.shouldRestart('chat-1', error.message, error);
      expect(decision.allowed).toBe(true); // name → NETWORK → transient → restart
    });

    it('Issue #4314 (L2): circuit breaker still trips on repeated transient tagged errors', () => {
      class TimeoutError extends Error {
        constructor(message: string) {
          super(message);
          this.name = 'TimeoutError';
        }
      }
      const tagged = () => {
        const e = new TimeoutError('stream ended');
        tagErrorCategory(e);
        return e;
      };
      manager.shouldRestart('chat-1', 'a', tagged());
      manager.shouldRestart('chat-1', 'b', tagged());
      manager.shouldRestart('chat-1', 'c', tagged());
      const decision = manager.shouldRestart('chat-1', 'd', tagged());
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('max_restarts_exceeded');
      expect(decision.circuitOpen).toBe(true);
    });

    it('should allow first restart with no backoff', () => {
      const decision = manager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(decision.allowed).toBe(true);
      expect(decision.restartCount).toBe(1);
      expect(decision.circuitOpen).toBe(false);
    });

    it('should allow restarts up to maxRestarts', () => {
      const d1 = manager.shouldRestart('chat-1', 'Network Error: timeout 1');
      expect(d1.allowed).toBe(true);
      expect(d1.restartCount).toBe(1);

      const d2 = manager.shouldRestart('chat-1', 'Network Error: timeout 2');
      expect(d2.allowed).toBe(true);
      expect(d2.restartCount).toBe(2);

      const d3 = manager.shouldRestart('chat-1', 'Network Error: timeout 3');
      expect(d3.allowed).toBe(true);
      expect(d3.restartCount).toBe(3);
    });

    it('should block restart when maxRestarts is exceeded', () => {
      manager.shouldRestart('chat-1', 'Network Error: timeout 1');
      manager.shouldRestart('chat-1', 'Network Error: timeout 2');
      manager.shouldRestart('chat-1', 'Network Error: timeout 3');

      const decision = manager.shouldRestart('chat-1', 'Network Error: timeout 4');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('max_restarts_exceeded');
      expect(decision.circuitOpen).toBe(true);
    });

    it('should track different chatIds independently', () => {
      const d1 = manager.shouldRestart('chat-1', 'Network Error: timeout');
      const d2 = manager.shouldRestart('chat-2', 'Network Error: timeout');

      expect(d1.allowed).toBe(true);
      expect(d1.restartCount).toBe(1);
      expect(d2.allowed).toBe(true);
      expect(d2.restartCount).toBe(1);
    });

    it('should block restart when circuit is already open', () => {
      // Exhaust restarts
      manager.shouldRestart('chat-1', 'Network Error: timeout 1');
      manager.shouldRestart('chat-1', 'Network Error: timeout 2');
      manager.shouldRestart('chat-1', 'Network Error: timeout 3');
      manager.shouldRestart('chat-1', 'Network Error: timeout 4'); // Opens circuit

      const decision = manager.shouldRestart('chat-1', 'Network Error: timeout 5');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('circuit_open');
      expect(decision.circuitOpen).toBe(true);
    });

    it('should include waitMs in decision', () => {
      const decision = manager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(decision.waitMs).toBeDefined();
      expect(typeof decision.waitMs).toBe('number');
      expect(decision.waitMs! >= 0).toBe(true);
    });

    it('should calculate backoff with exponential increase', () => {
      const d1 = manager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(d1.waitMs).toBeLessThanOrEqual(1000); // initialBackoffMs

      // Second restart should have higher backoff
      const d2 = manager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(d2.waitMs).toBeLessThanOrEqual(2000); // initialBackoffMs * 2

      // Third restart
      const d3 = manager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(d3.waitMs).toBeLessThanOrEqual(4000); // initialBackoffMs * 4
    });
  });

  describe('recordSuccess', () => {
    it('should reset restart count after success', () => {
      manager.shouldRestart('chat-1', 'Network Error: timeout');
      manager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(manager.isCircuitOpen('chat-1')).toBe(false);

      manager.recordSuccess('chat-1');

      // Should be able to restart again
      const decision = manager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(decision.allowed).toBe(true);
      expect(decision.restartCount).toBe(1);
    });

    it('should not throw for non-existent chatId', () => {
      expect(() => manager.recordSuccess('non-existent')).not.toThrow();
    });

    it('should clear recent errors on success', () => {
      manager.shouldRestart('chat-1', 'Network Error: timeout 1');
      manager.shouldRestart('chat-1', 'Network Error: timeout 2');
      manager.recordSuccess('chat-1');
      expect(manager.getRecentErrors('chat-1')).toEqual([]);
    });
  });

  describe('recordSuccess with circuit breaker', () => {
    it('should close circuit when recordSuccess is called after errors are cleared', () => {
      // Exhaust restarts to open circuit
      manager.shouldRestart('chat-1', 'Network Error: timeout 1');
      manager.shouldRestart('chat-1', 'Network Error: timeout 2');
      manager.shouldRestart('chat-1', 'Network Error: timeout 3');
      manager.shouldRestart('chat-1', 'Network Error: timeout 4');
      expect(manager.isCircuitOpen('chat-1')).toBe(true);

      // Record success - this clears recentErrors and restartCount,
      // which causes the circuit close check to pass (no recent errors)
      manager.recordSuccess('chat-1');
      expect(manager.isCircuitOpen('chat-1')).toBe(false);
    });

    it('should reset restart count when circuit is closed after success', () => {
      // Exhaust restarts to open circuit
      for (let i = 0; i < 4; i++) {
        manager.shouldRestart('chat-1', `Network Error: timeout ${i}`);
      }
      expect(manager.isCircuitOpen('chat-1')).toBe(true);

      // Record success
      manager.recordSuccess('chat-1');
      expect(manager.isCircuitOpen('chat-1')).toBe(false);

      // Should be able to restart again from scratch
      const decision = manager.shouldRestart('chat-1', 'Network Error: new timeout');
      expect(decision.allowed).toBe(true);
      expect(decision.restartCount).toBe(1);
    });
  });

  describe('recordFailure', () => {
    it('should increment restartCount without allowing a restart', () => {
      manager.recordFailure('chat-stall', 'stall');
      const state = manager.getState('chat-stall');
      expect(state?.restartCount).toBe(1);
      expect(manager.isCircuitOpen('chat-stall')).toBe(false);
    });

    it('should open the circuit after maxRestarts failures', () => {
      manager.recordFailure('chat-stall', 'stall');
      manager.recordFailure('chat-stall', 'stall');
      manager.recordFailure('chat-stall', 'stall');
      expect(manager.getState('chat-stall')?.restartCount).toBe(3);
      expect(manager.isCircuitOpen('chat-stall')).toBe(true);
    });

    it('should be reset by a subsequent recordSuccess', () => {
      manager.recordFailure('chat-stall', 'stall');
      manager.recordFailure('chat-stall', 'stall');
      manager.recordSuccess('chat-stall');
      expect(manager.getState('chat-stall')?.restartCount).toBe(0);
    });

    it('should be a no-op when circuit already open', () => {
      manager.recordFailure('chat-stall', 'stall');
      manager.recordFailure('chat-stall', 'stall');
      manager.recordFailure('chat-stall', 'stall');
      const before = manager.getState('chat-stall')?.restartCount;
      manager.recordFailure('chat-stall', 'stall');
      expect(manager.getState('chat-stall')?.restartCount).toBe(before);
    });
  });

  describe('reset', () => {
    it('should clear restart state for a chatId', () => {
      manager.shouldRestart('chat-1', 'Network Error: timeout 1');
      manager.shouldRestart('chat-1', 'Network Error: timeout 2');

      manager.reset('chat-1');

      // Should start fresh
      const decision = manager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(decision.allowed).toBe(true);
      expect(decision.restartCount).toBe(1);
    });

    it('should not throw for non-existent chatId', () => {
      expect(() => manager.reset('non-existent')).not.toThrow();
    });
  });

  describe('getState', () => {
    it('should return undefined for non-existent chatId', () => {
      expect(manager.getState('non-existent')).toBeUndefined();
    });

    it('should return state for existing chatId', () => {
      manager.shouldRestart('chat-1', 'Network Error: timeout');
      const state = manager.getState('chat-1');
      expect(state).toBeDefined();
      expect(state!.restartCount).toBe(1);
      expect(state!.circuitOpen).toBe(false);
    });
  });

  describe('getRecentErrors', () => {
    it('should return empty array for non-existent chatId', () => {
      expect(manager.getRecentErrors('non-existent')).toEqual([]);
    });

    it('should track recent errors', () => {
      manager.shouldRestart('chat-1', 'Network Error: timeout 1');
      manager.shouldRestart('chat-1', 'Network Error: timeout 2');

      const errors = manager.getRecentErrors('chat-1');
      expect(errors).toHaveLength(2);
      expect(errors[0].message).toBe('Network Error: timeout 1');
      expect(errors[1].message).toBe('Network Error: timeout 2');
    });

    it('should keep only maxRecentErrors entries', () => {
      for (let i = 0; i < 7; i++) {
        manager.shouldRestart('chat-1', `Network Error: timeout ${i}`);
      }
      const errors = manager.getRecentErrors('chat-1');
      expect(errors.length).toBeLessThanOrEqual(5);
    });
  });

  describe('isCircuitOpen', () => {
    it('should return false for non-existent chatId', () => {
      expect(manager.isCircuitOpen('non-existent')).toBe(false);
    });

    it('should return false initially', () => {
      expect(manager.isCircuitOpen('chat-1')).toBe(false);
    });

    it('should return true after max restarts', () => {
      for (let i = 0; i < 4; i++) {
        manager.shouldRestart('chat-1', `Network Error: timeout ${i}`);
      }
      expect(manager.isCircuitOpen('chat-1')).toBe(true);
    });
  });

  describe('clearAll', () => {
    it('should clear all states', () => {
      manager.shouldRestart('chat-1', 'Network Error: timeout');
      manager.shouldRestart('chat-2', 'Network Error: timeout');
      expect(manager.isCircuitOpen('chat-1')).toBe(false);
      expect(manager.getState('chat-1')).toBeDefined();

      manager.clearAll();

      expect(manager.getState('chat-1')).toBeUndefined();
      expect(manager.getState('chat-2')).toBeUndefined();
      expect(manager.getRecentErrors('chat-1')).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('should handle custom maxRestarts of 1', () => {
      const strictManager = new RestartManager({
        logger,
        maxRestarts: 1,
      });

      const d1 = strictManager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(d1.allowed).toBe(true);

      const d2 = strictManager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(d2.allowed).toBe(false);
      expect(d2.reason).toBe('max_restarts_exceeded');
    });

    it('should handle very short backoff intervals', () => {
      const quickManager = new RestartManager({
        logger,
        maxRestarts: 10,
        initialBackoffMs: 10,
        backoffMultiplier: 1.5,
      });

      const d1 = quickManager.shouldRestart('chat-1', 'Network Error: timeout');
      expect(d1.allowed).toBe(true);
      expect(d1.waitMs).toBeLessThanOrEqual(10);
    });
  });
});
