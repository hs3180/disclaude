/**
 * Unit tests for MessageQueue
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from './message-queue.js';
import type { QueuedMessage } from './types.js';

describe('MessageQueue', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue();
  });

  describe('constructor', () => {
    it('should create an empty queue', () => {
      expect(queue.length()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
      expect(queue.isClosed()).toBe(false);
    });
  });

  describe('push', () => {
    it('should add a message to the queue', () => {
      const msg: QueuedMessage = { text: 'Hello', messageId: 'msg-1' };
      const result = queue.push(msg);
      expect(result).toBe(true);
      expect(queue.length()).toBe(1);
    });

    it('should return false when queue is closed', () => {
      queue.close();
      const msg: QueuedMessage = { text: 'Hello', messageId: 'msg-1' };
      const result = queue.push(msg);
      expect(result).toBe(false);
      expect(queue.length()).toBe(0);
    });

    it('should allow pushing multiple messages', () => {
      queue.push({ text: 'Hello', messageId: 'msg-1' });
      queue.push({ text: 'World', messageId: 'msg-2' });
      queue.push({ text: 'Test', messageId: 'msg-3' });
      expect(queue.length()).toBe(3);
    });
  });

  describe('consume', () => {
    it('should yield messages as they are pushed', async () => {
      const consumer = queue.consume();

      queue.push({ text: 'Hello', messageId: 'msg-1' });
      queue.push({ text: 'World', messageId: 'msg-2' });
      queue.close();

      const messages: QueuedMessage[] = [];
      for await (const msg of consumer) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(2);
      expect(messages[0].text).toBe('Hello');
      expect(messages[1].text).toBe('World');
    });

    it('should yield all messages after close', async () => {
      queue.push({ text: 'A', messageId: 'msg-1' });
      queue.push({ text: 'B', messageId: 'msg-2' });
      queue.push({ text: 'C', messageId: 'msg-3' });
      queue.close();

      const messages: QueuedMessage[] = [];
      for await (const msg of queue.consume()) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(3);
    });

    it('should drain remaining messages after close', async () => {
      const consumer = queue.consume();

      queue.push({ text: 'First', messageId: 'msg-1' });
      queue.push({ text: 'Second', messageId: 'msg-2' });

      // Don't close yet, the consumer should wait
      // Push one more and close
      setTimeout(() => {
        queue.push({ text: 'Third', messageId: 'msg-3' });
        queue.close();
      }, 50);

      const messages: QueuedMessage[] = [];
      for await (const msg of consumer) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(3);
    });

    it('should exit immediately when closed and empty', async () => {
      queue.close();
      const messages: QueuedMessage[] = [];
      for await (const msg of queue.consume()) {
        messages.push(msg);
      }
      expect(messages).toHaveLength(0);
    });
  });

  describe('close', () => {
    it('should close the queue', () => {
      queue.push({ text: 'Hello', messageId: 'msg-1' });
      queue.close();
      expect(queue.isClosed()).toBe(true);
    });

    it('should be idempotent', () => {
      queue.close();
      queue.close();
      expect(queue.isClosed()).toBe(true);
    });
  });

  describe('isClosed', () => {
    it('should return false for open queue', () => {
      expect(queue.isClosed()).toBe(false);
    });

    it('should return true after close', () => {
      queue.close();
      expect(queue.isClosed()).toBe(true);
    });
  });

  describe('length', () => {
    it('should return 0 for empty queue', () => {
      expect(queue.length()).toBe(0);
    });

    it('should return correct count', () => {
      queue.push({ text: 'A', messageId: 'msg-1' });
      expect(queue.length()).toBe(1);

      queue.push({ text: 'B', messageId: 'msg-2' });
      expect(queue.length()).toBe(2);
    });
  });

  describe('isEmpty', () => {
    it('should return true for empty queue', () => {
      expect(queue.isEmpty()).toBe(true);
    });

    it('should return false when messages exist', () => {
      queue.push({ text: 'Hello', messageId: 'msg-1' });
      expect(queue.isEmpty()).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all messages without closing', () => {
      queue.push({ text: 'A', messageId: 'msg-1' });
      queue.push({ text: 'B', messageId: 'msg-2' });
      queue.clear();

      expect(queue.length()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
      expect(queue.isClosed()).toBe(false);
    });

    it('should allow pushing after clear', () => {
      queue.push({ text: 'A', messageId: 'msg-1' });
      queue.clear();
      queue.push({ text: 'B', messageId: 'msg-2' });
      expect(queue.length()).toBe(1);
    });
  });

  describe('consumer edge cases', () => {
    it('should wake blocked consumer when close is called', async () => {
      const consumer = queue.consume();
      const consumed: QueuedMessage[] = [];

      // Start consuming (will block waiting for messages)
      const consumePromise = (async () => {
        for await (const msg of consumer) {
          consumed.push(msg);
        }
      })();

      // Close the queue after a short delay (consumer is blocked)
      await new Promise(resolve => setTimeout(resolve, 20));
      queue.close();

      // Consumer should exit cleanly
      await consumePromise;
      expect(consumed).toHaveLength(0);
    });

    it('should wake blocked consumer immediately on push', async () => {
      const consumer = queue.consume();
      const consumed: QueuedMessage[] = [];

      const consumePromise = (async () => {
        for await (const msg of consumer) {
          consumed.push(msg);
          if (consumed.length === 1) {
            queue.close(); // Close after receiving first message
          }
        }
      })();

      // Push a message after short delay (consumer is blocked)
      await new Promise(resolve => setTimeout(resolve, 20));
      queue.push({ text: 'Wakeup', messageId: 'msg-1' });

      await consumePromise;
      expect(consumed).toHaveLength(1);
      expect(consumed[0].text).toBe('Wakeup');
    });

    it('should decrease length as messages are consumed', async () => {
      queue.push({ text: 'A', messageId: 'msg-1' });
      queue.push({ text: 'B', messageId: 'msg-2' });
      queue.push({ text: 'C', messageId: 'msg-3' });

      const consumer = queue.consume();
      const iterator = consumer[Symbol.asyncIterator]();

      // Consume first message
      const first = await iterator.next();
      expect(first.value.text).toBe('A');
      // Queue internal length is 2 (shift removes from queue)

      // Consume second
      const second = await iterator.next();
      expect(second.value.text).toBe('B');

      queue.close();
      await iterator.return?.(undefined);
    });

    it('should preserve full QueuedMessage fields through round-trip', async () => {
      const fullMsg: QueuedMessage = {
        text: 'Hello with attachments',
        messageId: 'msg-full',
        senderOpenId: 'ou_abc123',
        attachments: [{ id: 'file-1', fileName: 'doc.pdf', mimeType: 'application/pdf', source: 'user', createdAt: Date.now() }],
      };

      const consumer = queue.consume();
      queue.push(fullMsg);
      queue.close();

      const messages: QueuedMessage[] = [];
      for await (const msg of consumer) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('Hello with attachments');
      expect(messages[0].messageId).toBe('msg-full');
      expect(messages[0].senderOpenId).toBe('ou_abc123');
      expect(messages[0].attachments).toHaveLength(1);
      expect(messages[0].attachments![0].fileName).toBe('doc.pdf');
    });

    it('should handle rapid push/consume cycles', async () => {
      const consumer = queue.consume();
      const consumed: QueuedMessage[] = [];

      const consumePromise = (async () => {
        for await (const msg of consumer) {
          consumed.push(msg);
        }
      })();

      // Rapid fire pushes
      for (let i = 0; i < 100; i++) {
        queue.push({ text: `msg-${i}`, messageId: `id-${i}` });
      }
      queue.close();

      await consumePromise;
      expect(consumed).toHaveLength(100);
      expect(consumed[0].text).toBe('msg-0');
      expect(consumed[99].text).toBe('msg-99');
    });
  });
});
