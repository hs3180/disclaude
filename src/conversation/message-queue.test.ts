/**
 * Tests for MessageQueue (src/conversation/message-queue.ts)
 */

import { describe, it, expect } from 'vitest';
import { MessageQueue } from './message-queue.js';
import type { QueuedMessage } from './types.js';

describe('MessageQueue', () => {
  describe('push', () => {
    it('should add message to queue and return true', () => {
      const queue = new MessageQueue();
      const msg: QueuedMessage = { text: 'Hello', messageId: '123' };

      const result = queue.push(msg);

      expect(result).toBe(true);
      expect(queue.length()).toBe(1);
    });

    it('should return false when pushing to closed queue', () => {
      const queue = new MessageQueue();
      queue.close();

      const result = queue.push({ text: 'test', messageId: '1' });

      expect(result).toBe(false);
      expect(queue.length()).toBe(0);
    });

    it('should resolve pending consumer when message is pushed', async () => {
      const queue = new MessageQueue();
      const msg: QueuedMessage = { text: 'Hello', messageId: '123' };

      // Start consumer (will wait for message)
      const consumerPromise = queue.consume().next();

      // Push message (should resolve the pending consumer)
      queue.push(msg);

      const result = await consumerPromise;
      expect(result.value).toEqual(msg);
      expect(result.done).toBe(false);

      queue.close();
    });
  });

  describe('consume', () => {
    it('should yield messages in order', async () => {
      const queue = new MessageQueue();
      const messages: QueuedMessage[] = [
        { text: 'First', messageId: '1' },
        { text: 'Second', messageId: '2' },
        { text: 'Third', messageId: '3' },
      ];

      messages.forEach(msg => queue.push(msg));
      queue.close();

      const consumed: QueuedMessage[] = [];
      for await (const msg of queue.consume()) {
        consumed.push(msg);
      }

      expect(consumed).toEqual(messages);
    });

    it('should wait for new messages when queue is empty', async () => {
      const queue = new MessageQueue();
      const msg: QueuedMessage = { text: 'Delayed', messageId: '1' };

      // Start consumer before pushing
      const consumePromise = (async (): Promise<QueuedMessage | undefined> => {
        for await (const m of queue.consume()) {
          queue.close();
          return m;
        }
        return undefined; // TypeScript requires explicit return
      })();

      // Push after a small delay
      setTimeout(() => queue.push(msg), 10);

      const result = await consumePromise;
      expect(result).toEqual(msg);
    });

    it('should exit when closed and drained', async () => {
      const queue = new MessageQueue();
      const msg: QueuedMessage = { text: 'test', messageId: '1' };

      queue.push(msg);
      queue.close();

      const consumed: QueuedMessage[] = [];
      for await (const m of queue.consume()) {
        consumed.push(m);
      }

      expect(consumed).toHaveLength(1);
      expect(consumed[0]).toEqual(msg);
    });

    it('should drain remaining messages after close', async () => {
      const queue = new MessageQueue();

      queue.push({ text: 'A', messageId: '1' });
      queue.push({ text: 'B', messageId: '2' });
      queue.close();

      const consumed: QueuedMessage[] = [];
      for await (const msg of queue.consume()) {
        consumed.push(msg);
      }

      expect(consumed).toHaveLength(2);
    });
  });

  describe('close', () => {
    it('should mark queue as closed', () => {
      const queue = new MessageQueue();

      expect(queue.isClosed()).toBe(false);
      queue.close();
      expect(queue.isClosed()).toBe(true);
    });

    it('should resolve pending consumer without message', async () => {
      const queue = new MessageQueue();

      // Start consumer (will wait)
      const consumerPromise = queue.consume().next();

      // Close queue (should resolve pending consumer)
      queue.close();

      const result = await consumerPromise;
      expect(result.done).toBe(true);
      expect(result.value).toBeUndefined();
    });
  });

  describe('isClosed', () => {
    it('should return false initially', () => {
      const queue = new MessageQueue();
      expect(queue.isClosed()).toBe(false);
    });

    it('should return true after close', () => {
      const queue = new MessageQueue();
      queue.close();
      expect(queue.isClosed()).toBe(true);
    });
  });

  describe('length', () => {
    it('should return 0 for empty queue', () => {
      const queue = new MessageQueue();
      expect(queue.length()).toBe(0);
    });

    it('should return correct count after pushes', () => {
      const queue = new MessageQueue();

      queue.push({ text: 'A', messageId: '1' });
      expect(queue.length()).toBe(1);

      queue.push({ text: 'B', messageId: '2' });
      expect(queue.length()).toBe(2);
    });

    it('should decrease after consume', async () => {
      const queue = new MessageQueue();
      queue.push({ text: 'test', messageId: '1' });
      queue.close();

      const iterator = queue.consume();
      await iterator.next();

      expect(queue.length()).toBe(0);
    });
  });

  describe('isEmpty', () => {
    it('should return true for empty queue', () => {
      const queue = new MessageQueue();
      expect(queue.isEmpty()).toBe(true);
    });

    it('should return false when queue has messages', () => {
      const queue = new MessageQueue();
      queue.push({ text: 'test', messageId: '1' });
      expect(queue.isEmpty()).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all messages', () => {
      const queue = new MessageQueue();
      queue.push({ text: 'A', messageId: '1' });
      queue.push({ text: 'B', messageId: '2' });

      queue.clear();

      expect(queue.length()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
    });

    it('should not close the queue', () => {
      const queue = new MessageQueue();
      queue.push({ text: 'test', messageId: '1' });

      queue.clear();

      expect(queue.isClosed()).toBe(false);
      expect(queue.push({ text: 'new', messageId: '2' })).toBe(true);
    });
  });

  describe('concurrent operations', () => {
    it('should handle multiple pushes before consume', async () => {
      const queue = new MessageQueue();

      queue.push({ text: 'A', messageId: '1' });
      queue.push({ text: 'B', messageId: '2' });
      queue.push({ text: 'C', messageId: '3' });
      queue.close();

      const results: QueuedMessage[] = [];
      for await (const msg of queue.consume()) {
        results.push(msg);
      }

      expect(results).toHaveLength(3);
      expect(results.map(m => m.messageId)).toEqual(['1', '2', '3']);
    });

    it('should handle interleaved push and consume', async () => {
      const queue = new MessageQueue();
      const consumed: QueuedMessage[] = [];

      const consumerPromise = (async () => {
        let count = 0;
        for await (const msg of queue.consume()) {
          consumed.push(msg);
          count++;
          if (count >= 3) {
            break;
          }
        }
      })();

      queue.push({ text: 'A', messageId: '1' });
      queue.push({ text: 'B', messageId: '2' });
      queue.push({ text: 'C', messageId: '3' });

      await consumerPromise;
      queue.close();

      expect(consumed).toHaveLength(3);
    });
  });
});
