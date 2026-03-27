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

      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.threadId).toBe('ctx-token-abc');
    });

    it('should handle unknown message type', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
      });

      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-unknown-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 99, text_item: { text: '' } } as any],
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
      expect(capturedMessage!.messageType).toBe('text');
      expect(capturedMessage!.content).toContain('Unsupported message type: 99');
    });

    it('should handle multiple messages in single poll', async () => {
      const updates: WeChatUpdate[] = [
        {
          msg_id: 'msg-1',
          from_user_id: 'user-123',
          item_list: [{ type: 1, text_item: { text: 'First' } }],
        },
        {
          msg_id: 'msg-2',
          from_user_id: 'user-123',
          item_list: [{ type: 1, text_item: { text: 'Second' } }],
        },
      ];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).toHaveBeenCalledTimes(2);
    });

    it('should skip messages without msg_id', async () => {
      const updates: WeChatUpdate[] = [{
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'No ID' } }],
      } as any];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });

    it('should skip messages without from_user_id', async () => {
      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-no-user',
        item_list: [{ type: 1, text_item: { text: 'No user' } }],
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).not.toHaveBeenCalled();
    });

    it('should deduplicate messages by msg_id', async () => {
      const updates: WeChatUpdate[] = [
        { msg_id: 'msg-dup-1', from_user_id: 'user-123', item_list: [{ type: 1, text_item: { text: 'Hello' } }] },
        { msg_id: 'msg-dup-1', from_user_id: 'user-123', item_list: [{ type: 1, text_item: { text: 'Hello again' } }] },
      ];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(messageProcessor).toHaveBeenCalledTimes(1);
    });

    it('should use current time when create_time is missing', async () => {
      let capturedMessage: IncomingMessage | undefined;
      const processor = vi.fn().mockImplementation(async (msg: IncomingMessage) => {
        capturedMessage = msg;
      });

      const beforeTime = Date.now();
      const updates: WeChatUpdate[] = [{
        msg_id: 'msg-no-time',
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: 'No time' } }],
      }];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        processor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();
      const afterTime = Date.now();

      expect(capturedMessage).toBeDefined();
      expect(capturedMessage!.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(capturedMessage!.timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should continue processing when processor throws', async () => {
      const updates: WeChatUpdate[] = [
        { msg_id: 'msg-err-1', from_user_id: 'user-123', item_list: [{ type: 1, text_item: { text: 'Error' } }] },
        { msg_id: 'msg-err-2', from_user_id: 'user-123', item_list: [{ type: 1, text_item: { text: 'OK' } }] },
      ];

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const failingProcessor = vi.fn()
        .mockRejectedValueOnce(new Error('Processor error'))
        .mockResolvedValueOnce(undefined);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        failingProcessor,
      );

      listener.start();
      await new Promise((r) => setTimeout(r, 100));
      await listener.stop();

      expect(failingProcessor).toHaveBeenCalledTimes(2);
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: 'Processor error' }),
        'Message processor failed',
      );
    });
  });

  describe('error handling', () => {
    it('should apply exponential backoff on errors', async () => {
      let callCount = 0;
      mockClient.getUpdates = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Network error');
        }
        // Third call: abort
        throw new DOMException('Aborted', 'AbortError');
      });

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      // Wait enough time for retries: backoff is 1s then 2s, so 4s should cover 3 calls
      await new Promise((r) => setTimeout(r, 5000));
      await listener.stop();

      expect(mockClient.getUpdates).toHaveBeenCalledTimes(3);
    });
  });

  describe('dedup cache eviction', () => {
    it('should evict old entries when cache exceeds max size', async () => {
      // Create 10001 updates to exceed MAX_DEDUP_CACHE_SIZE (10000)
      const updates: WeChatUpdate[] = Array.from({ length: 10001 }, (_, i) => ({
        msg_id: `msg-${i}`,
        from_user_id: 'user-123',
        item_list: [{ type: 1, text_item: { text: `Message ${i}` } }],
      }));

      mockClient.getUpdates = createSingleShotGetUpdates(updates);

      const listener = new WeChatMessageListener(
        mockClient as WeChatApiClient,
        messageProcessor,
      );

      listener.start();
      // Give more time for processing 10001 messages
      await new Promise((r) => setTimeout(r, 5000));
      await listener.stop();

      // All messages should be processed
      expect(messageProcessor).toHaveBeenCalledTimes(10001);

      // Dedup cache should have been trimmed
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ evicted: 5000 }),
        'Trimmed message dedup cache',
      );
    });
  });
});
