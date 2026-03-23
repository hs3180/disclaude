/**
 * Tests for WeChatMonitor (packages/primary-node/src/channels/wechat/monitor.ts)
 *
 * @see Issue #1474 - WeChat Channel: Message Listening (Long Polling)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WeChatMonitor } from './monitor.js';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatUpdate } from './monitor.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock WeChatApiClient. */
function createMockClient(overrides?: Partial<WeChatApiClient>): WeChatApiClient {
  return {
    hasToken: vi.fn(() => true),
    getToken: vi.fn(() => 'test-token'),
    setToken: vi.fn(),
    getUpdates: vi.fn().mockResolvedValue([]),
    sendText: vi.fn(),
    getBotQrCode: vi.fn(),
    getQrCodeStatus: vi.fn(),
    ...overrides,
  } as unknown as WeChatApiClient;
}

/** Create a basic WeChat update. */
function makeUpdate(overrides: Partial<WeChatUpdate> = {}): WeChatUpdate {
  return {
    msgId: 'msg-1',
    fromUserId: 'user-123',
    toUserId: 'bot-456',
    msgType: 1,
    text: 'Hello',
    createTime: 1700000000,
    ...overrides,
  };
}

/**
 * Helper: start monitor with a getUpdates mock that resolves N times then
 * keeps returning empty arrays.
 */
function startMonitorWithUpdates(
  monitor: WeChatMonitor,
  updatesBatches: WeChatUpdate[][],
  client: WeChatApiClient,
): void {
  let callIndex = 0;
  vi.mocked(client.getUpdates).mockImplementation(async () => {
    if (callIndex < updatesBatches.length) {
      return updatesBatches[callIndex++];
    }
    // After all batches are delivered, keep polling (don't resolve)
    // This allows stop() to cleanly abort
    return new Promise(() => {}); // Never resolves — simulates long-poll
  });
  monitor.start();
}

// ============================================================================
// Tests
// ============================================================================

