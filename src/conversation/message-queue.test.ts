import { describe, it, expect, beforeEach } from 'vitest';
import { MessageQueue } from './message-queue.js';
import type { QueuedMessage } from './types.js';

describe('MessageQueue', () => {
  let queue: MessageQueue;

  beforeEach(() => {
    queue = new MessageQueue();
  });

  describe('push', () => {
    it('should push a message to the queue', () => {
      const message: QueuedMessage = { text: 'Hello', messageId: '123' };
      const result = queue.push(message);

      expect(result).toBe(true);
      expect(queue.size()).toBe(1);
    });

    it('should return false when pushing to a closed queue', () => {
      queue.close();
      const message: QueuedMessage = { text: 'Hello', messageId: '123' };
      const result = queue.push(message);

      expect(result).toBe(false);
    });
  });

  describe('consume', () => {
    it('should yield messages as they are pushed', async () => {
      const messages: QueuedMessage[] = [
        { text: 'Hello', messageId: '1' },
        { text: 'World', messageId: '2' },
      ];

      // Push messages
      for (const msg of messages) {
        queue.push(msg);
      }
      queue.close();

      // Consume messages
      const consumed: QueuedMessage[] = [];
      for await (const msg of queue.consume()) {
        consumed.push(msg);
      }

      expect(consumed).toEqual(messages);
    });

    it('should wait for new messages', async () => {
      const message: QueuedMessage = { text: 'Hello', messageId: '1' };

      // Start consuming in background
      const consumePromise = (async () => {
        const consumed: QueuedMessage[] = [];
        for await (const msg of queue.consume()) {
          consumed.push(msg);
        }
        return consumed;
      })();

      // Push message after a short delay
      setTimeout(() => {
        queue.push(message);
        queue.close();
      }, 10);

      const consumed = await consumePromise;
      expect(consumed).toEqual([message]);
    });
  });

  describe('close', () => {
    it('should close the queue', () => {
      expect(queue.isClosed()).toBe(false);
      queue.close();
      expect(queue.isClosed()).toBe(true);
    });

    it('should drain remaining messages after close', async () => {
      const messages: QueuedMessage[] = [
        { text: 'Hello', messageId: '1' },
        { text: 'World', messageId: '2' },
      ];

      for (const msg of messages) {
        queue.push(msg);
      }
      queue.close();

      const consumed: QueuedMessage[] = [];
      for await (const msg of queue.consume()) {
        consumed.push(msg);
      }

      expect(consumed).toEqual(messages);
    });
  });

  describe('size', () => {
    it('should return 0 for empty queue', () => {
      expect(queue.size()).toBe(0);
    });

    it('should return correct count', () => {
      queue.push({ text: '1', messageId: '1' });
      queue.push({ text: '2', messageId: '2' });
      expect(queue.size()).toBe(2);
    });
  });

  describe('isEmpty', () => {
    it('should return true for empty queue', () => {
      expect(queue.isEmpty()).toBe(true);
    });

    it('should return false for non-empty queue', () => {
      queue.push({ text: 'Hello', messageId: '1' });
      expect(queue.isEmpty()).toBe(false);
    });
  });

  describe('clear', () => {
    it('should clear all messages', () => {
      queue.push({ text: '1', messageId: '1' });
      queue.push({ text: '2', messageId: '2' });
      queue.clear();
      expect(queue.size()).toBe(0);
    });

    it('should not close the queue', () => {
      queue.push({ text: '1', messageId: '1' });
      queue.clear();
      expect(queue.isClosed()).toBe(false);
    });
  });
});
