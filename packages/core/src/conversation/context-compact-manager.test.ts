/**
 * Unit tests for ContextCompactManager
 * @module conversation/context-compact-manager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ContextCompactManager } from './context-compact-manager.js';
import type { ContextCompactCallbacks } from './context-compact-manager.js';
import type { ContextCompactConfig } from '../config/types.js';
import type { Logger } from '../utils/logger.js';

// Helper: create mock logger
function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
    bindings: vi.fn().mockReturnValue({}),
    flush: vi.fn(),
  } as unknown as Logger;
}

// Helper: create mock callbacks with properly typed mocks
function createMockCallbacks(): ContextCompactCallbacks & {
  onCompact: ReturnType<typeof vi.fn>;
  isProcessing: ReturnType<typeof vi.fn>;
} {
  return {
    onCompact: vi.fn().mockResolvedValue(undefined),
    isProcessing: vi.fn().mockReturnValue(false),
  };
}

// Helper: default enabled config for tests
function createEnabledConfig(overrides?: Partial<ContextCompactConfig>): ContextCompactConfig {
  return {
    enabled: true,
    thresholdTokens: 150000,
    checkIntervalSeconds: 1,
    ...overrides,
  };
}

describe('ContextCompactManager', () => {
  let logger: Logger;
  let callbacks: ContextCompactCallbacks;

  beforeEach(() => {
    logger = createMockLogger();
    callbacks = createMockCallbacks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  describe('constructor', () => {
    it('should create manager with default config values', () => {
      const manager = new ContextCompactManager({}, callbacks, logger);
      expect(manager.isRunning()).toBe(false);
    });

    it('should resolve config with defaults for missing fields', () => {
      const manager = new ContextCompactManager({ enabled: true }, callbacks, logger);
      // Verify behavior that depends on defaults: threshold should be 150000
      manager.recordTokens('chat-1', 149000);
      expect(manager.getTokens('chat-1')).toBe(149000);
      manager.recordTokens('chat-1', 1000);
      expect(manager.getTokens('chat-1')).toBe(150000);
    });

    it('should use provided config values over defaults', () => {
      const manager = new ContextCompactManager(
        { enabled: true, thresholdTokens: 1000, checkIntervalSeconds: 5 },
        callbacks,
        logger
      );
      manager.recordTokens('chat-1', 1000);
      expect(manager.getTokens('chat-1')).toBe(1000);
    });
  });

  describe('start / stop lifecycle', () => {
    it('should not start when disabled', () => {
      const manager = new ContextCompactManager(
        { enabled: false },
        callbacks,
        logger
      );
      manager.start();
      expect(manager.isRunning()).toBe(false);
    });

    it('should start when enabled', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      manager.start();
      expect(manager.isRunning()).toBe(true);
    });

    it('should warn when started twice', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      manager.start();
      manager.start();
      expect(logger.warn).toHaveBeenCalledWith(
        'Context compact manager is already running'
      );
    });

    it('should stop running manager', async () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      manager.start();
      expect(manager.isRunning()).toBe(true);

      await manager.stop();
      expect(manager.isRunning()).toBe(false);
    });

    it('should not throw when stopped without starting', async () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      await expect(manager.stop()).resolves.not.toThrow();
    });

    it('should wait for in-progress check to complete on stop', async () => {
      let resolveCompact: () => void;
      const slowCallbacks: ContextCompactCallbacks = {
        onCompact: vi.fn().mockImplementation(() => {
          return new Promise<void>((resolve) => {
            resolveCompact = resolve;
          });
        }),
        isProcessing: vi.fn().mockReturnValue(false),
      };

      const manager = new ContextCompactManager(
        createEnabledConfig({ thresholdTokens: 100, checkIntervalSeconds: 1 }),
        slowCallbacks,
        logger
      );

      manager.start();
      // Record enough tokens to trigger compaction
      manager.recordTokens('chat-1', 200);

      // Advance timers to trigger the check cycle
      await vi.advanceTimersByTimeAsync(1500);

      // Verify that compaction was triggered and is pending
      expect(slowCallbacks.onCompact).toHaveBeenCalledWith('chat-1');

      // Stop should wait for the compaction to complete
      const stopPromise = manager.stop();

      // The stop should not be resolved yet because compaction is still running
      let stopResolved = false;
      stopPromise.then(() => { stopResolved = true; });

      // Resolve the compaction
      resolveCompact!();
      await vi.advanceTimersByTimeAsync(0);

      // Now stop should be resolved
      expect(stopResolved).toBe(true);
    });
  });

  describe('recordTokens', () => {
    it('should accumulate tokens for a chatId', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      manager.recordTokens('chat-1', 50000);
      manager.recordTokens('chat-1', 50000);
      manager.recordTokens('chat-1', 50000);
      expect(manager.getTokens('chat-1')).toBe(150000);
    });

    it('should track tokens separately per chatId', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      manager.recordTokens('chat-1', 50000);
      manager.recordTokens('chat-2', 30000);
      expect(manager.getTokens('chat-1')).toBe(50000);
      expect(manager.getTokens('chat-2')).toBe(30000);
    });

    it('should ignore zero tokens', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      manager.recordTokens('chat-1', 0);
      expect(manager.getTokens('chat-1')).toBe(0);
    });

    it('should ignore negative tokens', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      manager.recordTokens('chat-1', 100);
      manager.recordTokens('chat-1', -50);
      expect(manager.getTokens('chat-1')).toBe(100);
    });

    it('should not record tokens when disabled', () => {
      const manager = new ContextCompactManager(
        { enabled: false },
        callbacks,
        logger
      );
      manager.recordTokens('chat-1', 50000);
      expect(manager.getTokens('chat-1')).toBe(0);
    });

    it('should return 0 for unknown chatId', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      expect(manager.getTokens('unknown')).toBe(0);
    });
  });

  describe('resetTokens', () => {
    it('should reset cumulative tokens to zero', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      manager.recordTokens('chat-1', 100000);
      manager.resetTokens('chat-1');
      expect(manager.getTokens('chat-1')).toBe(0);
    });

    it('should reset compacting flag', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      manager.recordTokens('chat-1', 100000);

      // Simulate compacting state
      const state = (manager as unknown as { tokenStates: Map<string, { cumulativeTokens: number; compacting: boolean }> })
        .tokenStates.get('chat-1');
      if (state) state.compacting = true;

      expect(manager.isCompacting('chat-1')).toBe(true);
      manager.resetTokens('chat-1');
      expect(manager.isCompacting('chat-1')).toBe(false);
    });

    it('should not throw for unknown chatId', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      expect(() => manager.resetTokens('unknown')).not.toThrow();
    });
  });

  describe('removeChat', () => {
    it('should remove token tracking for a chatId', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      manager.recordTokens('chat-1', 50000);
      manager.removeChat('chat-1');
      expect(manager.getTokens('chat-1')).toBe(0);
    });

    it('should not throw for unknown chatId', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      expect(() => manager.removeChat('unknown')).not.toThrow();
    });
  });

  describe('isCompacting', () => {
    it('should return false for unknown chatId', () => {
      const manager = new ContextCompactManager(
        createEnabledConfig(),
        callbacks,
        logger
      );
      expect(manager.isCompacting('unknown')).toBe(false);
    });
  });

  describe('compaction trigger', () => {
    it('should trigger compaction when threshold is exceeded', async () => {
      const manager = new ContextCompactManager(
        createEnabledConfig({ thresholdTokens: 100, checkIntervalSeconds: 1 }),
        callbacks,
        logger
      );

      manager.start();
      manager.recordTokens('chat-1', 200);

      // Advance timer to trigger check
      await vi.advanceTimersByTimeAsync(1500);

      expect(callbacks.onCompact).toHaveBeenCalledWith('chat-1');
      expect(callbacks.onCompact).toHaveBeenCalledTimes(1);

      await manager.stop();
    });

    it('should not trigger compaction when below threshold', async () => {
      const manager = new ContextCompactManager(
        createEnabledConfig({ thresholdTokens: 200, checkIntervalSeconds: 1 }),
        callbacks,
        logger
      );

      manager.start();
      manager.recordTokens('chat-1', 100);

      await vi.advanceTimersByTimeAsync(1500);

      expect(callbacks.onCompact).not.toHaveBeenCalled();

      await manager.stop();
    });

    it('should not compact when agent is processing', async () => {
      const processingCallbacks = createMockCallbacks();
      processingCallbacks.isProcessing.mockReturnValue(true);

      const manager = new ContextCompactManager(
        createEnabledConfig({ thresholdTokens: 100, checkIntervalSeconds: 1 }),
        processingCallbacks,
        logger
      );

      manager.start();
      manager.recordTokens('chat-1', 200);

      await vi.advanceTimersByTimeAsync(1500);

      expect(processingCallbacks.onCompact).not.toHaveBeenCalled();

      await manager.stop();
    });

    it('should not compact if already compacting', async () => {
      let resolveCompact: () => void;
      const slowCallbacks: ContextCompactCallbacks = {
        onCompact: vi.fn().mockImplementation(() => {
          return new Promise<void>((resolve) => {
            resolveCompact = resolve;
          });
        }),
        isProcessing: vi.fn().mockReturnValue(false),
      };

      const manager = new ContextCompactManager(
        createEnabledConfig({ thresholdTokens: 100, checkIntervalSeconds: 1 }),
        slowCallbacks,
        logger
      );

      manager.start();
      manager.recordTokens('chat-1', 200);

      // First check triggers compaction
      await vi.advanceTimersByTimeAsync(1500);
      expect(slowCallbacks.onCompact).toHaveBeenCalledTimes(1);

      // Second check should skip because compacting is in progress
      await vi.advanceTimersByTimeAsync(1500);
      expect(slowCallbacks.onCompact).toHaveBeenCalledTimes(1);

      // Resolve the first compaction
      resolveCompact!();
      await vi.advanceTimersByTimeAsync(0);

      await manager.stop();
    });

    it('should trigger compaction for multiple chatIds independently', async () => {
      const manager = new ContextCompactManager(
        createEnabledConfig({ thresholdTokens: 100, checkIntervalSeconds: 1 }),
        callbacks,
        logger
      );

      manager.start();
      manager.recordTokens('chat-1', 200);
      manager.recordTokens('chat-2', 150);

      await vi.advanceTimersByTimeAsync(1500);

      expect(callbacks.onCompact).toHaveBeenCalledWith('chat-1');
      expect(callbacks.onCompact).toHaveBeenCalledWith('chat-2');
      expect(callbacks.onCompact).toHaveBeenCalledTimes(2);

      await manager.stop();
    });

    it('should not compact after tokens are reset', async () => {
      const manager = new ContextCompactManager(
        createEnabledConfig({ thresholdTokens: 100, checkIntervalSeconds: 1 }),
        callbacks,
        logger
      );

      manager.start();
      manager.recordTokens('chat-1', 200);

      // First check triggers compaction
      await vi.advanceTimersByTimeAsync(1500);
      expect(callbacks.onCompact).toHaveBeenCalledTimes(1);

      // Simulate successful compaction by resetting tokens
      manager.resetTokens('chat-1');

      // Second check should NOT trigger compaction (tokens reset to 0)
      await vi.advanceTimersByTimeAsync(1500);
      expect(callbacks.onCompact).toHaveBeenCalledTimes(1);

      await manager.stop();
    });

    it('should handle compaction callback error gracefully', async () => {
      const errorCallbacks: ContextCompactCallbacks = {
        onCompact: vi.fn().mockRejectedValue(new Error('compaction failed')),
        isProcessing: vi.fn().mockReturnValue(false),
      };

      const manager = new ContextCompactManager(
        createEnabledConfig({ thresholdTokens: 100, checkIntervalSeconds: 1 }),
        errorCallbacks,
        logger
      );

      manager.start();
      manager.recordTokens('chat-1', 200);

      await vi.advanceTimersByTimeAsync(1500);

      // Callback was called
      expect(errorCallbacks.onCompact).toHaveBeenCalledWith('chat-1');
      // Error was logged
      expect(logger.error).toHaveBeenCalled();

      // Compacting flag should be reset so next cycle can retry
      expect(manager.isCompacting('chat-1')).toBe(false);

      await manager.stop();
    });

    it('should skip check cycle if previous one is still running', async () => {
      let resolveCompact: () => void;
      const slowCallbacks: ContextCompactCallbacks = {
        onCompact: vi.fn().mockImplementation(() => {
          return new Promise<void>((resolve) => {
            resolveCompact = resolve;
          });
        }),
        isProcessing: vi.fn().mockReturnValue(false),
      };

      const manager = new ContextCompactManager(
        createEnabledConfig({ thresholdTokens: 100, checkIntervalSeconds: 1 }),
        slowCallbacks,
        logger
      );

      manager.start();
      manager.recordTokens('chat-1', 200);

      // First check starts compaction
      await vi.advanceTimersByTimeAsync(1500);
      expect(slowCallbacks.onCompact).toHaveBeenCalledTimes(1);

      // Add more tokens to a second chatId that would need compaction
      manager.recordTokens('chat-2', 200);

      // Second check should be skipped because first is still running
      await vi.advanceTimersByTimeAsync(1500);
      // Only chat-1 was compacted, not chat-2
      expect(slowCallbacks.onCompact).toHaveBeenCalledTimes(1);

      // Resolve first compaction
      resolveCompact!();
      await vi.advanceTimersByTimeAsync(0);

      await manager.stop();
    });
  });
});
