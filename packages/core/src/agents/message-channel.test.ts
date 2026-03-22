/**
 * Unit tests for MessageChannel
 */

import { describe, it, expect, afterEach } from 'vitest';
import { MessageChannel } from './message-channel.js';
import type { StreamingUserMessage } from '../sdk/types.js';

// Helper to create a test message
function createTestMessage(content: string): StreamingUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
    parent_tool_use_id: null,
    session_id: 'test-session',
  };
}

describe('MessageChannel', () => {
  let channel: MessageChannel;

  afterEach(() => {
    if (channel && !channel.isClosed()) {
      channel.close();
    }
  });

  describe('constructor', () => {
    it('should create an open channel', () => {
      channel = new MessageChannel();
      expect(channel.isClosed()).toBe(false);
    });
  });

  describe('push', () => {
    it('should accept messages when open', () => {
      channel = new MessageChannel();
      const msg = createTestMessage('hello');

      expect(() => channel.push(msg)).not.toThrow();
    });

    it('should ignore push when closed', () => {
      channel = new MessageChannel();
      channel.close();

      // Should not throw, just ignore
      const msg = createTestMessage('hello');
      expect(() => channel.push(msg)).not.toThrow();
    });
  });

  describe('generator', () => {
    it('should yield pushed messages', async () => {
      channel = new MessageChannel();
      const msg1 = createTestMessage('hello');
      const msg2 = createTestMessage('world');

      channel.push(msg1);
      channel.push(msg2);
      channel.close();

      const results: StreamingUserMessage[] = [];
      for await (const msg of channel.generator()) {
        results.push(msg);
      }

      expect(results).toHaveLength(2);
      expect(results[0].message.content).toBe('hello');
      expect(results[1].message.content).toBe('world');
    });

    it('should yield messages pushed while iterating', async () => {
      channel = new MessageChannel();

      const msg1 = createTestMessage('first');
      channel.push(msg1);

      // Start the generator
      const iterator = channel.generator()[Symbol.asyncIterator]();

      // Get first message
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect((first.value.message.content as string)).toBe('first');

      // Push another message while iterating
      const msg2 = createTestMessage('second');
      channel.push(msg2);
      channel.close();

      // Get second message
      const second = await iterator.next();
      expect(second.done).toBe(false);
      expect((second.value.message.content as string)).toBe('second');

      // Generator should end
      const third = await iterator.next();
      expect(third.done).toBe(true);
    });

    it('should wait for messages when queue is empty', async () => {
      channel = new MessageChannel();

      const startPromise = (async () => {
        const results: StreamingUserMessage[] = [];
        for await (const msg of channel.generator()) {
          results.push(msg);
        }
        return results;
      })();

      // Wait a bit, then push a message and close
      await new Promise((resolve) => setTimeout(resolve, 10));
      channel.push(createTestMessage('delayed'));
      channel.close();

      const results = await startPromise;
      expect(results).toHaveLength(1);
      expect(results[0].message.content).toBe('delayed');
    });

    it('should drain remaining messages after close', async () => {
      channel = new MessageChannel();

      channel.push(createTestMessage('msg1'));
      channel.push(createTestMessage('msg2'));
      channel.push(createTestMessage('msg3'));
      channel.close();

      const results: StreamingUserMessage[] = [];
      for await (const msg of channel.generator()) {
        results.push(msg);
      }

      expect(results).toHaveLength(3);
    });

    it('should return immediately if closed with empty queue', async () => {
      channel = new MessageChannel();
      channel.close();

      const results: StreamingUserMessage[] = [];
      for await (const msg of channel.generator()) {
        results.push(msg);
      }

      expect(results).toHaveLength(0);
    });

    it('should handle rapid push and close', async () => {
      channel = new MessageChannel();

      // Push messages rapidly
      for (let i = 0; i < 10; i++) {
        channel.push(createTestMessage(`msg-${i}`));
      }
      channel.close();

      const results: StreamingUserMessage[] = [];
      for await (const msg of channel.generator()) {
        results.push(msg);
      }

      expect(results).toHaveLength(10);
    });
  });

  describe('close', () => {
    it('should close the channel', () => {
      channel = new MessageChannel();
      expect(channel.isClosed()).toBe(false);

      channel.close();

      expect(channel.isClosed()).toBe(true);
    });

    it('should be idempotent', () => {
      channel = new MessageChannel();

      channel.close();
      channel.close();
      channel.close();

      expect(channel.isClosed()).toBe(true);
    });

    it('should resolve pending generator wait', async () => {
      channel = new MessageChannel();

      const generatorPromise = (async () => {
        const results: StreamingUserMessage[] = [];
        for await (const msg of channel.generator()) {
          results.push(msg);
        }
        return results;
      })();

      // Close immediately
      channel.close();

      // Generator should complete quickly
      const results = await generatorPromise;
      expect(results).toHaveLength(0);
    });
  });

  describe('isClosed', () => {
    it('should return false for new channel', () => {
      channel = new MessageChannel();
      expect(channel.isClosed()).toBe(false);
    });

    it('should return true after close', () => {
      channel = new MessageChannel();
      channel.close();
      expect(channel.isClosed()).toBe(true);
    });
  });

  describe('integration scenarios', () => {
    it('should handle producer-consumer pattern', async () => {
      channel = new MessageChannel();
      const messageCount = 5;
      const producedMessages: string[] = [];
      const consumedMessages: string[] = [];

      // Producer
      const producer = async () => {
        for (let i = 0; i < messageCount; i++) {
          const content = `message-${i}`;
          channel.push(createTestMessage(content));
          producedMessages.push(content);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        channel.close();
      };

      // Consumer
      const consumer = async () => {
        for await (const msg of channel.generator()) {
          consumedMessages.push(msg.message.content as string);
        }
      };

      await Promise.all([producer(), consumer()]);

      expect(producedMessages).toEqual(consumedMessages);
      expect(consumedMessages).toHaveLength(messageCount);
    });

    it('should handle multiple close during iteration', async () => {
      channel = new MessageChannel();

      channel.push(createTestMessage('msg1'));

      const iterator = channel.generator()[Symbol.asyncIterator]();

      // Get first message
      const first = await iterator.next();
      expect(first.done).toBe(false);

      // Close multiple times
      channel.close();
      channel.close();

      // Push after close should be ignored
      channel.push(createTestMessage('msg2'));

      // Should end
      const second = await iterator.next();
      expect(second.done).toBe(true);
    });
  });
});
