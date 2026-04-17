/**
 * Tests for ChatHistoryLoader.
 *
 * Verifies persisted history loading, first message history loading,
 * promise deduplication, truncation, error handling, and state management.
 *
 * Issue #1617: Phase 2 - agent layer test coverage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatHistoryLoader, type HistoryLoaderCallbacks } from './chat-history-loader.js';

function createMockLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as import('pino').Logger;
}

function createMockCallbacks(overrides: Partial<HistoryLoaderCallbacks> = {}): HistoryLoaderCallbacks {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getChatHistory: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ChatHistoryLoader', () => {
  let loader: ChatHistoryLoader;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    loader = new ChatHistoryLoader('oc_test', logger);
  });

  // ==========================================================================
  // Constructor & Initial State
  // ==========================================================================

  describe('initial state', () => {
    it('should have no persisted context initially', () => {
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should report history as not loaded', () => {
      expect(loader.isHistoryLoaded()).toBe(false);
    });

    it('should report first message history as not loaded', () => {
      expect(loader.isFirstMessageHistoryLoaded()).toBe(false);
    });
  });

  // ==========================================================================
  // loadPersistedHistory
  // ==========================================================================

  describe('loadPersistedHistory', () => {
    const defaultConfig = { historyDays: 7, maxContextLength: 1000 };

    it('should load and store persisted history', async () => {
      const history = 'Previous chat history content';
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue(history),
      });

      await loader.loadPersistedHistory(callbacks, defaultConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBe(history);
    });

    it('should call getChatHistory with correct chatId', async () => {
      const getChatHistory = vi.fn().mockResolvedValue('some history');
      const callbacks = createMockCallbacks({ getChatHistory });

      await loader.loadPersistedHistory(callbacks, defaultConfig);

      expect(getChatHistory).toHaveBeenCalledWith('oc_test');
    });

    it('should truncate history exceeding maxContextLength', async () => {
      const longHistory = 'x'.repeat(2000);
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue(longHistory),
      });

      await loader.loadPersistedHistory(callbacks, { historyDays: 7, maxContextLength: 500 });

      expect(loader.getPersistedContext()).toHaveLength(500);
      // Should keep the tail (most recent) of the history
      expect(loader.getPersistedContext()).toBe('x'.repeat(500));
    });

    it('should not truncate history within maxContextLength', async () => {
      const shortHistory = 'short history';
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue(shortHistory),
      });

      await loader.loadPersistedHistory(callbacks, { historyDays: 7, maxContextLength: 500 });

      expect(loader.getPersistedContext()).toBe('short history');
    });

    it('should mark history as loaded even when no history found', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue(undefined),
      });

      await loader.loadPersistedHistory(callbacks, defaultConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should mark history as loaded when history is empty string', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue(''),
      });

      await loader.loadPersistedHistory(callbacks, defaultConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should mark history as loaded when history is whitespace only', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue('   \n\t  '),
      });

      await loader.loadPersistedHistory(callbacks, defaultConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should skip loading when getChatHistory is not available', async () => {
      const callbacks = createMockCallbacks();
      // Explicitly delete to simulate undefined
      delete (callbacks as Record<string, unknown>).getChatHistory;

      await loader.loadPersistedHistory(callbacks, defaultConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should handle getChatHistory throwing an error', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockRejectedValue(new Error('Network failure')),
      });

      // Should NOT throw
      await loader.loadPersistedHistory(callbacks, defaultConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should notify user on getChatHistory error', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockRejectedValue(new Error('Network failure')),
        sendMessage,
      });

      await loader.loadPersistedHistory(callbacks, defaultConfig);

      expect(sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('加载历史记录失败'),
      );
    });

    it('should not reload if already loaded', async () => {
      const getChatHistory = vi.fn().mockResolvedValue('first load');
      const callbacks = createMockCallbacks({ getChatHistory });

      await loader.loadPersistedHistory(callbacks, defaultConfig);
      await loader.loadPersistedHistory(callbacks, defaultConfig);

      expect(getChatHistory).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate concurrent calls (promise deduplication)', async () => {
      let resolveHistory: (value: string | undefined) => void;
      const historyPromise = new Promise<string | undefined>((resolve) => {
        resolveHistory = resolve;
      });
      const getChatHistory = vi.fn().mockReturnValue(historyPromise);
      const callbacks = createMockCallbacks({ getChatHistory });

      // Start two concurrent loads
      const load1 = loader.loadPersistedHistory(callbacks, defaultConfig);
      const load2 = loader.loadPersistedHistory(callbacks, defaultConfig);

      // Only one call should have been made
      expect(getChatHistory).toHaveBeenCalledTimes(1);

      // Resolve the promise
      resolveHistory!('the history');

      await Promise.all([load1, load2]);

      // Both should see the same result, only one getChatHistory call
      expect(getChatHistory).toHaveBeenCalledTimes(1);
      expect(loader.getPersistedContext()).toBe('the history');
    });
  });

  // ==========================================================================
  // loadFirstMessageHistory
  // ==========================================================================

  describe('loadFirstMessageHistory', () => {
    it('should load and store first message history', async () => {
      const history = 'Chat history for first message';
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue(history),
      });

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
    });

    it('should call getChatHistory with correct chatId', async () => {
      const getChatHistory = vi.fn().mockResolvedValue('history');
      const callbacks = createMockCallbacks({ getChatHistory });

      await loader.loadFirstMessageHistory(callbacks);

      expect(getChatHistory).toHaveBeenCalledWith('oc_test');
    });

    it('should handle no getChatHistory callback gracefully', async () => {
      const callbacks = createMockCallbacks();
      delete (callbacks as Record<string, unknown>).getChatHistory;

      // getChatHistory is undefined, so it should be skipped
      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
    });

    it('should handle getChatHistory returning undefined', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue(undefined),
      });

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
    });

    it('should handle getChatHistory returning empty string', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue(''),
      });

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
    });

    it('should not reload if already loaded', async () => {
      const getChatHistory = vi.fn().mockResolvedValue('first message history');
      const callbacks = createMockCallbacks({ getChatHistory });

      await loader.loadFirstMessageHistory(callbacks);
      await loader.loadFirstMessageHistory(callbacks);

      expect(getChatHistory).toHaveBeenCalledTimes(1);
    });

    it('should handle getChatHistory throwing an error', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockRejectedValue(new Error('Service unavailable')),
        sendMessage,
      });

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('加载聊天记录失败'),
      );
    });

    it('should deduplicate concurrent calls', async () => {
      let resolveHistory: (value: string | undefined) => void;
      const historyPromise = new Promise<string | undefined>((resolve) => {
        resolveHistory = resolve;
      });
      const getChatHistory = vi.fn().mockReturnValue(historyPromise);
      const callbacks = createMockCallbacks({ getChatHistory });

      const load1 = loader.loadFirstMessageHistory(callbacks);
      const load2 = loader.loadFirstMessageHistory(callbacks);

      expect(getChatHistory).toHaveBeenCalledTimes(1);

      resolveHistory!('history');
      await Promise.all([load1, load2]);

      expect(getChatHistory).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // consumeFirstMessageContext
  // ==========================================================================

  describe('consumeFirstMessageContext', () => {
    it('should return undefined when no history loaded', () => {
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should return and clear first message context', async () => {
      const history = 'First message context';
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue(history),
      });

      await loader.loadFirstMessageHistory(callbacks);

      // First consumption returns the context
      const context = loader.consumeFirstMessageContext();
      expect(context).toBe('First message context');

      // Second consumption returns undefined (cleared)
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should not affect persisted history context', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue('some history'),
      });

      await loader.loadPersistedHistory(callbacks, { historyDays: 7, maxContextLength: 1000 });
      await loader.loadFirstMessageHistory(callbacks);

      loader.consumeFirstMessageContext();

      // Persisted context should still be available
      expect(loader.getPersistedContext()).toBe('some history');
    });
  });

  // ==========================================================================
  // clearAll
  // ==========================================================================

  describe('clearAll', () => {
    it('should reset all state to initial values', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn().mockResolvedValue('some history'),
      });

      await loader.loadPersistedHistory(callbacks, { historyDays: 7, maxContextLength: 1000 });
      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);

      loader.clearAll();

      expect(loader.isHistoryLoaded()).toBe(false);
      expect(loader.isFirstMessageHistoryLoaded()).toBe(false);
      expect(loader.getPersistedContext()).toBeUndefined();
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should allow re-loading after clear', async () => {
      const getChatHistory = vi.fn()
        .mockResolvedValueOnce('first load')
        .mockResolvedValueOnce('second load');
      const callbacks = createMockCallbacks({ getChatHistory });

      await loader.loadPersistedHistory(callbacks, { historyDays: 7, maxContextLength: 1000 });
      expect(loader.getPersistedContext()).toBe('first load');

      loader.clearAll();

      await loader.loadPersistedHistory(callbacks, { historyDays: 7, maxContextLength: 1000 });
      expect(loader.getPersistedContext()).toBe('second load');
      expect(getChatHistory).toHaveBeenCalledTimes(2);
    });
  });
});
