/**
 * Unit tests for CompactionManager
 * @see Issue #1336
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CompactionManager, DEFAULT_COMPACTION_CONFIG } from './compaction-manager.js';
import { createLogger } from '../utils/logger.js';

describe('CompactionManager', () => {
  let manager: CompactionManager;
  let logger: ReturnType<typeof createLogger>;

  const defaultConfig = {
    strategy: 'auto' as const,
    threshold: 0.85,
    maxContextTokens: 200000,
  };

  beforeEach(() => {
    logger = createLogger('TestCompactionManager');
    manager = new CompactionManager(defaultConfig, logger);
  });

  describe('constructor', () => {
    it('should create a CompactionManager with config', () => {
      expect(manager).toBeDefined();
      expect(manager.getConfig()).toEqual(defaultConfig);
    });

    it('should create a CompactionManager with logger only (defaults)', () => {
      const defaultManager = new CompactionManager(logger);
      expect(defaultManager).toBeDefined();
      expect(defaultManager.getConfig()).toEqual(DEFAULT_COMPACTION_CONFIG);
    });
  });

  describe('trackUsage', () => {
    it('should track usage for a new session', () => {
      const usage = manager.trackUsage('chat-1', 50000, 1000);

      expect(usage).toBeDefined();
      expect(usage.inputTokens).toBe(50000);
      expect(usage.outputTokens).toBe(1000);
      expect(usage.totalTokens).toBe(51000);
      expect(usage.usageRatio).toBeCloseTo(0.25, 3);
      expect(usage.turnCount).toBe(1);
      expect(usage.compactionCount).toBe(0);
    });

    it('should update usage on subsequent calls', () => {
      manager.trackUsage('chat-1', 50000, 1000);
      const usage = manager.trackUsage('chat-1', 80000, 2000);

      expect(usage.inputTokens).toBe(80000);
      expect(usage.outputTokens).toBe(2000);
      expect(usage.turnCount).toBe(2);
    });

    it('should track independent sessions', () => {
      manager.trackUsage('chat-1', 50000, 1000);
      const usage2 = manager.trackUsage('chat-2', 30000, 500);

      expect(usage2.inputTokens).toBe(30000);
      expect(usage2.turnCount).toBe(1);

      const usage1 = manager.getUsage('chat-1');
      expect(usage1?.inputTokens).toBe(50000);
      expect(usage1?.turnCount).toBe(1);
    });
  });

  describe('getUsage', () => {
    it('should return null for untracked session', () => {
      expect(manager.getUsage('unknown')).toBeNull();
    });

    it('should return current usage for tracked session', () => {
      manager.trackUsage('chat-1', 100000, 5000);
      const usage = manager.getUsage('chat-1');

      expect(usage).not.toBeNull();
      expect(usage!.inputTokens).toBe(100000);
      expect(usage!.totalTokens).toBe(105000);
      expect(usage!.usageRatio).toBeCloseTo(0.5, 3);
    });

    it('should calculate usageRatio correctly', () => {
      manager.trackUsage('chat-1', 170000, 5000);
      const usage = manager.getUsage('chat-1');

      expect(usage!.usageRatio).toBeCloseTo(0.85, 3);
    });

    it('should return usageRatio > 1 when over context limit', () => {
      manager.trackUsage('chat-1', 210000, 5000);
      const usage = manager.getUsage('chat-1');

      expect(usage!.usageRatio).toBeCloseTo(1.05, 3);
    });
  });

  describe('shouldCompact', () => {
    it('should return false for non-auto strategy', () => {
      const sdkManager = new CompactionManager(
        { strategy: 'sdk', threshold: 0.85, maxContextTokens: 200000 },
        logger
      );
      sdkManager.trackUsage('chat-1', 190000, 5000);
      expect(sdkManager.shouldCompact('chat-1')).toBe(false);
    });

    it('should return false when below threshold', () => {
      manager.trackUsage('chat-1', 150000, 5000);
      expect(manager.shouldCompact('chat-1')).toBe(false);
    });

    it('should return true when at threshold', () => {
      manager.trackUsage('chat-1', 170000, 5000);
      expect(manager.shouldCompact('chat-1')).toBe(true);
    });

    it('should return true when above threshold', () => {
      manager.trackUsage('chat-1', 190000, 5000);
      expect(manager.shouldCompact('chat-1')).toBe(true);
    });

    it('should return false for untracked session', () => {
      expect(manager.shouldCompact('unknown')).toBe(false);
    });

    it('should return false when compaction is pending', () => {
      manager.trackUsage('chat-1', 190000, 5000);
      manager.markCompactionPending('chat-1');
      expect(manager.shouldCompact('chat-1')).toBe(false);
    });
  });

  describe('recordCompaction', () => {
    it('should record a framework compaction event', () => {
      manager.trackUsage('chat-1', 190000, 5000);
      manager.recordCompaction('chat-1');

      const usage = manager.getUsage('chat-1');
      expect(usage!.compactionCount).toBe(1);
      expect(usage!.lastCompactionAt).not.toBeNull();
    });

    it('should increment compaction count on multiple compactions', () => {
      manager.trackUsage('chat-1', 190000, 5000);
      manager.recordCompaction('chat-1');
      manager.trackUsage('chat-1', 180000, 3000);
      manager.recordCompaction('chat-1');

      const usage = manager.getUsage('chat-1');
      expect(usage!.compactionCount).toBe(2);
    });
  });

  describe('recordSdkCompaction', () => {
    it('should record an SDK-initiated compaction', () => {
      manager.trackUsage('chat-1', 190000, 5000);
      manager.recordSdkCompaction('chat-1');

      const usage = manager.getUsage('chat-1');
      expect(usage!.compactionCount).toBe(1);
      expect(usage!.lastCompactionAt).not.toBeNull();
    });

    it('should track both framework and SDK compactions', () => {
      manager.trackUsage('chat-1', 190000, 5000);
      manager.recordSdkCompaction('chat-1');
      manager.recordCompaction('chat-1');

      const usage = manager.getUsage('chat-1');
      expect(usage!.compactionCount).toBe(2);
    });
  });

  describe('markCompactionPending', () => {
    it('should prevent shouldCompact from returning true', () => {
      manager.trackUsage('chat-1', 190000, 5000);
      manager.markCompactionPending('chat-1');
      expect(manager.shouldCompact('chat-1')).toBe(false);
    });

    it('should emit compaction_triggered event', () => {
      const listener = vi.fn();
      manager.on('compaction_triggered', listener);

      manager.trackUsage('chat-1', 190000, 5000);
      manager.markCompactionPending('chat-1');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].chatId).toBe('chat-1');
    });
  });

  describe('resetSession', () => {
    it('should clear tracking state for a session', () => {
      manager.trackUsage('chat-1', 190000, 5000);
      manager.recordCompaction('chat-1');
      manager.resetSession('chat-1');

      expect(manager.getUsage('chat-1')).toBeNull();
      expect(manager.hasSession('chat-1')).toBe(false);
    });

    it('should not affect other sessions', () => {
      manager.trackUsage('chat-1', 190000, 5000);
      manager.trackUsage('chat-2', 30000, 1000);
      manager.resetSession('chat-1');

      expect(manager.getUsage('chat-1')).toBeNull();
      expect(manager.getUsage('chat-2')).not.toBeNull();
    });

    it('should handle resetting non-existent session gracefully', () => {
      expect(() => manager.resetSession('unknown')).not.toThrow();
    });
  });

  describe('clearAll', () => {
    it('should clear all session states', () => {
      manager.trackUsage('chat-1', 50000, 1000);
      manager.trackUsage('chat-2', 80000, 2000);
      manager.clearAll();

      expect(manager.getUsage('chat-1')).toBeNull();
      expect(manager.getUsage('chat-2')).toBeNull();
    });
  });

  describe('event system', () => {
    it('should emit usage_updated event on trackUsage', () => {
      const listener = vi.fn();
      manager.on('usage_updated', listener);

      manager.trackUsage('chat-1', 50000, 1000);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].type).toBe('usage_updated');
      expect(listener.mock.calls[0][0].chatId).toBe('chat-1');
    });

    it('should emit threshold_exceeded event when auto strategy exceeds threshold', () => {
      const listener = vi.fn();
      manager.on('threshold_exceeded', listener);

      manager.trackUsage('chat-1', 180000, 5000);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].chatId).toBe('chat-1');
      expect(listener.mock.calls[0][0].data?.threshold).toBe(0.85);
    });

    it('should NOT emit threshold_exceeded event when below threshold', () => {
      const listener = vi.fn();
      manager.on('threshold_exceeded', listener);

      manager.trackUsage('chat-1', 100000, 5000);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should NOT emit threshold_exceeded event for non-auto strategy', () => {
      const sdkManager = new CompactionManager(
        { strategy: 'sdk', threshold: 0.85, maxContextTokens: 200000 },
        logger
      );
      const listener = vi.fn();
      sdkManager.on('threshold_exceeded', listener);

      sdkManager.trackUsage('chat-1', 190000, 5000);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should emit events to wildcard listeners', () => {
      const listener = vi.fn();
      manager.on('*', listener);

      manager.trackUsage('chat-1', 50000, 1000);
      manager.recordCompaction('chat-1');

      // usage_updated + compaction_completed = 2 events
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('should support off() to remove listeners', () => {
      const listener = vi.fn();
      manager.on('usage_updated', listener);

      manager.trackUsage('chat-1', 50000, 1000);
      expect(listener).toHaveBeenCalledTimes(1);

      manager.off('usage_updated', listener);
      manager.trackUsage('chat-1', 60000, 1000);
      expect(listener).toHaveBeenCalledTimes(1); // No new calls
    });

    it('should emit sdk_compaction_detected on recordSdkCompaction', () => {
      const listener = vi.fn();
      manager.on('sdk_compaction_detected', listener);

      manager.trackUsage('chat-1', 190000, 5000);
      manager.recordSdkCompaction('chat-1');

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].type).toBe('sdk_compaction_detected');
    });

    it('should handle listener errors gracefully', () => {
      const badListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      manager.on('usage_updated', badListener);

      // Should not throw even if listener throws
      expect(() => manager.trackUsage('chat-1', 50000, 1000)).not.toThrow();
    });
  });

  describe('hasSession', () => {
    it('should return true for tracked session', () => {
      manager.trackUsage('chat-1', 50000, 1000);
      expect(manager.hasSession('chat-1')).toBe(true);
    });

    it('should return false for untracked session', () => {
      expect(manager.hasSession('unknown')).toBe(false);
    });
  });

  describe('getConfig', () => {
    it('should return the resolved config', () => {
      const config = manager.getConfig();
      expect(config.strategy).toBe('auto');
      expect(config.threshold).toBe(0.85);
      expect(config.maxContextTokens).toBe(200000);
    });
  });

  describe('disabled strategy', () => {
    it('should never trigger compaction when disabled', () => {
      const disabledManager = new CompactionManager(
        { strategy: 'disabled', threshold: 0.85, maxContextTokens: 200000 },
        logger
      );
      disabledManager.trackUsage('chat-1', 210000, 5000);
      expect(disabledManager.shouldCompact('chat-1')).toBe(false);
    });
  });

  describe('custom maxContextTokens', () => {
    it('should calculate usage ratio based on custom maxContextTokens', () => {
      const customManager = new CompactionManager(
        { strategy: 'auto', threshold: 0.85, maxContextTokens: 100000 },
        logger
      );
      customManager.trackUsage('chat-1', 85000, 5000);
      expect(customManager.shouldCompact('chat-1')).toBe(true);
    });
  });

  describe('compaction pending debounce', () => {
    it('should allow compaction after recordCompaction clears pending', () => {
      manager.trackUsage('chat-1', 190000, 5000);
      manager.markCompactionPending('chat-1');
      expect(manager.shouldCompact('chat-1')).toBe(false);

      // After recording compaction, pending should be cleared
      manager.recordCompaction('chat-1');
      // But shouldCompact depends on current usage vs threshold
      // After recordCompaction, the state is still the same usage
      // so it should still return true since pending is now false
      expect(manager.shouldCompact('chat-1')).toBe(true);
    });
  });
});
