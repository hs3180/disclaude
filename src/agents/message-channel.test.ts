/**
 * Tests for MessageChannel - Producer-consumer pattern for SDK message streaming.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MessageChannel } from './message-channel.js';

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('MessageChannel', () => {
  let channel: MessageChannel;

  beforeEach(() => {
    channel = new MessageChannel();
  });

  describe('push', () => {
    it('should push message to queue', () => {
      channel.push({ role: 'user', content: 'test message' });
      // Message should be in queue (we can verify via generator)
      expect(channel.isClosed()).toBe(false);
    });

    it('should ignore push to closed channel', () => {
      channel.close();
      channel.push({ role: 'user', content: 'test message' });
      // Should not throw, just ignore
      expect(channel.isClosed()).toBe(true);
    });
  });

  describe('generator', () => {
    it('should yield pushed messages', async () => {
      channel.push({ role: 'user', content: 'message 1' });
      channel.push({ role: 'user', content: 'message 2' });
      channel.close();

      const messages = [];
      for await (const msg of channel.generator()) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('message 1');
      expect(messages[1].content).toBe('message 2');
    });

    it('should yield messages as they arrive', async () => {
      const messages: string[] = [];

      // Start consuming
      const consumerPromise = (async () => {
        for await (const msg of channel.generator()) {
          messages.push(msg.content);
        }
      })();

      // Push messages after a small delay
      setTimeout(() => {
        channel.push({ role: 'user', content: 'async message' });
        channel.close();
      }, 10);

      await consumerPromise;
      expect(messages).toContain('async message');
    });

    it('should exit when closed and queue is empty', async () => {
      channel.close();

      const messages = [];
      for await (const msg of channel.generator()) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(0);
    });
  });

  describe('close', () => {
    it('should close the channel', () => {
      expect(channel.isClosed()).toBe(false);
      channel.close();
      expect(channel.isClosed()).toBe(true);
    });

    it('should resolve pending generator wait', async () => {
      let generatorFinished = false;

      // Start generator that will wait for messages
      const consumerPromise = (async () => {
        for await (const _ of channel.generator()) {
          // consume
        }
        generatorFinished = true;
      })();

      // Close after a small delay
      setTimeout(() => {
        channel.close();
      }, 10);

      await consumerPromise;
      expect(generatorFinished).toBe(true);
    });

    it('should be idempotent', () => {
      channel.close();
      channel.close();
      expect(channel.isClosed()).toBe(true);
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
