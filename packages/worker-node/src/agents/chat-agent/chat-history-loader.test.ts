/**
 * Tests for ChatHistoryLoader (packages/worker-node/src/agents/chat-agent/chat-history-loader.ts)
 *
 * Covers: persisted history loading, first message history loading,
 * promise deduplication, truncation, error handling, state management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

import { ChatHistoryLoader } from './chat-history-loader.js';

const defaultSessionConfig = {
  historyDays: 1,
  maxContextLength: 50000,
};

describe('ChatHistoryLoader', () => {
  let loader: ChatHistoryLoader;

  beforeEach(() => {
    vi.clearAllMocks();
    loader = new ChatHistoryLoader('oc_test', mockLogger as any);
  });

  // --- Persisted History ---

  describe('loadPersistedHistory', () => {
    it('should load persisted history from callback', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue('previous conversation context'),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBe('previous conversation context');
      expect(callbacks.getChatHistory).toHaveBeenCalledWith('oc_test');
    });

    it('should truncate history exceeding maxContextLength', async () => {
      const longHistory = 'x'.repeat(60000);
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue(longHistory),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(callbacks, { historyDays: 1, maxContextLength: 50000 });

      expect(loader.getPersistedContext()).toHaveLength(50000);
      // Should take the last N characters
      expect(loader.getPersistedContext()).toBe('x'.repeat(50000));
    });

    it('should not truncate history within maxContextLength', async () => {
      const shortHistory = 'short history';
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue(shortHistory),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.getPersistedContext()).toBe('short history');
    });

    it('should handle empty history (undefined)', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should handle whitespace-only history', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue('   \n\t  '),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should handle getChatHistory error gracefully', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockRejectedValue(new Error('DB connection failed')),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('加载历史记录失败'),
      );
    });

    it('should skip loading when getChatHistory callback is not available', async () => {
      const callbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBeUndefined();
    });

    it('should not load again if already loaded', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue('first load'),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);

      // Second call should be a no-op
      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate concurrent calls', async () => {
      let resolveHistory: (value: string) => void;
      const historyPromise = new Promise<string>((resolve) => { resolveHistory = resolve; });

      const callbacks = {
        getChatHistory: vi.fn().mockReturnValue(historyPromise),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      // Start two concurrent loads
      const load1 = loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      const load2 = loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      // Resolve the history
      resolveHistory!('concurrent result');

      await Promise.all([load1, load2]);

      // Should only call getChatHistory once due to deduplication
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);
      expect(loader.getPersistedContext()).toBe('concurrent result');
    });
  });

  // --- First Message History ---

  describe('loadFirstMessageHistory', () => {
    it('should load first message history from callback', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue('chat history for first message'),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(loader.consumeFirstMessageContext()).toBe('chat history for first message');
    });

    it('should handle empty history for first message', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should handle whitespace-only history for first message', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue('  \n  '),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should handle getChatHistory error for first message', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockRejectedValue(new Error('Network error')),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
      expect(callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('加载聊天记录失败'),
      );
    });

    it('should handle missing getChatHistory callback for first message', async () => {
      const callbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadFirstMessageHistory(callbacks);

      expect(loader.isFirstMessageHistoryLoaded()).toBe(true);
    });

    it('should not load again if already loaded', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue('first load'),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadFirstMessageHistory(callbacks);
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);

      await loader.loadFirstMessageHistory(callbacks);
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);
    });

    it('should deduplicate concurrent first message loads', async () => {
      let resolveHistory: (value: string) => void;
      const historyPromise = new Promise<string>((resolve) => { resolveHistory = resolve; });

      const callbacks = {
        getChatHistory: vi.fn().mockReturnValue(historyPromise),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      const load1 = loader.loadFirstMessageHistory(callbacks);
      const load2 = loader.loadFirstMessageHistory(callbacks);

      resolveHistory!('dedup result');

      await Promise.all([load1, load2]);

      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(1);
    });
  });

  // --- consumeFirstMessageContext ---

  describe('consumeFirstMessageContext', () => {
    it('should return and clear the first message context', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue('consumable context'),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadFirstMessageHistory(callbacks);

      // First consume returns the context
      expect(loader.consumeFirstMessageContext()).toBe('consumable context');

      // Second consume returns undefined (already consumed)
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });

    it('should return undefined when no context is loaded', () => {
      expect(loader.consumeFirstMessageContext()).toBeUndefined();
    });
  });

  // --- clearAll ---

  describe('clearAll', () => {
    it('should clear all history state', async () => {
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue('some history'),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);
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
      const callbacks = {
        getChatHistory: vi.fn().mockResolvedValue('reloaded history'),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      };

      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);
      loader.clearAll();

      // Should be able to load again
      await loader.loadPersistedHistory(callbacks, defaultSessionConfig);

      expect(loader.isHistoryLoaded()).toBe(true);
      expect(loader.getPersistedContext()).toBe('reloaded history');
      expect(callbacks.getChatHistory).toHaveBeenCalledTimes(2);
    });
  });
});
