/**
 * Unit tests for ChatHistoryLoader
 *
 * Issue #1617 Phase 3: Tests for worker-node agent modules.
 *
 * Covers:
 * - Persisted history loading (success, empty, error, truncation)
 * - First message history loading (success, empty, error)
 * - Promise deduplication (concurrent loads)
 * - Accessors (getPersistedContext, isHistoryLoaded, etc.)
 * - consumeFirstMessageContext (single-use consumption)
 * - clearAll state reset
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatHistoryLoader, type HistoryLoaderCallbacks } from './chat-history-loader.js';
import type { Logger } from 'pino';

// Create a mock logger
function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => createMockLogger()),
    level: 'info',
  } as unknown as Logger;
}

describe('ChatHistoryLoader', () => {
  let loader: ChatHistoryLoader;
  let logger: Logger;
  let callbacks: HistoryLoaderCallbacks;

  const defaultSessionConfig = {
    historyDays: 7,
    maxContextLength: 4000,
  };

  beforeEach(() => {
    logger = createMockLogger();
    loader = new ChatHistoryLoader('chat-test-123', logger);
    callbacks = {
      getChatHistory: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
  });

  // =========================================================================
  // Persisted History Loading
  // =========================================================================

  describe('loadPersistedHistory', () => {
    it('should load persisted history when available', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue(
        'User: Hello\nAgent: Hi there!',
      );

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.getPersistedContext()).toBe('User: Hello\nAgent: Hi there!');
      expect(loader.isHistoryLoaded()).toBe(true);
    });

    it('should handle empty history response', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue('');

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.getPersistedContext()).toBeUndefined();
      expect(loader.isHistoryLoaded()).toBe(true);
    });

    it('should handle whitespace-only history as empty', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue('   \n  \t  ');

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.getPersistedContext()).toBeUndefined();
      expect(loader.isHistoryLoaded()).toBe(true);
    });

    it('should handle undefined history response', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.getPersistedContext()).toBeUndefined();
      expect(loader.isHistoryLoaded()).toBe(true);
    });

    it('should truncate history exceeding maxContextLength', async () => {
      const longHistory = 'A'.repeat(5000);
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue(longHistory);

      await loader.loadPersistedHistory(callbacks, {
        ...defaultSessionConfig,
        maxContextLength: 1000,
      });

      const context = loader.getPersistedContext();
      expect(context).toBeDefined();
      expect(context!.length).toBe(1000);
      // Should keep the LAST 1000 characters (most recent)
      expect(context).toBe('A'.repeat(1000));
    });

    it('should not truncate history within maxContextLength', async () => {
      const history = 'A'.repeat(500);
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue(history);

      await loader.loadPersistedHistory(callbacks, {
        ...defaultSessionConfig,
        maxContextLength: 1000,
      });

      expect(loader.getPersistedContext()).toBe(history);
      expect(loader.getPersistedContext()!.length).toBe(500);
    });

    it('should notify user on load failure', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Database connection failed'),
      );

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'chat-test-123',
        expect.stringContaining('加载历史记录失败'),
      );
    });

    it('should not crash when sendMessage also fails during error notification', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Load failed'),
      );
      (callbacks.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Send failed'),
      );

      // Should not throw
      await expect(
        loader.loadPersistedHistory(callbacks, defaultSessionConfig),
      ).resolves.toBeUndefined();

      expect(loader.isHistoryLoaded()).toBe(true);
    });

    it('should skip loading when getChatHistory callback is not available', async () => {
      const noHistoryCallbacks: HistoryLoaderCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(noHistoryCallbacks, defaultSessionConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should not reload history once loaded', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue('History data');

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);

      // Second call should not trigger another load
      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Promise Deduplication (Persisted History)
  // =========================================================================

  describe('loadPersistedHistory - promise deduplication', () => {
    it('should deduplicate concurrent load calls', async () => {
      let resolveLoad: (value: string) => void;
      const loadPromise = new Promise<string>((resolve) => {
        resolveLoad = resolve;
      });
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockReturnValue(loadPromise);

      // Start two concurrent loads
      const load1 = loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      const load2 = loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      // Only one getChatHistory call should have been made
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);

      // Resolve the load
      resolveLoad!('History data');

      await Promise.all([load1, load2]);

      // Still only one call
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);
      expect(loader.getPersistedContext()).toBe('History data');
    });
  });

  // =========================================================================
  // First Message History Loading
  // =========================================================================

  describe('loadFirstMessageHistory', () => {
    it('should load first message history when available', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue(
        'Previous context for first message',
      );

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(loader.consumeFirstMessageContext()).toBe('Previous context for first message');
    });

    it('should handle empty first message history', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue('');

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should handle undefined first message history', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should handle load failure gracefully', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'chat-test-123',
        expect.stringContaining('加载聊天记录失败'),
      );
    });

    it('should not reload once loaded', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue('History');

      await loader.loadFirstMessageHistory(callbacks);
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);

      await loader.loadFirstMessageHistory(callbacks);
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);
    });

    it('should work when getChatHistory callback is undefined', async () => {
      const minimalCallbacks: HistoryLoaderCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadFirstMessageHistory(minimalCallbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });
  });

  // =========================================================================
  // Promise Deduplication (First Message History)
  // =========================================================================

  describe('loadFirstMessageHistory - promise deduplication', () => {
    it('should deduplicate concurrent first message load calls', async () => {
      let resolveLoad: (value: string) => void;
      const loadPromise = new Promise<string>((resolve) => {
        resolveLoad = resolve;
      });
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockReturnValue(loadPromise);

      const load1 = loader.loadFirstMessageHistory(callbacks);
      const load2 = loader.loadFirstMessageHistory(callbacks);

      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);

      resolveLoad!('History');
      await Promise.all([load1, load2]);

      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // consumeFirstMessageContext
  // =========================================================================

  describe('consumeFirstMessageContext', () => {
    it('should return context and clear it (single-use)', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue('First message ctx');

      await loader.loadFirstMessageHistory(callbacks);

      // First consumption returns the context
      const context = loader.consumeFirstMessageContext();
      expect(context).toBe('First message ctx');

      // Second consumption returns undefined (consumed)
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should return undefined when not loaded', () => {
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });
  });

  // =========================================================================
  // clearAll
  // =========================================================================

  describe('clearAll', () => {
    it('should reset all history state', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue('Some history');

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBe('Some history');

      loader.clearAll();

      expect(loader.isHistoryLoaded()).toBe(false);
      expect(loader.isFirstMessageHistoryLoaded()).toBe(false);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should allow re-loading after clearAll', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue('History v1');

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      expect(loader.getPersistedContext()).toBe('History v1');

      loader.clearAll();

      // Re-load with new data
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue('History v2');
      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      expect(loader.getPersistedContext()).toBe('History v2');
    });

    it('should be safe to call on fresh loader', () => {
      expect(() => loader.clearAll()).not.toThrow();
      expect(loader.isHistoryLoaded()).toBe(false);
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('should handle history exactly at maxContextLength', async () => {
      const history = 'B'.repeat(1000);
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue(history);

      await loader.loadPersistedHistory(callbacks, {
        ...defaultSessionConfig,
        maxContextLength: 1000,
      });

      expect(loader.getPersistedContext()).toBe(history);
      expect(loader.getPersistedContext()!.length).toBe(1000);
    });

    it('should handle history one character over maxContextLength', async () => {
      const history = 'C'.repeat(1001);
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue(history);

      await loader.loadPersistedHistory(callbacks, {
        ...defaultSessionConfig,
        maxContextLength: 1000,
      });

      expect(loader.getPersistedContext()!.length).toBe(1000);
      // Should be last 1000 chars
      expect(loader.getPersistedContext()).toBe('C'.repeat(1000));
    });

    it('should maintain independent state for persisted vs first message history', async () => {
      (callbacks.getChatHistory as ReturnType<typeof vi.fn>).mockResolvedValue('Shared data');

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.getPersistedContext()).toBe('Shared data');
      expect(loader.consumeFirstMessageContext()).toBe('Shared data');

      // Consuming first message context should not affect persisted context
      expect(loader.getPersistedContext()).toBe('Shared data');
    });
  });
});
