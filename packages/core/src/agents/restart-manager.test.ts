/**
 * Unit tests for RestartManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RestartManager } from './restart-manager.js';
import { createLogger } from '../utils/logger.js';

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
    it('should allow first restart with no backoff', () => {
      const decision = manager.shouldRestart('chat-1', 'test error');
      expect(decision.allowed).toBe(true);
      expect(decision.restartCount).toBe(1);
      expect(decision.circuitOpen).toBe(false);
    });

    it('should allow restarts up to maxRestarts', () => {
      const d1 = manager.shouldRestart('chat-1', 'error 1');
      expect(d1.allowed).toBe(true);
      expect(d1.restartCount).toBe(1);

      const d2 = manager.shouldRestart('chat-1', 'error 2');
      expect(d2.allowed).toBe(true);
      expect(d2.restartCount).toBe(2);

      const d3 = manager.shouldRestart('chat-1', 'error 3');
      expect(d3.allowed).toBe(true);
      expect(d3.restartCount).toBe(3);
    });

    it('should block restart when maxRestarts is exceeded', () => {
      manager.shouldRestart('chat-1', 'error 1');
      manager.shouldRestart('chat-1', 'error 2');
      manager.shouldRestart('chat-1', 'error 3');

      const decision = manager.shouldRestart('chat-1', 'error 4');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('max_restarts_exceeded');
      expect(decision.circuitOpen).toBe(true);
    });

    it('should track different chatIds independently', () => {
      const d1 = manager.shouldRestart('chat-1', 'error');
      const d2 = manager.shouldRestart('chat-2', 'error');

      expect(d1.allowed).toBe(true);
      expect(d1.restartCount).toBe(1);
      expect(d2.allowed).toBe(true);
      expect(d2.restartCount).toBe(1);
    });

    it('should block restart when circuit is already open', () => {
      // Exhaust restarts
      manager.shouldRestart('chat-1', 'error 1');
      manager.shouldRestart('chat-1', 'error 2');
      manager.shouldRestart('chat-1', 'error 3');
      manager.shouldRestart('chat-1', 'error 4'); // Opens circuit

      const decision = manager.shouldRestart('chat-1', 'error 5');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('circuit_open');
      expect(decision.circuitOpen).toBe(true);
    });

    it('should include waitMs in decision', () => {
      const decision = manager.shouldRestart('chat-1', 'error');
      expect(decision.waitMs).toBeDefined();
      expect(typeof decision.waitMs).toBe('number');
      expect(decision.waitMs! >= 0).toBe(true);
    });

    it('should calculate backoff with exponential increase', () => {
      const d1 = manager.shouldRestart('chat-1', 'error');
      expect(d1.waitMs).toBeLessThanOrEqual(1000); // initialBackoffMs

      // Second restart should have higher backoff
      const d2 = manager.shouldRestart('chat-1', 'error');
      expect(d2.waitMs).toBeLessThanOrEqual(2000); // initialBackoffMs * 2

      // Third restart
      const d3 = manager.shouldRestart('chat-1', 'error');
      expect(d3.waitMs).toBeLessThanOrEqual(4000); // initialBackoffMs * 4
    });
  });

  describe('recordSuccess', () => {
    it('should reset restart count after success', () => {
      manager.shouldRestart('chat-1', 'error');
      manager.shouldRestart('chat-1', 'error');
      expect(manager.isCircuitOpen('chat-1')).toBe(false);

      manager.recordSuccess('chat-1');

      // Should be able to restart again
      const decision = manager.shouldRestart('chat-1', 'error');
      expect(decision.allowed).toBe(true);
      expect(decision.restartCount).toBe(1);
    });

    it('should not throw for non-existent chatId', () => {
      expect(() => manager.recordSuccess('non-existent')).not.toThrow();
    });

    it('should clear recent errors on success', () => {
      manager.shouldRestart('chat-1', 'error 1');
      manager.shouldRestart('chat-1', 'error 2');
      manager.recordSuccess('chat-1');
      expect(manager.getRecentErrors('chat-1')).toEqual([]);
    });
  });

  describe('recordSuccess with circuit breaker', () => {
    it('should close circuit when recordSuccess is called after errors are cleared', () => {
      // Exhaust restarts to open circuit
      manager.shouldRestart('chat-1', 'error 1');
      manager.shouldRestart('chat-1', 'error 2');
      manager.shouldRestart('chat-1', 'error 3');
      manager.shouldRestart('chat-1', 'error 4');
      expect(manager.isCircuitOpen('chat-1')).toBe(true);

      // Record success - this clears recentErrors and restartCount,
      // which causes the circuit close check to pass (no recent errors)
      manager.recordSuccess('chat-1');
      expect(manager.isCircuitOpen('chat-1')).toBe(false);
    });

    it('should reset restart count when circuit is closed after success', () => {
      // Exhaust restarts to open circuit
      for (let i = 0; i < 4; i++) {
        manager.shouldRestart('chat-1', `error ${i}`);
      }
      expect(manager.isCircuitOpen('chat-1')).toBe(true);

      // Record success
      manager.recordSuccess('chat-1');
      expect(manager.isCircuitOpen('chat-1')).toBe(false);

      // Should be able to restart again from scratch
      const decision = manager.shouldRestart('chat-1', 'new error');
      expect(decision.allowed).toBe(true);
      expect(decision.restartCount).toBe(1);
    });
  });

  describe('reset', () => {
    it('should clear restart state for a chatId', () => {
      manager.shouldRestart('chat-1', 'error 1');
      manager.shouldRestart('chat-1', 'error 2');

      manager.reset('chat-1');

      // Should start fresh
      const decision = manager.shouldRestart('chat-1', 'error');
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
      manager.shouldRestart('chat-1', 'error');
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
      manager.shouldRestart('chat-1', 'error 1');
      manager.shouldRestart('chat-1', 'error 2');

      const errors = manager.getRecentErrors('chat-1');
      expect(errors).toHaveLength(2);
      expect(errors[0].message).toBe('error 1');
      expect(errors[1].message).toBe('error 2');
    });

    it('should keep only maxRecentErrors entries', () => {
      for (let i = 0; i < 7; i++) {
        manager.shouldRestart('chat-1', `error ${i}`);
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
        manager.shouldRestart('chat-1', `error ${i}`);
      }
      expect(manager.isCircuitOpen('chat-1')).toBe(true);
    });
  });

  describe('clearAll', () => {
    it('should clear all states', () => {
      manager.shouldRestart('chat-1', 'error');
      manager.shouldRestart('chat-2', 'error');
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

      const d1 = strictManager.shouldRestart('chat-1', 'error');
      expect(d1.allowed).toBe(true);

      const d2 = strictManager.shouldRestart('chat-1', 'error');
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

      const d1 = quickManager.shouldRestart('chat-1', 'error');
      expect(d1.allowed).toBe(true);
      expect(d1.waitMs).toBeLessThanOrEqual(10);
    });
  });
});