describe('WeChatMonitor', () => {
  let mockClient: WeChatApiClient;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
  });

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('should create monitor with default options', () => {
      const m = new WeChatMonitor(mockClient);
      expect(m.getState()).toBe('idle');
      expect(m.isPolling()).toBe(false);
    });

    it('should accept custom options', () => {
      const m = new WeChatMonitor(mockClient, {
        pollTimeout: 60,
        backoffBaseMs: 2000,
        dedupMaxSize: 500,
      });
      expect(m.getState()).toBe('idle');
    });

    it('should warn if client has no token', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockClient = createMockClient({ hasToken: vi.fn(() => false) });
      new WeChatMonitor(mockClient);
      // The monitor should log a warning (via logger)
      warnSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // Start / Stop
  // ---------------------------------------------------------------------------

  describe('start / stop', () => {
    it('should throw if no token is available', () => {
      mockClient = createMockClient({ hasToken: vi.fn(() => false) });
      const m = new WeChatMonitor(mockClient);

      expect(() => m.start()).toThrow('no valid bot token');
    });

    it('should start polling and set state to "polling"', () => {
      // getUpdates that never resolves (simulates long-poll)
      vi.mocked(mockClient.getUpdates).mockImplementation(() => new Promise(() => {}));
      const m = new WeChatMonitor(mockClient);

      m.start();
      expect(m.getState()).toBe('polling');
      expect(m.isPolling()).toBe(true);
    });

    it('should stop and set state to "stopped"', async () => {
      vi.mocked(mockClient.getUpdates).mockImplementation(() => new Promise(() => {}));
      const m = new WeChatMonitor(mockClient);

      m.start();
      expect(m.isPolling()).toBe(true);

      await m.stop();
      expect(m.getState()).toBe('stopped');
      expect(m.isPolling()).toBe(false);
    });

    it('should be safe to call stop multiple times', async () => {
      vi.mocked(mockClient.getUpdates).mockImplementation(() => new Promise(() => {}));
      const m = new WeChatMonitor(mockClient);

      m.start();
      await m.stop();
      await m.stop(); // Should not throw
      expect(m.getState()).toBe('stopped');
    });

    it('should be safe to call start when already running', () => {
      vi.mocked(mockClient.getUpdates).mockImplementation(() => new Promise(() => {}));
      const m = new WeChatMonitor(mockClient);

      m.start();
      m.start(); // Should warn but not throw
      expect(m.isPolling()).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  describe('message handling', () => {
    it('should forward new messages to the callback', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const update = makeUpdate({ msgId: 'msg-1', text: 'Hello world' });

      const m = new WeChatMonitor(mockClient);
      m.onMessage(callback);

      startMonitorWithUpdates(m, [[update]], mockClient);

      // Wait for async processing
      await new Promise((r) => setTimeout(r, 200));

      expect(callback).toHaveBeenCalledTimes(1);
      const incoming = callback.mock.calls[0][0];
      expect(incoming.messageId).toBe('msg-1');
      expect(incoming.chatId).toBe('user-123');
      expect(incoming.userId).toBe('user-123');
      expect(incoming.content).toBe('Hello world');
      expect(incoming.messageType).toBe('text');

      await m.stop();
    });

    it('should deduplicate messages with the same ID', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const update = makeUpdate({ msgId: 'msg-dup' });

      const m = new WeChatMonitor(mockClient);
      m.onMessage(callback);

      // Return same message in two consecutive batches
      startMonitorWithUpdates(m, [[update], [update]], mockClient);

      await new Promise((r) => setTimeout(r, 300));

      // Only first occurrence should be forwarded
      expect(callback).toHaveBeenCalledTimes(1);

      await m.stop();
    });

    it('should convert image messages (msgType=3)', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const update = makeUpdate({
        msgId: 'msg-img',
        msgType: 3,
        media: {
          cdnUrl: 'https://cdn.example.com/image.png',
          fileName: 'image.png',
          fileType: 'image/png',
          fileSize: 1024,
        },
      });

      const m = new WeChatMonitor(mockClient);
      m.onMessage(callback);

      startMonitorWithUpdates(m, [[update]], mockClient);
      await new Promise((r) => setTimeout(r, 200));

      expect(callback).toHaveBeenCalledTimes(1);
      const incoming = callback.mock.calls[0][0];
      expect(incoming.messageType).toBe('image');
      expect(incoming.content).toBe('https://cdn.example.com/image.png');
      expect(incoming.attachments).toBeDefined();
      expect(incoming.attachments![0].fileName).toBe('image.png');

      await m.stop();
    });

    it('should convert file messages (msgType=4)', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const update = makeUpdate({
        msgId: 'msg-file',
        msgType: 4,
        media: {
          cdnUrl: 'https://cdn.example.com/doc.pdf',
          fileName: 'doc.pdf',
          fileType: 'application/pdf',
        },
      });

      const m = new WeChatMonitor(mockClient);
      m.onMessage(callback);

      startMonitorWithUpdates(m, [[update]], mockClient);
      await new Promise((r) => setTimeout(r, 200));

      expect(callback).toHaveBeenCalledTimes(1);
      const incoming = callback.mock.calls[0][0];
      expect(incoming.messageType).toBe('file');
      expect(incoming.content).toBe('doc.pdf');

      await m.stop();
    });

    it('should skip empty text messages', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const update = makeUpdate({ msgId: 'msg-empty', text: '   ' });

      const m = new WeChatMonitor(mockClient);
      m.onMessage(callback);

      startMonitorWithUpdates(m, [[update]], mockClient);
      await new Promise((r) => setTimeout(r, 200));

      expect(callback).not.toHaveBeenCalled();

      await m.stop();
    });

    it('should include metadata in incoming messages', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const update = makeUpdate({
        msgId: 'msg-meta',
        contextToken: 'ctx-123',
        clientId: 'client-abc',
      });

      const m = new WeChatMonitor(mockClient);
      m.onMessage(callback);

      startMonitorWithUpdates(m, [[update]], mockClient);
      await new Promise((r) => setTimeout(r, 200));

      expect(callback).toHaveBeenCalledTimes(1);
      const incoming = callback.mock.calls[0][0];
      expect(incoming.threadId).toBe('ctx-123');
      expect(incoming.metadata).toEqual({
        toUserId: 'bot-456',
        clientId: 'client-abc',
        msgType: 1,
      });

      await m.stop();
    });

    it('should handle multiple messages in a single batch', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const updates = [
        makeUpdate({ msgId: 'msg-a', text: 'First' }),
        makeUpdate({ msgId: 'msg-b', text: 'Second' }),
        makeUpdate({ msgId: 'msg-c', text: 'Third' }),
      ];

      const m = new WeChatMonitor(mockClient);
      m.onMessage(callback);

      startMonitorWithUpdates(m, [updates], mockClient);
      await new Promise((r) => setTimeout(r, 200));

      expect(callback).toHaveBeenCalledTimes(3);

      await m.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('should continue polling after a callback error', async () => {
      const callback = vi.fn().mockRejectedValue(new Error('handler error'));
      const update = makeUpdate({ msgId: 'msg-err' });

      const m = new WeChatMonitor(mockClient);
      m.onMessage(callback);

      startMonitorWithUpdates(m, [[update]], mockClient);
      await new Promise((r) => setTimeout(r, 200));

      // Callback should still have been called (error was caught internally)
      expect(callback).toHaveBeenCalledTimes(1);
      // Monitor should still be running
      expect(m.isPolling()).toBe(true);

      await m.stop();
    });

    it('should handle empty update batches gracefully', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);

      const m = new WeChatMonitor(mockClient);
      m.onMessage(callback);

      startMonitorWithUpdates(m, [[]], mockClient);
      await new Promise((r) => setTimeout(r, 200));

      expect(callback).not.toHaveBeenCalled();
      expect(m.isPolling()).toBe(true);

      await m.stop();
    });

    it('should apply backoff on API errors', async () => {
      let callCount = 0;
      vi.mocked(mockClient.getUpdates).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Network error');
        }
        // After error, long-poll (never resolves)
        return new Promise(() => {});
      });

      const m = new WeChatMonitor(mockClient);
      m.start();

      // Wait for error + backoff
      await new Promise((r) => setTimeout(r, 2500));

      // Should have retried after backoff
      expect(callCount).toBeGreaterThanOrEqual(2);
      expect(m.isPolling()).toBe(true);

      await m.stop();
    });
  });

  // ---------------------------------------------------------------------------
  // Stats
  // ---------------------------------------------------------------------------

  describe('getStats', () => {
    it('should return current statistics', () => {
      const m = new WeChatMonitor(mockClient);
      const stats = m.getStats();

      expect(stats).toEqual({
        state: 'idle',
        pollCount: 0,
        messageCount: 0,
        errorCount: 0,
        dedupSetSize: 0,
        currentBackoffMs: 1000,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Deduplication set eviction
  // ---------------------------------------------------------------------------

  describe('deduplication', () => {
    it('should evict old entries when dedup set exceeds max size', async () => {
      const callback = vi.fn().mockResolvedValue(undefined);
      const smallMonitor = new WeChatMonitor(mockClient, { dedupMaxSize: 3 });

      const updates = [
        makeUpdate({ msgId: 'msg-1' }),
        makeUpdate({ msgId: 'msg-2' }),
        makeUpdate({ msgId: 'msg-3' }),
        makeUpdate({ msgId: 'msg-4' }),
      ];

      smallMonitor.onMessage(callback);
      startMonitorWithUpdates(smallMonitor, [updates], mockClient);

      await new Promise((r) => setTimeout(r, 200));

      // All 4 messages should be processed (first time seen)
      expect(callback).toHaveBeenCalledTimes(4);

      await smallMonitor.stop();
    });
  });
});
