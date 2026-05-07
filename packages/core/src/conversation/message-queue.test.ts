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

  describe('close with waiting consumer', () => {
    it('should resolve pending consumer when closed', async () => {
      const consumer = queue.consume();
      const messages: QueuedMessage[] = [];

      // Start consuming in background
      const consumePromise = (async () => {
        for await (const msg of consumer) {
          messages.push(msg);
        }
      })();

      // Give consumer time to start waiting
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Close without pushing any messages
      queue.close();

      await consumePromise;
      expect(messages).toHaveLength(0);
    });

    it('should handle concurrent push and close correctly', async () => {
      const consumer = queue.consume();
      const messages: QueuedMessage[] = [];

      const consumePromise = (async () => {
        for await (const msg of consumer) {
          messages.push(msg);
        }
      })();

      // Give consumer time to start waiting
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Push a message, then immediately close
      queue.push({ text: 'Last', messageId: 'msg-1' });
      queue.close();

      await consumePromise;
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe('Last');
    });
  });
});
