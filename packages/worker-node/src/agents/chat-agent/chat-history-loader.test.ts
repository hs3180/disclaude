/**
 * Unit tests for ChatHistoryLoader
 *
 * Tests cover:
 * - Persisted history loading (Issue #955)
 * - First message history loading (Issue #1230)
 * - Promise deduplication to prevent concurrent loads
 * - Context truncation (maxContextLength)
 * - Error handling and user notification
 * - consumeFirstMessageContext() one-shot consumption
 * - clearAll() state reset
 * - Edge cases: empty history, missing callback, concurrent access
 *
 * @see Issue #1617 Phase 3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatHistoryLoader, type HistoryLoaderCallbacks } from './chat-history-loader.js';
import pino from 'pino';

// Create a silent logger for tests
const logger = pino({ level: 'silent' });

function createMockCallbacks(overrides?: Partial<HistoryLoaderCallbacks>): HistoryLoaderCallbacks {
  return {
    getChatHistory: vi.fn(() => Promise.resolve(undefined)),
    sendMessage: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

describe('ChatHistoryLoader', () => {
  let loader: ChatHistoryLoader;

  beforeEach(() => {
    loader = new ChatHistoryLoader('chat-123', logger);
  });

  describe('constructor', () => {
    it('should initialize with empty state', () => {
      expect(loader.isHistoryLoaded()).toBe(false);
      expect(loader.isFirstMessageHistoryLoaded()).toBe(false);
      expect(loader.getPersistedContext()).toBeUndefined();
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });
  });

  describe('loadPersistedHistory', () => {
    it('should load history from getChatHistory callback', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve('Previous conversation history')),
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBe('Previous conversation history');
    });

    it('should truncate history exceeding maxContextLength', async () => {
      const longHistory = 'A'.repeat(5000);
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve(longHistory)),
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      expect(loader.isHistoryLoaded()).toBe(true);
      const context = loader.getPersistedContext();
      expect(context).toBeDefined();
      expect(context!.length).toBe(4000);
      // Should keep the END of the history (most recent)
      expect(context).toBe('A'.repeat(4000));
    });

    it('should keep full history when under maxContextLength', async () => {
      const shortHistory = 'Short history';
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve(shortHistory)),
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      expect(loader.getPersistedContext()).toBe('Short history');
    });

    it('should handle empty history gracefully', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve('')),
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should handle whitespace-only history as empty', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve('   \n\t  ')),
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should handle null/undefined history from callback', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve(undefined)),
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should skip loading when getChatHistory callback is not provided', async () => {
      const callbacks = createMockCallbacks();
      delete (callbacks as unknown as Record<string, unknown>).getChatHistory;

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should handle errors gracefully and notify user', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.reject(new Error('Database connection failed'))),
        sendMessage: vi.fn(() => Promise.resolve()),
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      // History should be marked as loaded even on error
      expect(loader.isHistoryLoaded()).toBe(true);
      // User should be notified
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'chat-123',
        expect.stringContaining('加载历史记录失败'),
      );
    });

    it('should not load twice (idempotent)', async () => {
      const getChatHistory = vi.fn(() => Promise.resolve('History data'));
      const callbacks = createMockCallbacks({ getChatHistory });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      // Should only call once due to historyLoaded flag
      expect(getChatHistory).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate concurrent load requests', async () => {
      let resolveHistory: (value: string | undefined) => void;
      const historyPromise = new Promise<string | undefined>((resolve) => {
        resolveHistory = resolve;
      });

      const getChatHistory = vi.fn(() => historyPromise);
      const callbacks = createMockCallbacks({ getChatHistory });

      // Start two concurrent loads
      const load1 = loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });
      const load2 = loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      // Resolve the history
      resolveHistory!('Concurrent history');

      await Promise.all([load1, load2]);

      // Should only call getChatHistory once due to promise deduplication
      expect(getChatHistory).toHaveBeenCalledTimes(1);
      expect(loader.getPersistedContext()).toBe('Concurrent history');
    });
  });

  describe('loadFirstMessageHistory', () => {
    it('should load history for first message context', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve('Recent conversation context')),
      });

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
    });

    it('should handle empty history for first message', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve('')),
      });

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should handle error and notify user for first message', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.reject(new Error('Load failed'))),
        sendMessage: vi.fn(() => Promise.resolve()),
      });

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'chat-123',
        expect.stringContaining('加载聊天记录失败'),
      );
    });

    it('should not load twice (idempotent)', async () => {
      const getChatHistory = vi.fn(() => Promise.resolve('First message history'));
      const callbacks = createMockCallbacks({ getChatHistory });

      await loader.loadFirstMessageHistory(callbacks);
      await loader.loadFirstMessageHistory(callbacks);

      expect(getChatHistory).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate concurrent first message loads', async () => {
      let resolveHistory: (value: string | undefined) => void;
      const historyPromise = new Promise<string | undefined>((resolve) => {
        resolveHistory = resolve;
      });

      const getChatHistory = vi.fn(() => historyPromise);
      const callbacks = createMockCallbacks({ getChatHistory });

      // Start two concurrent loads
      const load1 = loader.loadFirstMessageHistory(callbacks);
      const load2 = loader.loadFirstMessageHistory(callbacks);

      resolveHistory!('Deduped history');

      await Promise.all([load1, load2]);

      expect(getChatHistory).toHaveBeenCalledTimes(1);
    });
  });

  describe('consumeFirstMessageContext', () => {
    it('should return context and clear it', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve('First message context')),
      });

      await loader.loadFirstMessageHistory(callbacks);

      // First consume returns the context
      const context = loader.consumeFirstMessageContext();
      expect(context).toBe('First message context');

      // Second consume returns undefined (cleared)
      const context2 = loader.consumeFirstMessageContext();
      expect(context2).toBeUndefined();
    });

    it('should return undefined when no context loaded', () => {
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });
  });

  describe('clearAll', () => {
    it('should reset all state', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve('Some history')),
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });
      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);

      loader.clearAll();

      expect(loader.isHistoryLoaded()).toBe(false);
      expect(loader.isFirstMessageHistoryLoaded()).toBe(false);
      expect(loader.getPersistedContext()).toBeUndefined();
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should allow reloading after clearAll', async () => {
      const getChatHistory = vi.fn(() => Promise.resolve('Reloaded history'));
      const callbacks = createMockCallbacks({ getChatHistory });

      // First load
      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });
      expect(getChatHistory).toHaveBeenCalledTimes(1);

      // Clear
      loader.clearAll();

      // Reload should work
      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });
      expect(getChatHistory).toHaveBeenCalledTimes(2);
      expect(loader.getPersistedContext()).toBe('Reloaded history');
    });
  });

  describe('edge cases', () => {
    it('should handle sendMessage callback failure gracefully during error notification', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.reject(new Error('Load error'))),
        sendMessage: vi.fn(() => Promise.reject(new Error('Send failed too'))),
      });

      // Should not throw even if sendMessage fails
      await expect(loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      })).resolves.toBeUndefined();

      expect(loader.isHistoryLoaded()).toBe(true);
    });

    it('should handle first message sendMessage callback failure gracefully', async () => {
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.reject(new Error('Load error'))),
        sendMessage: vi.fn(() => Promise.reject(new Error('Send failed too'))),
      });

      // Should not throw even if sendMessage fails
      await expect(loader.loadFirstMessageHistory(callbacks)).resolves.toBeUndefined();

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
    });

    it('should handle concurrent persisted and first message loads independently', async () => {
      let resolvePersisted: (value: string | undefined) => void;
      let resolveFirst: (value: string | undefined) => void;
      const persistedPromise = new Promise<string | undefined>((resolve) => {
        resolvePersisted = resolve;
      });
      const firstPromise = new Promise<string | undefined>((resolve) => {
        resolveFirst = resolve;
      });

      const getChatHistory = vi.fn((_chatId: string) => {
        // Return different promises based on call order
        if (getChatHistory.mock.calls.length === 1) {
          return persistedPromise;
        }
        return firstPromise;
      });

      const callbacks = createMockCallbacks({ getChatHistory });

      // Start both loads concurrently
      const loadPersisted = loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });
      const loadFirst = loader.loadFirstMessageHistory(callbacks);

      // Resolve both
      resolvePersisted!('Persisted data');
      resolveFirst!('First message data');

      await Promise.all([loadPersisted, loadFirst]);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBe('Persisted data');
    });

    it('should handle very large history with exact maxContextLength boundary', async () => {
      const history = 'X'.repeat(4000); // Exactly at limit
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve(history)),
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      // Should keep full history (not truncated)
      expect(loader.getPersistedContext()!.length).toBe(4000);
    });

    it('should handle history that is one character over limit', async () => {
      const history = 'X'.repeat(4001); // One over limit
      const callbacks = createMockCallbacks({
        getChatHistory: vi.fn(() => Promise.resolve(history)),
      });

      await loader.loadPersistedHistory(callbacks, {
        historyDays: 7,
        maxContextLength: 4000,
      });

      // Should be truncated to 4000
      expect(loader.getPersistedContext()!.length).toBe(4000);
    });
  });
});
