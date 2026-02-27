/**
 * MessageQueue - Producer-consumer pattern for conversation messages.
 *
 * This class provides an async queue for messages, using a resolver pattern
 * to efficiently wait for new messages. It's designed to be agent-agnostic
 * and can be used with any messaging system.
 *
 * Usage:
 * ```typescript
 * const queue = new MessageQueue();
 *
 * // Producer: push messages
 * queue.push({ text: 'Hello', messageId: '123' });
 *
 * // Consumer: async generator yields messages as they arrive
 * for await (const msg of queue.consume()) {
 *   // process msg
 * }
 *
 * // Cleanup
 * queue.close();
 * ```
 */

import type { QueuedMessage } from './types.js';

/**
 * MessageQueue - Async queue for conversation messages.
 *
 * Implements a producer-consumer pattern where:
 * - Producers call push() to add messages
 * - Consumers iterate over consume() to receive messages
 * - The queue buffers messages until they are consumed
 * - close() signals end of stream
 */
export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private resolver: (() => void) | null = null;
  private closed = false;

  /**
   * Push a message to the queue.
   * If a consumer is waiting, it will be notified immediately.
   *
   * @param message - The message to push
   * @returns true if message was queued, false if queue is closed
   */
  push(message: QueuedMessage): boolean {
    if (this.closed) {
      return false;
    }

    this.queue.push(message);

    // Notify waiting consumer if any
    if (this.resolver) {
      this.resolver();
      this.resolver = null;
    }

    return true;
  }

  /**
   * Generator that yields messages as they arrive.
   * Continues until the queue is closed and all messages are drained.
   *
   * @yields QueuedMessage when available
   */
  async *consume(): AsyncGenerator<QueuedMessage> {
    while (!this.closed || this.queue.length > 0) {
      // Yield all queued messages first
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }

      // Exit if closed after draining
      if (this.closed) {
        break;
      }

      // Wait for new message or close
      await new Promise<void>((resolve) => {
        this.resolver = resolve;
      });
    }
  }

  /**
   * Close the queue.
   * The consumer will drain remaining messages and exit.
   */
  close(): void {
    this.closed = true;

    // Notify waiting consumer if any
    if (this.resolver) {
      this.resolver();
      this.resolver = null;
    }
  }

  /**
   * Check if the queue is closed.
   */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * Get the current number of queued messages.
   */
  size(): number {
    return this.queue.length;
  }

  /**
   * Check if the queue is empty.
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Clear all queued messages.
   * Does not close the queue.
   */
  clear(): void {
    this.queue = [];
  }
}
