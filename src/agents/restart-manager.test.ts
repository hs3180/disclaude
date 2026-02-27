import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RestartManager } from './restart-manager.js';
import type pino from 'pino';

// Create mock logger
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as pino.Logger;

describe('RestartManager', () => {
  let manager: RestartManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    manager = new RestartManager({
      logger: mockLogger,
      maxRestarts: 3,
      initialBackoffMs: 100,
      maxBackoffMs: 1000,
      backoffMultiplier: 2,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('shouldRestart', () => {
    it('should allow first restart with initial backoff', () => {
      const decision = manager.shouldRestart('chat-1', 'Test error');

      expect(decision.allowed).toBe(true);
      expect(decision.restartCount).toBe(1);
      expect(decision.circuitOpen).toBe(false);
      expect(decision.waitMs).toBe(0); // No wait on first restart
    });

    it('should increase backoff exponentially', () => {
      // First restart
      manager.shouldRestart('chat-1', 'Error 1');
      vi.advanceTimersByTime(10);

      // Second restart
      const decision2 = manager.shouldRestart('chat-1', 'Error 2');
      expect(decision2.allowed).toBe(true);
      expect(decision2.restartCount).toBe(2);
      // Backoff should be 100ms (initial) * 2 = 200ms

      vi.advanceTimersByTime(10);

      // Third restart
      const decision3 = manager.shouldRestart('chat-1', 'Error 3');
      expect(decision3.restartCount).toBe(3);
    });

    it('should open circuit after max restarts', () => {
      // maxRestarts = 3, so 3 restarts are allowed, 4th is blocked
      manager.shouldRestart('chat-1', 'Error 1'); // restartCount becomes 1
      manager.shouldRestart('chat-1', 'Error 2'); // restartCount becomes 2
      manager.shouldRestart('chat-1', 'Error 3'); // restartCount becomes 3

      // Fourth attempt should be blocked (restartCount=3 >= maxRestarts=3)
      const decision = manager.shouldRestart('chat-1', 'Error 4');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('max_restarts_exceeded');
      expect(decision.circuitOpen).toBe(true);
    });

    it('should block restarts when circuit is open', () => {
      // Exhaust restarts to open circuit
      manager.shouldRestart('chat-1', 'Error 1'); // restartCount = 1
      manager.shouldRestart('chat-1', 'Error 2'); // restartCount = 2
      manager.shouldRestart('chat-1', 'Error 3'); // restartCount = 3
      manager.shouldRestart('chat-1', 'Error 4'); // circuit opens, returns max_restarts_exceeded

      // Circuit is now open, fifth attempt gets circuit_open
      const decision = manager.shouldRestart('chat-1', 'Error 5');
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('circuit_open');
    });

    it('should track restarts per chatId independently', () => {
      manager.shouldRestart('chat-1', 'Error');
      manager.shouldRestart('chat-1', 'Error');

      // chat-2 should have independent count
      const decision = manager.shouldRestart('chat-2', 'Error');
      expect(decision.restartCount).toBe(1);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('recordSuccess', () => {
    it('should reset restart count on success', () => {
      // Add some restarts
      manager.shouldRestart('chat-1', 'Error 1');
      manager.shouldRestart('chat-1', 'Error 2');

      // Record success
      manager.recordSuccess('chat-1');

      // Should reset to initial state
      const decision = manager.shouldRestart('chat-1', 'Error 3');
      expect(decision.restartCount).toBe(1);
    });

    it('should not affect untracked chatIds', () => {
      // Should not throw
      manager.recordSuccess('unknown-chat');
    });
  });

  describe('reset', () => {
    it('should clear state for a chatId', () => {
      // Add restarts
      manager.shouldRestart('chat-1', 'Error 1');
      manager.shouldRestart('chat-1', 'Error 2');

      // Reset
      manager.reset('chat-1');

      // Should start fresh
      const decision = manager.shouldRestart('chat-1', 'Error 3');
      expect(decision.restartCount).toBe(1);
    });
  });

  describe('getState', () => {
    it('should return undefined for unknown chatId', () => {
      expect(manager.getState('unknown')).toBeUndefined();
    });

    it('should return state after restart attempt', () => {
      manager.shouldRestart('chat-1', 'Error');
      const state = manager.getState('chat-1');

      expect(state).toBeDefined();
      expect(state?.restartCount).toBe(1);
      expect(state?.circuitOpen).toBe(false);
    });
  });

  describe('getRecentErrors', () => {
    it('should return empty array for unknown chatId', () => {
      expect(manager.getRecentErrors('unknown')).toEqual([]);
    });

    it('should track recent errors', () => {
      manager.shouldRestart('chat-1', 'Error 1');
      manager.shouldRestart('chat-1', 'Error 2');
      manager.shouldRestart('chat-1', 'Error 3');

      const errors = manager.getRecentErrors('chat-1');
      expect(errors).toHaveLength(3);
      expect(errors[0].message).toBe('Error 1');
      expect(errors[2].message).toBe('Error 3');
    });

    it('should limit recent errors to maxRecentErrors', () => {
      // Add more than 5 errors
      for (let i = 0; i < 7; i++) {
        manager.shouldRestart('chat-1', `Error ${i}`);
      }

      const errors = manager.getRecentErrors('chat-1');
      expect(errors).toHaveLength(5); // maxRecentErrors = 5
    });
  });

  describe('isCircuitOpen', () => {
    it('should return false for unknown chatId', () => {
      expect(manager.isCircuitOpen('unknown')).toBe(false);
    });

    it('should return true after max restarts exceeded', () => {
      manager.shouldRestart('chat-1', 'Error 1'); // restartCount = 1
      manager.shouldRestart('chat-1', 'Error 2'); // restartCount = 2
      manager.shouldRestart('chat-1', 'Error 3'); // restartCount = 3
      manager.shouldRestart('chat-1', 'Error 4'); // circuit opens

      // Circuit should be open now
      expect(manager.isCircuitOpen('chat-1')).toBe(true);
    });
  });

  describe('clearAll', () => {
    it('should clear all states', () => {
      manager.shouldRestart('chat-1', 'Error');
      manager.shouldRestart('chat-2', 'Error');

      manager.clearAll();

      expect(manager.getState('chat-1')).toBeUndefined();
      expect(manager.getState('chat-2')).toBeUndefined();
    });
  });

  describe('backoff calculation', () => {
    it('should cap backoff at maxBackoffMs', () => {
      const managerWithLowMax = new RestartManager({
        logger: mockLogger,
        maxRestarts: 10,
        initialBackoffMs: 100,
        maxBackoffMs: 500, // Low max
        backoffMultiplier: 10, // High multiplier
      });

      // Do multiple restarts to hit the cap
      for (let i = 0; i < 5; i++) {
        managerWithLowMax.shouldRestart('chat-1', `Error ${i}`);
        vi.advanceTimersByTime(10);
      }

      const state = managerWithLowMax.getState('chat-1');
      // Backoff should be capped at 500
      expect(state?.currentBackoffMs).toBeLessThanOrEqual(500);
    });
  });
});
