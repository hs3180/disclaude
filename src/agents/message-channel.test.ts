/**
 * Tests for MessageChannel.
 *
 * @module agents/message-channel.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageChannel } from './message-channel.js';
import type { StreamingUserMessage } from '../sdk/index.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Helper to create test messages
function createTestMessage(content: string): StreamingUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    session_id: 'test-session',
  };
}

describe('MessageChannel', () => {
  let channel: MessageChannel;

  beforeEach(() => {
    channel = new MessageChannel();
  });

  afterEach(() => {
    channel.close();
  });

  describe('push', () => {
    it('should push message to queue', () => {
      channel.push(createTestMessage('test message'));

      expect(channel.isClosed()).toBe(false);
    });

    it('should ignore push to closed channel', async () => {
      channel.close();
      channel.push(createTestMessage('test message'));

      // Message should not be added (queue should be empty)
      const messages: StreamingUserMessage[] = [];
      for await (const msg of channel.generator()) {
        messages.push(msg);
      }
      expect(messages.length).toBe(0);
    });
  });

  describe('generator', () => {
    it('should yield pushed messages', async () => {
      channel.push(createTestMessage('message 1'));
      channel.push(createTestMessage('message 2'));
      channel.close();

      const messages: StreamingUserMessage[] = [];
      for await (const msg of channel.generator()) {
        messages.push(msg);
      }

      expect(messages.length).toBe(2);
      expect((messages[0].message as { content: string }).content).toBe('message 1');
      expect((messages[1].message as { content: string }).content).toBe('message 2');
    });

    it('should yield messages as they arrive', async () => {
      const messages: StreamingUserMessage[] = [];

      // Start consuming in background
      const consumer = (async () => {
        for await (const msg of channel.generator()) {
          messages.push(msg);
        }
      })();

      // Push messages after a short delay
      setTimeout(() => {
        channel.push(createTestMessage('async message'));
        channel.close();
      }, 10);

      await consumer;

      expect(messages.length).toBe(1);
      expect((messages[0].message as { content: string }).content).toBe('async message');
    });

    it('should exit when closed and queue is empty', async () => {
      channel.close();

      const messages: StreamingUserMessage[] = [];
      for await (const msg of channel.generator()) {
        messages.push(msg);
      }

      expect(messages.length).toBe(0);
    });
  });

  describe('close', () => {
    it('should close the channel', () => {
      expect(channel.isClosed()).toBe(false);

      channel.close();

      expect(channel.isClosed()).toBe(true);
    });

    it('should resolve pending generator wait', async () => {
      const messages: StreamingUserMessage[] = [];

      const consumer = (async () => {
        for await (const msg of channel.generator()) {
          messages.push(msg);
        }
      })();

      // Close after a short delay
      setTimeout(() => channel.close(), 10);

      await consumer;

      expect(messages.length).toBe(0);
    });
  });

  describe('isClosed', () => {
    it('should return false initially', () => {
      expect(channel.isClosed()).toBe(false);
    });

    it('should return true after close', () => {
      channel.close();
      expect(channel.isClosed()).toBe(true);
    });
  });
});
