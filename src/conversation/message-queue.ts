/**
 * MessageQueue - Queue + Resolver pattern for message streaming.
 *
 * This is an enhanced version of the MessageChannel pattern that:
 * - Uses the QueuedMessage type from types.ts
 * - Provides additional queue statistics
 * - Supports the conversation layer architecture
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
 * MessageQueue - Producer-consumer pattern for conversation messages.
 *
 * Provides an AsyncGenerator that yields QueuedMessages as they are pushed.
 * This enables decoupled message production from consumption.
 */
export class MessageQueue {
  private queue: QueuedMessage[] = [];
  private resolver: (() => void) | null = null;
  private closed = false;

  /**
   * Push a message to the queue.
   * Resolves the pending promise in the consumer if waiting.
   *
   * @param message - The message to queue
   * @returns true if message was queued, false if queue is closed
   */
  push(message: QueuedMessage): boolean {
    if (this.closed) {
      return false;
    }
    this.queue.push(message);
    if (this.resolver) {
      this.resolver();
      this.resolver = null;
    }
    return true;
  }

  /**
   * Generator that yields messages as they arrive.
   * Returns when the queue is closed and drained.
   *
   * @yields QueuedMessage when available
   */
  async *consume(): AsyncGenerator<QueuedMessage> {
    while (!this.closed || this.queue.length > 0) {
      // Yield all queued messages
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }

      // Exit if closed after draining queue
      if (this.closed) {
        break;
      }

      // Wait for new message
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
   * Get the current queue length.
   */
  length(): number {
    return this.queue.length;
  }

  /**
   * Check if the queue is empty.
   */
  isEmpty(): boolean {
    return this.queue.length === 0;
  }

  /**
   * Clear all pending messages.
   * Does not close the queue.
   */
  clear(): void {
    this.queue = [];
  }
}
