/**
 * Tests for CompactionManager (Issue #1336).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CompactionManager, type CompactionCallbacks, type TokenUsageStats } from './compaction-manager.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('test');

function createMockCallbacks(overrides?: Partial<CompactionCallbacks>): CompactionCallbacks {
  return {
    getActiveSessions: vi.fn(() => []),
    getTokenUsage: vi.fn(() => undefined),
    isProcessing: vi.fn(() => false),
    compactSession: vi.fn(),
    ...overrides,
  };
}

function createTokenUsage(overrides?: Partial<TokenUsageStats>): TokenUsageStats {
  return {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    lastUpdated: Date.now(),
    turnCount: 1,
    ...overrides,
  };
}

describe('CompactionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should apply default config values', () => {
      const manager = new CompactionManager({ enabled: true }, createMockCallbacks(), logger);
      const config = manager.getConfig();
      expect(config.threshold).toBe(0.80);
      expect(config.strategy).toBe('auto');
      expect(config.maxContextTokens).toBe(180000);
      expect(config.minTokens).toBe(50000);
      expect(config.checkIntervalMinutes).toBe(2);
    });

    it('should apply custom config values', () => {
      const manager = new CompactionManager(
        { enabled: true, threshold: 0.90, strategy: 'reset', maxContextTokens: 100000, minTokens: 10000, checkIntervalMinutes: 5 },
        createMockCallbacks(),
        logger,
      );
      const config = manager.getConfig();
      expect(config.threshold).toBe(0.90);
      expect(config.strategy).toBe('reset');
      expect(config.maxContextTokens).toBe(100000);
      expect(config.minTokens).toBe(10000);
      expect(config.checkIntervalMinutes).toBe(5);
    });
  });

  describe('start / stop', () => {
    it('should start and stop cleanly', async () => {
      const callbacks = createMockCallbacks();
      const manager = new CompactionManager(
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
      const manager = new CompactionManager({ enabled: true }, callbacks, logger);

      await manager.stop();
      manager.start(); // Should warn, not throw

      expect(manager).toBeDefined();
    });

    it('should not start twice', async () => {
      const callbacks = createMockCallbacks();
      const manager = new CompactionManager(
        { enabled: true, checkIntervalMinutes: 1 },
        callbacks,
        logger,
      );

      manager.start();
      manager.start(); // Should warn, not throw

      await manager.stop();
    });

    it('should start but not trigger compaction when strategy is disabled', async () => {
      const callbacks = createMockCallbacks();
      const manager = new CompactionManager(
        { enabled: true, strategy: 'disabled' },
        callbacks,
        logger,
      );

      manager.start(); // Should log warning about disabled strategy
      await manager.stop();
    });
  });

  describe('executeCheck - threshold exceeded', () => {
    it('should compact sessions where input tokens exceed threshold', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2', 'chat-3'],
        getTokenUsage: (chatId: string) => {
          switch (chatId) {
            case 'chat-1': return createTokenUsage({ totalInputTokens: 150000 }); // 150k > 144k (80% of 180k)
            case 'chat-2': return createTokenUsage({ totalInputTokens: 100000 }); // 100k < 144k
            case 'chat-3': return createTokenUsage({ totalInputTokens: 180000 }); // 180k >= 144k
            default: return undefined;
          }
        },
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000, minTokens: 0 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result).not.toBeNull();
      expect(result!.compacted).toEqual(['chat-1', 'chat-3']);
      expect(result!.processingSkipped).toEqual([]);
      expect(callbacks.compactSession).toHaveBeenCalledTimes(2);
    });

    it('should not compact sessions below threshold', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
        getTokenUsage: () => createTokenUsage({ totalInputTokens: 100000 }), // Below 144k
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000, minTokens: 0 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.compacted).toEqual([]);
      expect(callbacks.compactSession).not.toHaveBeenCalled();
    });

    it('should not compact sessions below minimum token threshold', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
        getTokenUsage: () => createTokenUsage({ totalInputTokens: 30000 }), // Below minTokens (50000)
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000, minTokens: 50000 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.compacted).toEqual([]);
      expect(result!.belowMinimum).toEqual(['chat-1']);
      expect(callbacks.compactSession).not.toHaveBeenCalled();
    });

    it('should skip sessions that are actively processing', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2'],
        getTokenUsage: () => createTokenUsage({ totalInputTokens: 150000 }),
        isProcessing: (chatId: string) => chatId === 'chat-1',
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000, minTokens: 0 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.compacted).toEqual(['chat-2']);
      expect(result!.processingSkipped).toEqual(['chat-1']);
      expect(callbacks.compactSession).toHaveBeenCalledTimes(1);
    });

    it('should skip sessions with unknown token usage', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
        getTokenUsage: () => undefined,
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.compacted).toEqual([]);
      expect(callbacks.compactSession).not.toHaveBeenCalled();
    });

    it('should handle empty session list', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => [],
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.compacted).toEqual([]);
      expect(result!.belowMinimum).toEqual([]);
      expect(result!.processingSkipped).toEqual([]);
    });
  });

  describe('executeCheck - disabled strategy', () => {
    it('should not compact when strategy is disabled', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
        getTokenUsage: () => createTokenUsage({ totalInputTokens: 200000 }),
      });

      const manager = new CompactionManager(
        { enabled: true, strategy: 'disabled', threshold: 0.80, maxContextTokens: 180000, minTokens: 0 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.compacted).toEqual([]);
      expect(callbacks.compactSession).not.toHaveBeenCalled();
    });
  });

  describe('executeCheck - custom threshold and maxContextTokens', () => {
    it('should use custom threshold correctly', async () => {
      // 90% of 100000 = 90000
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2'],
        getTokenUsage: (chatId: string) => {
          switch (chatId) {
            case 'chat-1': return createTokenUsage({ totalInputTokens: 85000 }); // Below 90k
            case 'chat-2': return createTokenUsage({ totalInputTokens: 95000 }); // Above 90k
            default: return undefined;
          }
        },
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.90, maxContextTokens: 100000, minTokens: 0 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.compacted).toEqual(['chat-2']);
      expect(callbacks.compactSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrency guard', () => {
    it('should skip check if one is already running', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000 },
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
        getTokenUsage: () => createTokenUsage({ totalInputTokens: 200000 }),
        compactSession: vi.fn(),
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000 },
        callbacks,
        logger,
      );

      const checkPromise = manager.runCheck();
      const stopPromise = manager.stop();

      await Promise.all([checkPromise, stopPromise]);
      expect(callbacks.compactSession).toHaveBeenCalled();
    });
  });

  describe('checkNow', () => {
    it('should delegate to runCheck', async () => {
      const callbacks = createMockCallbacks();
      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result).not.toBeNull();
    });
  });

  describe('compactSession callback error handling', () => {
    it('should log error but not throw when compactSession callback fails', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
        getTokenUsage: () => createTokenUsage({ totalInputTokens: 200000 }),
        compactSession: vi.fn((_chatId: string, _reason: string, _usage: TokenUsageStats) => {
          throw new Error('Compaction failed');
        }),
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000, minTokens: 0 },
        callbacks,
        logger,
      );

      // Should not throw
      const result = await manager.checkNow();
      expect(result!.compacted).toEqual(['chat-1']);
    });
  });

  describe('combined scenarios', () => {
    it('should handle mixed scenario: some processing, some below minimum, some over threshold', async () => {
      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1', 'chat-2', 'chat-3', 'chat-4'],
        getTokenUsage: (chatId: string) => {
          switch (chatId) {
            case 'chat-1': return createTokenUsage({ totalInputTokens: 150000 }); // Over threshold
            case 'chat-2': return createTokenUsage({ totalInputTokens: 30000 });  // Below minimum
            case 'chat-3': return createTokenUsage({ totalInputTokens: 160000 }); // Over threshold, but processing
            case 'chat-4': return createTokenUsage({ totalInputTokens: 100000 }); // Below threshold
            default: return undefined;
          }
        },
        isProcessing: (chatId: string) => chatId === 'chat-3',
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000, minTokens: 50000 },
        callbacks,
        logger,
      );

      const result = await manager.checkNow();
      expect(result!.compacted).toEqual(['chat-1']);
      expect(result!.belowMinimum).toEqual(['chat-2']);
      expect(result!.processingSkipped).toEqual(['chat-3']);
      expect(callbacks.compactSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('compaction callback receives usage stats', () => {
    it('should pass token usage stats to compactSession callback', async () => {
      const usage = createTokenUsage({
        totalInputTokens: 150000,
        totalOutputTokens: 30000,
        turnCount: 15,
      });

      const callbacks = createMockCallbacks({
        getActiveSessions: () => ['chat-1'],
        getTokenUsage: () => usage,
      });

      const manager = new CompactionManager(
        { enabled: true, threshold: 0.80, maxContextTokens: 180000, minTokens: 0 },
        callbacks,
        logger,
      );

      await manager.checkNow();
      expect(callbacks.compactSession).toHaveBeenCalledWith(
        'chat-1',
        expect.stringContaining('150000'),
        usage,
      );
    });
  });
});
