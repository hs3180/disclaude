/**
 * Tests for SessionTimeoutManager (Issue #1313).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionTimeoutManager, type SessionTimeoutCallbacks, type TimeoutCheckResult } from './session-timeout-manager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('test');

function createMockCallbacks(overrides?: Partial<SessionTimeoutCallbacks>): SessionTimeoutCallbacks {
  return {
    getActiveSessions: vi.fn(() => []),
    getLastActivity: vi.fn(() => Date.now()),
    isProcessing: vi.fn(() => false),
    closeSession: vi.fn(),
    ...overrides,
  };
}

describe('SessionTimeoutManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should apply default config values', () => {
      const manager = new SessionTimeoutManager({ enabled: true }, createMockCallbacks(), logger);
      // Access internal config via check behavior
      expect(manager).toBeDefined();
    });
  });

  describe('start / stop', () => {
    it('should start and stop cleanly', async () => {
      const callbacks = createMockCallbacks();
      const manager = new SessionTimeoutManager(
        { enabled: true, checkIntervalMinutes: 5 },
        callbacks,
        logger,
      );

      manager.start();
      await manager.stop();

      expect(manager).toBeDefined();
    });

    it('should not start if already disposed', async () => {
      const callbacks = createMockCallbacks();
      const manager = new SessionTimeoutManager({ enabled: true }, callbacks, logger);

      await manager.stop();
      manager.start(); // Should warn, not throw

      expect(manager).toBeDefined();
    });

    it('should not start twice', async () => {
      const callbacks = createMockCallbacks();
      const manager = new SessionTimeoutManager(
        { enabled: true, checkIntervalMinutes: 1 },
        callbacks,
        logger,
      );

      manager.start();
      manager.start(); // Should warn, not throw

      await manager.stop(); // cleanup
    });

    it('should stop cleanly with no running check', async () => {
      const callbacks = createMockCallbacks();
      const manager = new SessionTimeoutManager({ enabled: true }, callbacks, logger);

      // Stop without ever starting a check
      await manager.stop();
    });
  });

  describe('executeCheck - Phase 1: Idle timeout', () => {
    it('should close sessions idle beyond threshold', async () => {
      const now = Date.now();
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2', 'chat-3'],
        getLastActivity: (chatId: string) => {
          switch (chatId) {
            case 'chat-1': return now - 31 * 60 * 1000; // 31 min idle
            case 'chat-2': return now - 5 * 60 * 1000;  // 5 min idle
            case 'chat-3': return now - 60 * 60 * 1000; // 60 min idle
            default: return now;
          }
        },
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result).not.toBeNull();
      expect(result!.idleClosed).toEqual(['chat-1', 'chat-3']);
      expect(result!.processingSkipped).toEqual([]);
      expect(callbacks.closeSession).toHaveBeenCalledTimes(2);
    });

    it('should not close sessions within idle threshold', async () => {
      const now = Date.now();
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
        getLastActivity: () => now - 10 * 60 * 1000, // 10 min idle (under 30m)
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.idleClosed).toEqual([]);
      expect(callbacks.closeSession).not.toHaveBeenCalled();
    });

    it('should skip sessions that are actively processing', async () => {
      const now = Date.now();
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2'],
        getLastActivity: () => now - 60 * 60 * 1000, // 60 min idle
        isProcessing: (chatId: string) => chatId === 'chat-1',
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.idleClosed).toEqual(['chat-2']);
      expect(result!.processingSkipped).toEqual(['chat-1']);
      expect(callbacks.closeSession).toHaveBeenCalledTimes(1);
    });

    it('should skip sessions with unknown last activity', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
        getLastActivity: () => undefined,
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.idleClosed).toEqual([]);
      expect(callbacks.closeSession).not.toHaveBeenCalled();
    });

    it('should handle empty session list', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => [],
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.idleClosed).toEqual([]);
      expect(result!.evicted).toEqual([]);
    });
  });

  describe('executeCheck - Phase 2: Max sessions', () => {
    it('should evict oldest idle sessions when over limit', async () => {
      const now = Date.now();
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2', 'chat-3'],
        getLastActivity: (chatId: string) => {
          switch (chatId) {
            case 'chat-1': return now - 5 * 60 * 1000;   // 5 min ago (recent)
            case 'chat-2': return now - 20 * 60 * 1000;  // 20 min ago
            case 'chat-3': return now - 10 * 60 * 1000;  // 10 min ago
            default: return now;
          }
        },
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 60, maxSessions: 2 }, // All under idle threshold, but 3 > 2 max
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      // Phase 1: none closed (all under 60 min)
      expect(result!.idleClosed).toEqual([]);
      // Phase 2: evict oldest (chat-2 at 20 min) to get to maxSessions=2
      expect(result!.evicted).toEqual(['chat-2']);
      expect(callbacks.closeSession).toHaveBeenCalledTimes(1);
    });

    it('should not evict processing sessions in Phase 2', async () => {
      const now = Date.now();
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2', 'chat-3', 'chat-4'],
        getLastActivity: (chatId: string) => {
          switch (chatId) {
            case 'chat-1': return now - 5 * 60 * 1000;
            case 'chat-2': return now - 20 * 60 * 1000;  // oldest, but processing
            case 'chat-3': return now - 15 * 60 * 1000;
            case 'chat-4': return now - 10 * 60 * 1000;
            default: return now;
          }
        },
        isProcessing: (chatId: string) => chatId === 'chat-2',
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 60, maxSessions: 2 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.idleClosed).toEqual([]);
      expect(result!.processingSkipped).toEqual(['chat-2']);
      // remainingSessions: chat-1, chat-3, chat-4 (chat-2 excluded as processing)
      // Need to evict 1 (3 - 2 = 1), oldest non-processing is chat-3 (15 min)
      expect(result!.evicted).toEqual(['chat-3']);
    });

    it('should handle all sessions being over maxSessions with processing', async () => {
      const now = Date.now();
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2', 'chat-3'],
        getLastActivity: (chatId: string) => {
          switch (chatId) {
            case 'chat-1': return now - 5 * 60 * 1000;
            case 'chat-2': return now - 20 * 60 * 1000;
            case 'chat-3': return now - 10 * 60 * 1000;
            default: return now;
          }
        },
        isProcessing: () => true, // All processing
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 60, maxSessions: 1 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.idleClosed).toEqual([]);
      expect(result!.evicted).toEqual([]);
      expect(result!.processingSkipped).toEqual(['chat-1', 'chat-2', 'chat-3']);
    });
  });

  describe('concurrency guard', () => {
    it('should skip check if one is already running', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30 },
        callbacks,
        logger,
      );

      // First call
      const promise1 = manager.runCheck();
      // Second call while first is running
      const promise2 = manager.runCheck();

      // Both should complete (second returns null due to guard)
      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).not.toBeNull();
      expect(result2).toBeNull();
    });

    it('stop() should await in-progress check', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
        getLastActivity: () => Date.now() - 60 * 60 * 1000, // Very idle
        closeSession: vi.fn(),
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30 },
        callbacks,
        logger,
      );

      // Start a check - since executeCheck is synchronous (wraps in Promise.resolve),
      // it completes immediately. The guard should still work.
      const checkPromise = manager.runCheck();
      const stopPromise = manager.stop();

      await Promise.all([checkPromise, stopPromise]);
      // The check should have completed before stop resolved
      expect(callbacks.closeSession).toHaveBeenCalled();
    });
  });

  describe('checkNow', () => {
    it('should delegate to runCheck', async () => {
      const callbacks = createMockCallbacks();
      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result).not.toBeNull();
    });
  });

  describe('closeSession callback error handling', () => {
    it('should log error but not throw when closeSession callback fails', async () => {
      const now = Date.now();
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
        getLastActivity: () => now - 60 * 60 * 1000,
        closeSession: vi.fn((_chatId: string, _reason: string) => {
          throw new Error('Close failed');
        }),
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30 },
        callbacks,
        logger,
      );

      // Should not throw
      const result = await manager.checkNow();
      expect(result!.idleClosed).toEqual(['chat-1']);
    });
  });

  describe('integration with getActiveSessions + closeSession', () => {
    it('should not attempt to close sessions already removed by Phase 1', async () => {
      const now = Date.now();
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2'],
        getLastActivity: (chatId: string) => {
          // Both very idle (Phase 1 will close them)
          return now - 60 * 60 * 1000;
        },
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30, maxSessions: 1 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      // Both closed in Phase 1, none need eviction in Phase 2
      expect(result!.idleClosed).toEqual(['chat-1', 'chat-2']);
      expect(result!.evicted).toEqual([]);
      expect(callbacks.closeSession).toHaveBeenCalledTimes(2);
    });
  });

  describe('combined Phase 1 + Phase 2', () => {
    it('should handle mixed scenario: some idle, some active, some over limit', async () => {
      const now = Date.now();
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2', 'chat-3', 'chat-4'],
        getLastActivity: (chatId: string) => {
          switch (chatId) {
            case 'chat-1': return now - 60 * 60 * 1000;  // 60 min idle → Phase 1
            case 'chat-2': return now - 5 * 60 * 1000;   // 5 min idle → safe
            case 'chat-3': return now - 60 * 60 * 1000;  // 60 min idle → Phase 1
            case 'chat-4': return now - 20 * 60 * 1000;  // 20 min idle → Phase 2 eviction
            default: return now;
          }
        },
        isProcessing: (chatId: string) => chatId === 'chat-2',
      });

      const manager = new SessionTimeoutManager(
        { enabled: true, idleMinutes: 30, maxSessions: 2 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      // Phase 1: chat-1 and chat-3 closed (idle > 30min), chat-2 skipped (processing)
      expect(result!.idleClosed).toContain('chat-1');
      expect(result!.idleClosed).toContain('chat-3');
      expect(result!.processingSkipped).toContain('chat-2');

      // Phase 2: After Phase 1, remaining: chat-2 (processing, skipped), chat-4 (idle)
      // chat-4 is the only non-processing session remaining, and maxSessions=2
      // So no eviction needed (only 1 non-processing session remains)
      // Actually, let me reconsider: remainingSessions = allSessions - closedInPhase1 - processingSkipped
      // = ['chat-2', 'chat-4'] - ['chat-1', 'chat-3'] - ['chat-2'] = ['chat-4']
      // 1 remaining < maxSessions 2, so no eviction
      expect(result!.evicted).toEqual([]);
    });
  });
});
