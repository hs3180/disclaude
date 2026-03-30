/**
 * Tests for WeChatMessageListener (Phase 3.1).
 *
 * @see Issue #1557 - WeChat Channel Dynamic Registration Roadmap
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WeChatMessageListener } from './message-listener.js';
import type { IncomingMessage } from '@disclaude/core';

// Helper to create a mock WeChat update
function createMockUpdate(overrides: Record<string, unknown> = {}) {
  return {
    msg_id: 'msg-1',
    from_user_id: 'user-123',
    to_user_id: 'bot-456',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: 'Hello!' } }],
    context_token: 'ctx-abc',
    create_time: 1_700_000_000,
    ...overrides,
  };
}

/**
 * Create a controlled mock client where getUpdates resolves
 * with the given sequence of results, then hangs (never resolves).
 * This prevents the poll loop from running forever.
 */
function createControlledClient(results: unknown[]) {
  let callCount = 0;
  const pending = new Promise<never>(() => {}); // never resolves

  return {
    getUpdates: vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= results.length) {
        return Promise.resolve(results[callCount - 1]);
      }
      // After all results are consumed, hang forever to stop the loop
      return pending;
    }),
    getCallCount: () => callCount,
  };
}

describe('WeChatMessageListener', () => {
  let mockClient: ReturnType<typeof createControlledClient>;
  let mockOnMessage: ReturnType<typeof vi.fn>;
  let listener: WeChatMessageListener;

  beforeEach(() => {
    mockOnMessage = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    // Always stop the listener to clean up
    if (listener) {
      listener.stop();
    }
  });

  describe('constructor', () => {
    it('should create listener with default poll timeout', () => {
      mockClient = createControlledClient([]);
      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      expect(listener.isRunning()).toBe(false);
    });

    it('should create listener with custom poll timeout', () => {
      mockClient = createControlledClient([]);
      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
        pollTimeout: 10_000,
      });
      expect(listener.isRunning()).toBe(false);
    });
  });

  describe('start / stop', () => {
    it('should start the polling loop', () => {
      mockClient = createControlledClient([]);
      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();
      expect(listener.isRunning()).toBe(true);
    });

    it('should warn when starting an already running listener', () => {
      mockClient = createControlledClient([]);
      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();
      // Starting again should not throw
      listener.start();
      expect(listener.isRunning()).toBe(true);
    });

    it('should stop the polling loop', () => {
      mockClient = createControlledClient([]);
      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();
      listener.stop();
      expect(listener.isRunning()).toBe(false);
    });

    it('should be safe to call stop when not running', () => {
      mockClient = createControlledClient([]);
      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      // Should not throw
      listener.stop();
      expect(listener.isRunning()).toBe(false);
    });
  });

  describe('message processing', () => {
    it('should forward incoming messages to callback', async () => {
      const update = createMockUpdate();
      mockClient = createControlledClient([[update]]);

      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();

      // Wait for the callback to be called
      await vi.waitFor(() => {
        expect(mockOnMessage).toHaveBeenCalledTimes(1);
      }, { timeout: 5000 });

      expect(mockOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-1',
          chatId: 'user-123',
          userId: 'user-123',
          content: 'Hello!',
          messageType: 'text',
          threadId: 'ctx-abc',
        })
      );
    });

    it('should deduplicate messages with same msg_id', async () => {
      const update = createMockUpdate();
      // Return same update twice, then empty
      mockClient = createControlledClient([[update], [update], []]);

      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();

      // Wait for both polls to complete
      await vi.waitFor(() => {
        expect(mockClient.getCallCount()).toBeGreaterThanOrEqual(2);
      }, { timeout: 5000 });

      // Should only call onMessage once (second poll is deduped)
      expect(mockOnMessage).toHaveBeenCalledTimes(1);
    });

    it('should handle empty update list', async () => {
      mockClient = createControlledClient([[]]);

      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();

      await vi.waitFor(() => {
        expect(mockClient.getCallCount()).toBeGreaterThanOrEqual(1);
      }, { timeout: 5000 });

      expect(mockOnMessage).not.toHaveBeenCalled();
    });

    it('should handle messages without item_list', async () => {
      const update = createMockUpdate({ item_list: undefined });
      mockClient = createControlledClient([[update]]);

      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();

      await vi.waitFor(() => {
        expect(mockOnMessage).toHaveBeenCalled();
      }, { timeout: 5000 });

      expect(mockOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-1',
          content: '',
        })
      );
    });

    it('should handle messages without context_token', async () => {
      const update = createMockUpdate({ context_token: undefined });
      mockClient = createControlledClient([[update]]);

      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();

      await vi.waitFor(() => {
        expect(mockOnMessage).toHaveBeenCalled();
      }, { timeout: 5000 });

      const message = mockOnMessage.mock.calls[0][0] as IncomingMessage;
      expect(message.threadId).toBeUndefined();
    });

    it('should detect image message type (message_type=3)', async () => {
      const update = createMockUpdate({ message_type: 3 });
      mockClient = createControlledClient([[update]]);

      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();

      await vi.waitFor(() => {
        expect(mockOnMessage).toHaveBeenCalled();
      }, { timeout: 5000 });

      expect(mockOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageType: 'image',
        })
      );
    });

    it('should detect file message type (message_type=6)', async () => {
      const update = createMockUpdate({ message_type: 6 });
      mockClient = createControlledClient([[update]]);

      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();

      await vi.waitFor(() => {
        expect(mockOnMessage).toHaveBeenCalled();
      }, { timeout: 5000 });

      expect(mockOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageType: 'file',
        })
      );
    });

    it('should process multiple updates in a single poll', async () => {
      const update1 = createMockUpdate({ msg_id: 'msg-1', from_user_id: 'user-1' });
      const update2 = createMockUpdate({ msg_id: 'msg-2', from_user_id: 'user-2' });
      mockClient = createControlledClient([[update1, update2]]);

      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();

      await vi.waitFor(() => {
        expect(mockOnMessage).toHaveBeenCalledTimes(2);
      }, { timeout: 5000 });

      expect(mockOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'user-1' })
      );
      expect(mockOnMessage).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'user-2' })
      );
    });
  });

  describe('error handling', () => {
    it('should continue polling after transient error', async () => {
      // First call errors, second returns empty
      mockClient = {
        getUpdates: vi.fn()
          .mockRejectedValueOnce(new Error('Network error'))
          .mockResolvedValueOnce([])
          .mockImplementation(() => new Promise<never>(() => {})),
        getCallCount: () => mockClient.getUpdates.mock.calls.length,
      };

      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();

      // Wait for the second poll (after backoff + error recovery)
      await vi.waitFor(() => {
        expect(mockClient.getCallCount()).toBeGreaterThanOrEqual(2);
      }, { timeout: 60_000 }); // generous timeout for backoff

      expect(listener.isRunning()).toBe(true);
    });

    it('should catch errors from message callback without crashing', async () => {
      mockOnMessage.mockRejectedValueOnce(new Error('Handler error'));
      const update = createMockUpdate();
      mockClient = createControlledClient([[update]]);

      listener = new WeChatMessageListener({
        client: mockClient as any,
        onMessage: mockOnMessage,
      });
      listener.start();

      // Should not throw, should continue polling
      await vi.waitFor(() => {
        expect(mockOnMessage).toHaveBeenCalled();
      }, { timeout: 5000 });

      // Listener should still be running despite callback error
      expect(listener.isRunning()).toBe(true);
    });
  });
});
