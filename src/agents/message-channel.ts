/**
 * MessageChannel - Producer-consumer pattern for SDK message streaming.
 *
 * Provides an AsyncGenerator that yields StreamingUserMessages as they are pushed.
 * This enables the Pilot agent to forward user messages to the SDK's streaming
 * input without using streamInput() directly.
 *
 * Usage:
 * ```typescript
 * const channel = new MessageChannel();
 *
 * // Producer: push messages
 * channel.push(userMessage);
 *
 * // Consumer: async generator yields messages as they arrive
 * for await (const msg of channel.generator()) {
 *   // process msg
 * }
 *
 * // Cleanup
 * channel.close();
 * ```
 */

import { createLogger } from '../utils/logger.js';
import type { StreamingUserMessage } from '../sdk/index.js';

const logger = createLogger('MessageChannel');

export class MessageChannel {
  private queue: StreamingUserMessage[] = [];
  private resolver: (() => void) | null = null;
  private closed = false;

  /**
   * Push a message to the channel.
   * Resolves the pending promise in the generator if waiting.
   *
   * @param message - The user message to push
   */
  push(message: StreamingUserMessage): void {
    if (this.closed) {
      logger.warn('Push to closed channel ignored');
      return;
    }
    this.queue.push(message);
    if (this.resolver) {
      this.resolver();
      this.resolver = null;
    }
  }

  /**
   * Generator that yields messages as they arrive.
   * Returns when the channel is closed and queue is empty.
   *
   * @yields StreamingUserMessage when available
   */
  async *generator(): AsyncGenerator<StreamingUserMessage> {
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
   * Close the channel.
   * The generator will drain remaining messages and exit.
   */
  close(): void {
    this.closed = true;
    if (this.resolver) {
      this.resolver();
      this.resolver = null;
    }
  }

  /**
   * Check if the channel is closed.
   */
  isClosed(): boolean {
    return this.closed;
  }
}
