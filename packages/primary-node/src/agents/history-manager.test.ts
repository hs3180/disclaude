/**
 * Tests for HistoryManager (packages/primary-node/src/agents/history-manager.ts)
 *
 * Issue #4125 (part 2): HistoryManager was extracted from ChatAgent. These
 * tests cover the module independently of ChatAgent — loading lifecycle,
 * idempotency, truncation, consume-once semantics, reset, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Config is the only @disclaude/core dependency of HistoryManager.
vi.mock('@disclaude/core', () => ({
  Config: {
    getSessionRestoreConfig: vi.fn(() => ({
      historyDays: 7,
      maxContextLength: 100,
    })),
  },
}));

import { HistoryManager } from './history-manager.js';
import { Config } from '@disclaude/core';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function makeCallbacks(
  overrides: Partial<{
    getChatHistory: (chatId: string) => Promise<string | undefined>;
    getChatLogFilePaths: (chatId: string) => Promise<string[]>;
    sendMessage: (chatId: string, text: string) => Promise<void>;
  }> = {}
) {
  return {
    sendMessage: overrides.sendMessage ?? vi.fn().mockResolvedValue(undefined),
    getChatHistory: overrides.getChatHistory,
    getChatLogFilePaths: overrides.getChatLogFilePaths,
    // remaining ChatAgentCallbacks members (unused by HistoryManager)
    sendCard: vi.fn(),
    sendFile: vi.fn(),
  } as any;
}

function makeManager(callbacks = makeCallbacks()) {
  return new HistoryManager({
    chatId: 'oc_test',
    logger: makeLogger() as any,
    callbacks,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(Config.getSessionRestoreConfig).mockReturnValue({
    historyDays: 7,
    maxContextLength: 100,
  } as any);
});

describe('HistoryManager (Issue #4125 part 2)', () => {
  describe('markSkipped (Issue #3696)', () => {
    it('marks both history types as loaded without fetching', async () => {
      const callbacks = makeCallbacks({ getChatHistory: vi.fn() });
      const mgr = makeManager(callbacks);

      mgr.markSkipped();

      expect(mgr.historyLoaded).toBe(true);
      expect(mgr.firstMessageHistoryLoaded).toBe(true);
      // loadPersistedHistory should be a no-op and must NOT call getChatHistory
      await mgr.loadPersistedHistory();
      expect(callbacks.getChatHistory).not.toHaveBeenCalled();
    });
  });

  describe('loadPersistedHistory (Issue #955, #3996)', () => {
    it('caches history and chat log file paths, then sets historyLoaded', async () => {
      const callbacks = makeCallbacks({
        getChatHistory: vi.fn().mockResolvedValue('hello world'),
        getChatLogFilePaths: vi.fn().mockResolvedValue(['/a/log.md']),
      });
      const mgr = makeManager(callbacks);

      await mgr.loadPersistedHistory();

      expect(mgr.persistedHistoryContext).toBe('hello world');
      expect(mgr.chatLogFilePaths).toEqual(['/a/log.md']);
      expect(mgr.historyLoaded).toBe(true);
    });

    it('truncates history to maxContextLength (keeping the tail)', async () => {
      const long = 'x'.repeat(250);
      vi.mocked(Config.getSessionRestoreConfig).mockReturnValue({
        historyDays: 7,
        maxContextLength: 100,
      } as any);
      const callbacks = makeCallbacks({ getChatHistory: vi.fn().mockResolvedValue(long) });
      const mgr = makeManager(callbacks);

      await mgr.loadPersistedHistory();

      expect(mgr.persistedHistoryContext?.length).toBe(100);
      expect(mgr.persistedHistoryContext).toBe(long.slice(-100));
    });

    it('skips silently when no getChatHistory callback is configured', async () => {
      const callbacks = makeCallbacks({}); // no getChatHistory
      const mgr = makeManager(callbacks);

      await mgr.loadPersistedHistory();

      expect(mgr.historyLoaded).toBe(true);
      expect(mgr.persistedHistoryContext).toBeUndefined();
    });

    it('is idempotent — second call does not re-invoke callbacks', async () => {
      const getChatHistory = vi.fn().mockResolvedValue('first');
      const callbacks = makeCallbacks({ getChatHistory });
      const mgr = makeManager(callbacks);

      await mgr.loadPersistedHistory();
      await mgr.loadPersistedHistory();

      expect(getChatHistory).toHaveBeenCalledTimes(1);
      expect(mgr.persistedHistoryContext).toBe('first');
    });

    it('shares the in-flight promise across concurrent callers', async () => {
      let resolveHistory!: (v: string | undefined) => void;
      const getChatHistory = vi.fn(
        () =>
          new Promise<string | undefined>((r) => {
            resolveHistory = r;
          })
      );
      const callbacks = makeCallbacks({ getChatHistory });
      const mgr = makeManager(callbacks);

      const p1 = mgr.loadPersistedHistory();
      const p2 = mgr.loadPersistedHistory();
      resolveHistory('shared');
      await Promise.all([p1, p2]);

      expect(getChatHistory).toHaveBeenCalledTimes(1);
      expect(mgr.persistedHistoryContext).toBe('shared');
    });

    it('marks loaded and notifies the user on error (no retry loop)', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const callbacks = makeCallbacks({
        getChatHistory: vi.fn().mockRejectedValue(new Error('boom')),
        sendMessage,
      });
      const mgr = makeManager(callbacks);

      await mgr.loadPersistedHistory();

      expect(mgr.historyLoaded).toBe(true);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][1]).toContain('加载历史记录失败');
    });
  });

  describe('loadFirstMessageHistory (Issue #1230)', () => {
    it('caches first-message history context and sets the loaded flag', async () => {
      const callbacks = makeCallbacks({
        getChatHistory: vi.fn().mockResolvedValue('first-msg-ctx'),
      });
      const mgr = makeManager(callbacks);

      await mgr.loadFirstMessageHistory();

      expect(mgr.firstMessageHistoryContext).toBe('first-msg-ctx');
      expect(mgr.firstMessageHistoryLoaded).toBe(true);
    });

    it('is idempotent', async () => {
      const getChatHistory = vi.fn().mockResolvedValue('ctx');
      const callbacks = makeCallbacks({ getChatHistory });
      const mgr = makeManager(callbacks);

      await mgr.loadFirstMessageHistory();
      await mgr.loadFirstMessageHistory();

      expect(getChatHistory).toHaveBeenCalledTimes(1);
    });

    it('marks loaded and notifies the user on error', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const callbacks = makeCallbacks({
        getChatHistory: vi.fn().mockRejectedValue(new Error('boom')),
        sendMessage,
      });
      const mgr = makeManager(callbacks);

      await mgr.loadFirstMessageHistory();

      expect(mgr.firstMessageHistoryLoaded).toBe(true);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage.mock.calls[0][1]).toContain('加载聊天记录失败');
    });
  });

  describe('reset (Issue #955, #1230)', () => {
    it('clears all loaded context and flags so history can be reloaded', async () => {
      const getChatHistory = vi
        .fn()
        .mockResolvedValueOnce('first') // persisted load #1
        .mockResolvedValueOnce('fm') // first-message load
        .mockResolvedValueOnce('second'); // persisted reload after reset
      const callbacks = makeCallbacks({
        getChatHistory,
        getChatLogFilePaths: vi.fn().mockResolvedValue(['/x']),
      });
      const mgr = makeManager(callbacks);

      await mgr.loadPersistedHistory();
      await mgr.loadFirstMessageHistory();
      expect(mgr.persistedHistoryContext).toBe('first');

      mgr.reset();

      expect(mgr.persistedHistoryContext).toBeUndefined();
      expect(mgr.historyLoaded).toBe(false);
      expect(mgr.firstMessageHistoryContext).toBeUndefined();
      expect(mgr.firstMessageHistoryLoaded).toBe(false);

      // Reload after reset fetches fresh data.
      await mgr.loadPersistedHistory();
      expect(mgr.persistedHistoryContext).toBe('second');
      expect(getChatHistory).toHaveBeenCalledTimes(3); // persisted x2 + firstMessage x1
    });
  });
});
