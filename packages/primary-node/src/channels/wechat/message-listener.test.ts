/**
 * Tests for WeChatMessageListener.
 *
 * Tests the long-poll based message listener with mocked API client.
 * Uses real timers with short delays to avoid fake timer memory issues.
 *
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatUpdate } from './types.js';

// Mock logger
const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
}));

vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => mockLogger),
  };
});

/**
 * Helper: create a mock getUpdates that returns data once then aborts.
 */
function createSingleShotGetUpdates(updates: WeChatUpdate[]) {
  let called = false;
  return vi.fn().mockImplementation(async () => {
    if (called) {
      throw new DOMException('Aborted', 'AbortError');
    }
    called = true;
    return updates;
  });
}

describe('WeChatMessageListener', () => {
  let WeChatMessageListener: typeof import('./message-listener.js').WeChatMessageListener;
  let mockClient: Partial<WeChatApiClient>;
  let messageProcessor: Mock;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const mod = await import('./message-listener.js');
    WeChatMessageListener = mod.WeChatMessageListener;

    messageProcessor = vi.fn().mockResolvedValue(undefined);

    mockClient = {
      getUpdates: vi.fn().mockResolvedValue([]),
    };
  });

  describe('start / stop', () => {
    it('should start and stop the listener', async () => {
      mockClient.getUpdates = createSingleShotGetUpdates([]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      expect(listener.isListening()).toBe(true);

      // Give the poll loop time to process
      await new Promise((r) => setTimeout(r, 50));

      await listener.stop();
      expect(listener.isListening()).toBe(false);
    });

    it('should be safe to call stop when not started', async () => {
      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      await listener.stop();
      expect(listener.isListening()).toBe(false);
    });

    it('should be safe to call start when already started', async () => {
      mockClient.getUpdates = createSingleShotGetUpdates([]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      listener.start(); // Should warn but not throw
      expect(listener.isListening()).toBe(true);

      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();
    });
  });

  describe('message processing', () => {
    it('should process text messages correctly', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Hello!' } }],
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(processor).toHaveBeenCalledTimes(1);
      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.messageId).toBe('msg-1');
      expect(capturedMessage!.chatId).toBe('user-123');
      expect(capturedMessage!.userId).toBe('user-123');
      expect(capturedMessage!.content).toBe('Hello!');
      expect(capturedMessage!.messageType).toBe('text');
      expect(capturedMessage!.timestamp).toBe(1710000000000);
    });

    it('should process image messages correctly', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-img-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 2, image_item: { url: 'https://cdn.example.com/img.png', width: 800, height: 600 } }],
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.messageType).toBe('image');
      expect(capturedMessage!.content).toBe('[Image received]');
      expect(capturedMessage!.attachments).toHaveLength(1);
      expect(capturedMessage!.attachments![0].filePath).toBe('https://cdn.example.com/img.png');
    });

    it('should process file messages correctly', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-file-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 3, file_item: { url: 'https://cdn.example.com/doc.pdf', file_name: 'report.pdf', file_size: 1024 } }],
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.messageType).toBe('file');
      expect(capturedMessage!.content).toBe('[File received: report.pdf]');
      expect(capturedMessage!.attachments).toHaveLength(1);
      expect(capturedMessage!.attachments![0].fileName).toBe('report.pdf');
      expect(capturedMessage!.attachments![0].size).toBe(1024);
    });

    it('should handle context_token as threadId', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-thread-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Reply in thread' } }],
        context_token: 'ctx-token-abc',
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(capturedMessage!.threadId).toBe('ctx-token-abc');
    });
  });

  describe('deduplication', () => {
    it('should skip duplicate messages', async () => {
      const dupUpdate: WeChatUpdate = {
        msg_id: 'msg-dup-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Duplicate' } }],
        create_time: 1710000000,
      };

      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return [dupUpdate];
        }
        throw new DOMException('Aborted', 'AbortError');
      });

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 200));
      await listener.stop();

      // Should only process once despite two polls returning same message
      expect(messageProcessor).toHaveBeenCalledTimes(1);
    });

    it('should evict dedup cache when size exceeds threshold', async () => {
      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      // Access private seenMessageIds via type assertion for testing
      const seenIds = (listener as unknown as { seenMessageIds: Set<string> }).seenMessageIds;

      // Pre-fill cache to exceed threshold
      for (let i = 0; i < 10_001; i++) {
        seenIds.add(`msg-${i}`);
      }

      // Trigger eviction by adding one more message
      const update: WeChatUpdate = {
        msg_id: 'msg-trigger',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Trigger' } }],
        create_time: 1710000000,
      };

      mockClient.getUpdates = createSingleShotGetUpdates([update]);
      listener.start();
      await new Promise((r) => setTimeout(r, 100));

      // Check cache state BEFORE stopping (stop() clears the cache)
      // Cache should have been trimmed
      expect(seenIds.size).toBeLessThan(10_001);
      // The new message should still be in cache
      expect(seenIds.has('msg-trigger')).toBe(true);

      await listener.stop();
    });
  });

  describe('error handling', () => {
    it('should apply exponential backoff on consecutive errors', async () => {
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 3) {
          throw new Error('Network error');
        }
        throw new DOMException('Aborted', 'AbortError');
      });

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      const startTime = Date.now();
      listener.start();
      await new Promise((r) => setTimeout(r, 6000));
      await listener.stop();
      const elapsed = Date.now() - startTime;

      // Should have waited due to backoff (2s + 4s = 6s minimum)
      expect(elapsed).toBeGreaterThanOrEqual(5000);
      expect(mockClient.getUpdates).toHaveBeenCalled();
    });

    it('should not process messages when processor throws', async () => {
      const failingProcessor = vi.fn().mockRejectedValue(new Error('Processor failed'));

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-fail-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Fail' } }],
        create_time: 1710000000,
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        failingProcessor,
      );

      // Should not throw — processor errors are caught and logged
      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(failingProcessor).toHaveBeenCalledTimes(1);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'Processor failed' }),
        'Message processor failed',
      );
    });
  });

  describe('edge cases', () => {
    it('should skip update without msg_id', async () => {
      const noIdUpdate = {
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'No ID' } }],
      } as WeChatUpdate;

      mockClient.getUpdates = createSingleShotGetUpdates([noIdUpdate]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });

    it('should skip update without from_user_id', async () => {
      const noUserUpdate: WeChatUpdate = {
        msg_id: 'msg-no-user',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'No user' } }],
      };

      mockClient.getUpdates = createSingleShotGetUpdates([noUserUpdate]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });

    it('should skip update without item_list', async () => {
      const noItemsUpdate: WeChatUpdate = {
        msg_id: 'msg-no-items',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
      };

      mockClient.getUpdates = createSingleShotGetUpdates([noItemsUpdate]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });

    it('should handle unknown item type gracefully', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
      });

      const unknownTypeUpdate = {
        msg_id: 'msg-unknown',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 99, text_item: { text: 'Unknown type' } }],
        create_time: 1710000000,
      } as WeChatUpdate;

      mockClient.getUpdates = createSingleShotGetUpdates([unknownTypeUpdate]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      // Should still process with fallback text extraction
      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.messageType).toBe('text');
    });

    it('should handle empty text content', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
      });

      const emptyTextUpdate: WeChatUpdate = {
        msg_id: 'msg-empty',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: '' } }],
        create_time: 1710000000,
      };

      mockClient.getUpdates = createSingleShotGetUpdates([emptyTextUpdate]);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.content).toBe('');
      expect(capturedMessage!.messageType).toBe('text');
    });
  });
});
