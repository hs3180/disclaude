/**
 * Tests for WeChatMessageListener.
 *
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatMessageListener } from './message-listener.js';
import type { WeChatRawMessage } from './types.js';
import { DEFAULT_LISTENER_CONFIG } from './types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createRawMessage(overrides: Partial<WeChatRawMessage> = {}): WeChatRawMessage {
  return {
    msg_id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    from_user_id: 'user-123',
    to_user_id: 'bot-456',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: 'Hello!' } }],
    context_token: undefined,
    create_time: Math.floor(Date.now() / 1000),
    source: 'user',
    ...overrides,
  };
}

function createGetUpdatesResponse(messages: WeChatRawMessage[] = []) {
  return { ret: 0, msg_list: messages };
}

// ---------------------------------------------------------------------------
// Mock API Client
// ---------------------------------------------------------------------------

const mockGetUpdates = vi.fn();

function createMockClient(token = true) {
  return {
    hasToken: vi.fn().mockReturnValue(token),
    getUpdates: mockGetUpdates,
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WeChatMessageListener', () => {
  let mockHandler: ReturnType<typeof vi.fn>;
  let listener: WeChatMessageListener | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockHandler = vi.fn().mockResolvedValue(undefined);
    mockGetUpdates.mockResolvedValue(createGetUpdatesResponse([]));
  });

  afterEach(async () => {
    // Stop listener BEFORE restoring timers to ensure clean shutdown
    if (listener?.isRunning()) {
      await listener.stop();
    }
    listener = undefined;
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Constructor
  // -------------------------------------------------------------------------
  describe('constructor', () => {
    it('should merge config with defaults', () => {
      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler, { dedupMaxSize: 100 });

      expect((listener as any).config.dedupMaxSize).toBe(100);
      expect((listener as any).config.pollTimeoutMs).toBe(DEFAULT_LISTENER_CONFIG.pollTimeoutMs);
    });

    it('should use default config when none provided', () => {
      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);

      expect((listener as any).config.dedupMaxSize).toBe(DEFAULT_LISTENER_CONFIG.dedupMaxSize);
      expect((listener as any).config.maxConsecutiveErrors).toBe(DEFAULT_LISTENER_CONFIG.maxConsecutiveErrors);
    });
  });

  // -------------------------------------------------------------------------
  // Start / Stop lifecycle
  // -------------------------------------------------------------------------
  describe('start/stop', () => {
    it('should throw if no bot token is set', () => {
      const client = createMockClient(false);
      listener = new WeChatMessageListener(client, mockHandler);

      expect(() => listener!.start()).toThrow('without bot token');
    });

    it('should start polling loop', async () => {
      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);

      listener.start();
      expect(listener.isRunning()).toBe(true);

      // Let the first poll cycle run
      await vi.advanceTimersByTimeAsync(100);

      // getUpdates should have been called
      expect(mockGetUpdates).toHaveBeenCalled();

      await listener.stop();
      expect(listener.isRunning()).toBe(false);
    });

    it('should be a no-op when starting an already running listener', () => {
      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);

      listener!.start();
      expect(() => listener!.start()).not.toThrow();
      expect(listener!.isRunning()).toBe(true);
    });

    it('should be a no-op when stopping an already stopped listener', async () => {
      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);

      await listener.stop(); // not started
      expect(listener.isRunning()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Message processing
  // -------------------------------------------------------------------------
  describe('message processing', () => {
    it('should dispatch text messages to handler', async () => {
      const msg = createRawMessage({ message_type: 1, item_list: [{ type: 1, text_item: { text: 'Hello!' } }] });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockHandler).toHaveBeenCalledTimes(1);
      const incomingMsg = mockHandler.mock.calls[0][0];
      expect(incomingMsg.messageId).toBe(msg.msg_id);
      expect(incomingMsg.chatId).toBe('user-123');
      expect(incomingMsg.userId).toBe('user-123');
      expect(incomingMsg.content).toBe('Hello!');
      expect(incomingMsg.messageType).toBe('text');

      await listener.stop();
    });

    it('should parse image messages', async () => {
      const msg = createRawMessage({
        message_type: 2,
        item_list: [{ type: 2, image_item: { image_url: 'https://example.com/img.png' } }],
      });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockHandler).toHaveBeenCalledTimes(1);
      const incomingMsg = mockHandler.mock.calls[0][0];
      expect(incomingMsg.messageType).toBe('image');
      expect(incomingMsg.content).toBe('https://example.com/img.png');

      await listener.stop();
    });

    it('should parse file messages', async () => {
      const msg = createRawMessage({
        message_type: 3,
        item_list: [{ type: 3, file_item: { file_name: 'report.pdf', file_size: 1024 } }],
      });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockHandler).toHaveBeenCalledTimes(1);
      const incomingMsg = mockHandler.mock.calls[0][0];
      expect(incomingMsg.messageType).toBe('file');
      expect(incomingMsg.content).toBe('report.pdf');

      await listener.stop();
    });

    it('should set threadId from context_token', async () => {
      const msg = createRawMessage({ context_token: 'ctx-abc-123' });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockHandler).toHaveBeenCalledTimes(1);
      const incomingMsg = mockHandler.mock.calls[0][0];
      expect(incomingMsg.threadId).toBe('ctx-abc-123');

      await listener.stop();
    });

    it('should include timestamp from create_time', async () => {
      const timestamp = 1700000000;
      const msg = createRawMessage({ create_time: timestamp });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockHandler).toHaveBeenCalledTimes(1);
      const incomingMsg = mockHandler.mock.calls[0][0];
      expect(incomingMsg.timestamp).toBe(timestamp * 1000);

      await listener.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Deduplication
  // -------------------------------------------------------------------------
  describe('deduplication', () => {
    it('should not dispatch duplicate messages', async () => {
      const msg = createRawMessage({ msg_id: 'dup-msg-1' });
      mockGetUpdates
        .mockResolvedValueOnce(createGetUpdatesResponse([msg]))
        .mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      // Let both polls run
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockHandler).toHaveBeenCalledTimes(1); // deduped on second poll

      await listener.stop();
    });

    it('should evict old entries when dedup set exceeds maxSize', async () => {
      const maxSize = 5;
      // Send maxSize + 1 unique messages in one batch
      const messages: WeChatRawMessage[] = [];
      for (let i = 0; i <= maxSize; i++) {
        messages.push(createRawMessage({ msg_id: `eviction-msg-${i}` }));
      }

      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse(messages));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler, { dedupMaxSize: maxSize });
      listener.start();

      // Advance enough for the poll to complete and process all messages
      await vi.advanceTimersByTimeAsync(2000);

      expect(mockHandler).toHaveBeenCalledTimes(maxSize + 1);

      // Now the first message should have been evicted from dedup set
      const seenIds = (listener as any).seenIds;
      expect(seenIds.has('eviction-msg-0')).toBe(false);
      expect(seenIds.has(`eviction-msg-${maxSize}`)).toBe(true);

      await listener.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Self-message filtering
  // -------------------------------------------------------------------------
  describe('self-message filtering', () => {
    it('should skip messages from self (bot)', async () => {
      const msg = createRawMessage({ source: 'bot' });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);
      expect(mockHandler).not.toHaveBeenCalled();

      await listener.stop();
    });

    it('should skip messages where from_user_id equals to_user_id', async () => {
      const msg = createRawMessage({ from_user_id: 'bot-456', to_user_id: 'bot-456' });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);
      expect(mockHandler).not.toHaveBeenCalled();

      await listener.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------
  describe('error handling', () => {
    it('should retry on transient errors with backoff', async () => {
      mockGetUpdates
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce(createGetUpdatesResponse([]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler, {
        maxConsecutiveErrors: 10,
        backoffBaseMs: 100,
        backoffMaxMs: 500,
        pollIntervalMs: 100,
      });
      listener.start();

      // Advance past the first poll (error) + backoff (~100ms) + second poll
      await vi.advanceTimersByTimeAsync(1000);

      // Should have retried at least twice (error + success)
      expect(mockGetUpdates.mock.calls.length).toBeGreaterThanOrEqual(2);

      await listener.stop();
    });

    it('should stop after max consecutive errors', async () => {
      mockGetUpdates.mockRejectedValue(new Error('Persistent error'));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler, {
        maxConsecutiveErrors: 3,
        backoffBaseMs: 50,
        backoffMaxMs: 100,
        pollIntervalMs: 50,
      });
      listener.start();

      // Advance enough time for backoff: 50 + 100 + 200 = 350ms
      await vi.advanceTimersByTimeAsync(2000);

      expect(listener.isRunning()).toBe(false);
      // Should have tried at least maxConsecutiveErrors times
      expect(mockGetUpdates.mock.calls.length).toBeGreaterThanOrEqual(3);
    });

    it('should continue when handler throws an error', async () => {
      const msg1 = createRawMessage({ msg_id: 'handler-error-msg-1' });
      const msg2 = createRawMessage({ msg_id: 'handler-error-msg-2' });

      mockHandler
        .mockRejectedValueOnce(new Error('Handler error'))
        .mockResolvedValueOnce(undefined);

      mockGetUpdates
        .mockResolvedValueOnce(createGetUpdatesResponse([msg1]))
        .mockResolvedValueOnce(createGetUpdatesResponse([msg2]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler, {
        pollIntervalMs: 100,
      });
      listener.start();

      await vi.advanceTimersByTimeAsync(2000);

      // Both messages should be processed (handler error doesn't stop the loop)
      expect(mockHandler).toHaveBeenCalledTimes(2);

      await listener.stop();
    });

    it('should recover after transient errors and process messages', async () => {
      const msg = createRawMessage({ msg_id: 'recovery-msg' });

      mockGetUpdates
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce(createGetUpdatesResponse([msg]))
        .mockResolvedValue(createGetUpdatesResponse([]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler, {
        maxConsecutiveErrors: 5,
        backoffBaseMs: 50,
        backoffMaxMs: 200,
        pollIntervalMs: 100,
      });
      listener.start();

      // Advance past first poll (error) + backoff (~50ms) + second poll (success)
      await vi.advanceTimersByTimeAsync(2000);

      // Should have recovered and processed the message
      expect(mockHandler).toHaveBeenCalledTimes(1);

      await listener.stop();
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
  describe('edge cases', () => {
    it('should skip messages without msg_id', async () => {
      const msg = createRawMessage({ msg_id: undefined });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);
      expect(mockHandler).not.toHaveBeenCalled();

      await listener.stop();
    });

    it('should skip messages without from_user_id', async () => {
      const msg = createRawMessage({ from_user_id: undefined });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);
      expect(mockHandler).not.toHaveBeenCalled();

      await listener.stop();
    });

    it('should handle empty msg_list', async () => {
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler, {
        pollIntervalMs: 100,
      });
      listener.start();

      await vi.advanceTimersByTimeAsync(500);

      // Should have polled but not called handler
      expect(mockGetUpdates).toHaveBeenCalled();
      expect(mockHandler).not.toHaveBeenCalled();

      await listener.stop();
    });

    it('should handle multiple messages in single poll', async () => {
      const msg1 = createRawMessage({ msg_id: 'multi-msg-1', from_user_id: 'user-1' });
      const msg2 = createRawMessage({ msg_id: 'multi-msg-2', from_user_id: 'user-2' });
      const msg3 = createRawMessage({ msg_id: 'multi-msg-3', from_user_id: 'user-3' });

      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg1, msg2, msg3]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockHandler).toHaveBeenCalledTimes(3);

      await listener.stop();
    });

    it('should handle unknown message type as text', async () => {
      const msg = createRawMessage({ message_type: 99 });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);

      expect(mockHandler).toHaveBeenCalledTimes(1);
      const incomingMsg = mockHandler.mock.calls[0][0];
      expect(incomingMsg.messageType).toBe('text');

      await listener.stop();
    });

    it('should include metadata in parsed message', async () => {
      const msg = createRawMessage({
        to_user_id: 'bot-target',
        client_id: 'client-abc',
        source: 'user',
        message_type: 1,
      });
      mockGetUpdates.mockResolvedValueOnce(createGetUpdatesResponse([msg]));

      const client = createMockClient();
      listener = new WeChatMessageListener(client, mockHandler);
      listener.start();

      await vi.advanceTimersByTimeAsync(200);

      const incomingMsg = mockHandler.mock.calls[0][0];
      expect(incomingMsg.metadata).toEqual({
        toUserId: 'bot-target',
        clientId: 'client-abc',
        source: 'user',
        rawMessageType: 1,
      });

      await listener.stop();
    });
  });
});
