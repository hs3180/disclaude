/**
 * Additional tests for MessageQueue close-while-consuming path
 *
 * Covers uncovered branch (lines 92-95):
 * - close() called while consumer is awaiting a message (resolver is set)
 * - Verifies the resolver is called and cleared on close
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect } from 'vitest';
import { MessageQueue } from './message-queue.js';
import type { QueuedMessage } from './types.js';

describe('MessageQueue — close while consuming', () => {
  it('should resolve pending consumer when close is called', async () => {
    const queue = new MessageQueue();
    const consumer = queue.consume();

    // Start consuming in background (consumer will wait since queue is empty)
    const messages: QueuedMessage[] = [];
    const consumerPromise = (async () => {
      for await (const msg of consumer) {
        messages.push(msg);
      }
    })();

    // Give consumer time to enter the waiting state
    await new Promise(resolve => setTimeout(resolve, 20));

    // Close should resolve the waiting consumer
    queue.close();

    await consumerPromise;
    expect(messages).toHaveLength(0);
  });

  it('should deliver queued messages then close', async () => {
    const queue = new MessageQueue();
    const consumer = queue.consume();

    queue.push({ text: 'before-close', messageId: 'msg-1' });

    // Start consuming
    const messages: QueuedMessage[] = [];
    const consumerPromise = (async () => {
      for await (const msg of consumer) {
        messages.push(msg);
      }
    })();

    // Give time for the first message to be consumed
    await new Promise(resolve => setTimeout(resolve, 20));

    // Push a message while consumer is waiting for more
    queue.push({ text: 'after-wait', messageId: 'msg-2' });
    queue.close();

    await consumerPromise;
    expect(messages).toHaveLength(2);
    expect(messages[0].text).toBe('before-close');
    expect(messages[1].text).toBe('after-wait');
  });

  it('should handle rapid push-close sequence', async () => {
    const queue = new MessageQueue();
    const consumer = queue.consume();

    queue.push({ text: 'msg-1', messageId: 'm1' });
    queue.push({ text: 'msg-2', messageId: 'm2' });
    queue.push({ text: 'msg-3', messageId: 'm3' });
    queue.close();

    const messages: QueuedMessage[] = [];
    for await (const msg of consumer) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(3);
  });
});
