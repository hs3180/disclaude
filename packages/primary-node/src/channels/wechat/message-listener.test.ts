/**
 * Tests for WeChatMessageListener.
 *
 * Tests the long-poll based message listener with mocked API client.
 * Pattern matches existing wechat test files (no @disclaude/core mock).
 *
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { WeChatMessageListener } from './message-listener.js';
import type { IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatUpdate } from './types.js';

/**
 * Helper: create a mock API client with controllable getUpdates.
 */
function createMockClient(getUpdatesFn: Mock) {
  return {
    getUpdates: getUpdatesFn,
    hasToken: vi.fn().mockReturnValue(true),
  } as unknown as WeChatApiClient;
}

describe('WeChatMessageListener', () => {
  let mockProcessor: Mock;
  let mockGetUpdates: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcessor = vi.fn().mockResolvedValue(undefined);
    mockGetUpdates = vi.fn();
  });

  describe('start / stop', () => {
    it('should start and report as listening', () => {
      mockGetUpdates.mockRejectedValue(
        Object.assign(new Error('Aborted'), { name: 'AbortError' }),
      );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      expect(listener.isListening()).toBe(true);
    });

    it('should stop and report as not listening', async () => {
      mockGetUpdates.mockRejectedValue(
        Object.assign(new Error('Aborted'), { name: 'AbortError' }),
      );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 10));
      await listener.stop();

      expect(listener.isListening()).toBe(false);
    });

    it('should be safe to call stop multiple times', async () => {
      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      await listener.stop();
      await listener.stop();

      expect(listener.isListening()).toBe(false);
    });

    it('should warn when start is called while already listening', () => {
      mockGetUpdates.mockRejectedValue(
        Object.assign(new Error('Aborted'), { name: 'AbortError' }),
      );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      listener.start();

      expect(listener.isListening()).toBe(true);
    });
  });

  describe('message processing', () => {
    it('should process text messages from getUpdates', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-1',
        from_user_id: 'user-123',
        to_user_id: 'bot-456',
        item_list: [{ type: 1, text_item: { text: 'Hello bot!' } }],
        create_time: 1710000000,
      };

      mockGetUpdates
        .mockResolvedValueOnce([update])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      const processedMsg = mockProcessor.mock.calls[0][0] as IncomingMessage;
      expect(processedMsg.messageId).toBe('msg-1');
      expect(processedMsg.chatId).toBe('user-123');
      expect(processedMsg.userId).toBe('user-123');
      expect(processedMsg.content).toBe('Hello bot!');
      expect(processedMsg.messageType).toBe('text');
      expect(processedMsg.timestamp).toBe(1710000000000);
    });

    it('should convert image messages', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-img-1',
        from_user_id: 'user-456',
        item_list: [{ type: 2, image_item: { url: 'https://cdn.example.com/img.png', width: 800, height: 600 } }],
        create_time: 1710000001,
      };

      mockGetUpdates
        .mockResolvedValueOnce([update])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      const msg = mockProcessor.mock.calls[0][0] as IncomingMessage;
      expect(msg.messageType).toBe('image');
      expect(msg.content).toBe('[Image received]');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0].filePath).toBe('https://cdn.example.com/img.png');
    });

    it('should convert file messages', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-file-1',
        from_user_id: 'user-789',
        item_list: [{ type: 3, file_item: { url: 'https://cdn.example.com/doc.pdf', file_name: 'report.pdf', file_size: 102400 } }],
        create_time: 1710000002,
      };

      mockGetUpdates
        .mockResolvedValueOnce([update])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      const msg = mockProcessor.mock.calls[0][0] as IncomingMessage;
      expect(msg.messageType).toBe('file');
      expect(msg.content).toBe('[File received: report.pdf]');
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0].fileName).toBe('report.pdf');
      expect(msg.attachments![0].size).toBe(102400);
    });

    it('should handle unknown message types', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-unknown-1',
        from_user_id: 'user-100',
        item_list: [{ type: 99 } as any],
        create_time: 1710000003,
      };

      mockGetUpdates
        .mockResolvedValueOnce([update])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1);
      const msg = mockProcessor.mock.calls[0][0] as IncomingMessage;
      expect(msg.messageType).toBe('text');
      expect(msg.content).toBe('[Unsupported message type: 99]');
    });

    it('should include context_token as threadId', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-thread-1',
        from_user_id: 'user-200',
        item_list: [{ type: 1, text_item: { text: 'Reply' } }],
        context_token: 'ctx-abc-123',
        create_time: 1710000004,
      };

      mockGetUpdates
        .mockResolvedValueOnce([update])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      const msg = mockProcessor.mock.calls[0][0] as IncomingMessage;
      expect(msg.threadId).toBe('ctx-abc-123');
    });

    it('should process multiple updates in a single poll', async () => {
      const updates: WeChatUpdate[] = [
        {
          msg_id: 'msg-multi-1',
          from_user_id: 'user-a',
          item_list: [{ type: 1, text_item: { text: 'First' } }],
        },
        {
          msg_id: 'msg-multi-2',
          from_user_id: 'user-b',
          item_list: [{ type: 1, text_item: { text: 'Second' } }],
        },
      ];

      mockGetUpdates
        .mockResolvedValueOnce(updates)
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(2);
    });
  });

  describe('deduplication', () => {
    it('should skip duplicate messages', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-dup-1',
        from_user_id: 'user-300',
        item_list: [{ type: 1, text_item: { text: 'Duplicate' } }],
        create_time: 1710000005,
      };

      mockGetUpdates
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([update])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 30));
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1); // Only processed once
    });

    it('should skip updates without msg_id', async () => {
      const update = {
        from_user_id: 'user-400',
        item_list: [{ type: 1, text_item: { text: 'No ID' } }],
      } as WeChatUpdate;

      mockGetUpdates
        .mockResolvedValueOnce([update])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      expect(mockProcessor).not.toHaveBeenCalled();
    });

    it('should skip updates without from_user_id or item_list', async () => {
      const update1: WeChatUpdate = {
        msg_id: 'msg-no-from',
        item_list: [{ type: 1, text_item: { text: 'No from' } }],
      };
      const update2: WeChatUpdate = {
        msg_id: 'msg-no-items',
        from_user_id: 'user-500',
      };

      mockGetUpdates
        .mockResolvedValueOnce([update1, update2])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      expect(mockProcessor).not.toHaveBeenCalled();
    });
  });

  describe('FIFO eviction', () => {
    it('should evict oldest entries when dedup set exceeds max size', async () => {
      const updates: WeChatUpdate[] = [];
      for (let i = 0; i <= 100; i++) {
        updates.push({
          msg_id: `msg-evict-${i}`,
          from_user_id: 'user-evict',
          item_list: [{ type: 1, text_item: { text: `Message ${i}` } }],
          create_time: 1710000000 + i,
        });
      }

      mockGetUpdates
        .mockResolvedValueOnce(updates)
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor, {
        dedupMaxSize: 50,
        dedupEvictCount: 25,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 50));
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(101);
    });

    it('should not evict when below max size', async () => {
      const updates: WeChatUpdate[] = [];
      for (let i = 0; i < 10; i++) {
        updates.push({
          msg_id: `msg-no-evict-${i}`,
          from_user_id: 'user-no-evict',
          item_list: [{ type: 1, text_item: { text: `Message ${i}` } }],
        });
      }

      mockGetUpdates
        .mockResolvedValueOnce(updates)
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor, {
        dedupMaxSize: 100,
        dedupEvictCount: 50,
      });

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(10);
    });
  });

  describe('error handling', () => {
    it('should catch processor errors without stopping the listener', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-err-1',
        from_user_id: 'user-600',
        item_list: [{ type: 1, text_item: { text: 'Causes error' } }],
        create_time: 1710000006,
      };

      mockProcessor.mockRejectedValue(new Error('Processor failed'));

      mockGetUpdates
        .mockResolvedValueOnce([update])
        .mockResolvedValueOnce([])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 30));
      await listener.stop();

      expect(mockProcessor).toHaveBeenCalledTimes(1);
    });

    it('should stop poll loop on AbortError from getUpdates', async () => {
      mockGetUpdates.mockRejectedValue(
        Object.assign(new Error('Aborted'), { name: 'AbortError' }),
      );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      expect(mockProcessor).not.toHaveBeenCalled();
    });
  });

  describe('timestamp handling', () => {
    it('should use create_time when available', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-ts-1',
        from_user_id: 'user-700',
        item_list: [{ type: 1, text_item: { text: 'Timestamped' } }],
        create_time: 1715000000,
      };

      mockGetUpdates
        .mockResolvedValueOnce([update])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();

      const msg = mockProcessor.mock.calls[0][0] as IncomingMessage;
      expect(msg.timestamp).toBe(1715000000000); // seconds * 1000
    });

    it('should use Date.now() when create_time is missing', async () => {
      const update: WeChatUpdate = {
        msg_id: 'msg-ts-2',
        from_user_id: 'user-800',
        item_list: [{ type: 1, text_item: { text: 'No timestamp' } }],
      };

      mockGetUpdates
        .mockResolvedValueOnce([update])
        .mockRejectedValue(
          Object.assign(new Error('Aborted'), { name: 'AbortError' }),
        );

      const client = createMockClient(mockGetUpdates);
      const listener = new WeChatMessageListener(client, mockProcessor);

      const before = Date.now();
      listener.start();
      await new Promise((r) => setTimeout(r, 20));
      await listener.stop();
      const after = Date.now();

      const msg = mockProcessor.mock.calls[0][0] as IncomingMessage;
      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(after);
    });
  });
});
