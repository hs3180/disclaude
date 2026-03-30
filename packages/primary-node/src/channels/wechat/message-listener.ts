/**
 * WeChat Message Listener (Phase 3.1).
 *
 * Long-polls the WeChat getUpdates API for incoming messages,
 * deduplicates them, and forwards them via a callback.
 *
 * Features:
 * - Long-poll loop with configurable timeout (35s default)
 * - In-memory message deduplication with FIFO eviction (max 10,000)
 * - Exponential backoff on consecutive errors (max 5 consecutive)
 * - Graceful shutdown via AbortController
 *
 * @module channels/wechat/message-listener
 * @see Issue #1557 - WeChat Channel Dynamic Registration Roadmap
 */

import { createLogger, type IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatUpdate } from './types.js';

const logger = createLogger('WeChatMessageListener');

/** Default long-poll timeout in milliseconds. */
const DEFAULT_POLL_TIMEOUT_MS = 35_000;

/** Maximum number of message IDs to track for deduplication. */
const MAX_DEDUP_SIZE = 10_000;

/** Maximum consecutive errors before giving up. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Base delay for exponential backoff (milliseconds). */
const BACKOFF_BASE_MS = 1_000;

/** Maximum backoff delay (milliseconds). */
const BACKOFF_MAX_MS = 30_000;

/**
 * Callback for handling parsed incoming messages.
 */
export type MessageCallback = (message: IncomingMessage) => Promise<void>;

/**
 * WeChat Message Listener.
 *
 * Continuously polls the getUpdates API and forwards
 * new (non-duplicate) messages to a registered callback.
 */
export class WeChatMessageListener {
  private readonly client: WeChatApiClient;
  private readonly onMessage: MessageCallback;
  private readonly pollTimeout: number;

  /** In-memory set for deduplication. */
  private readonly seenIds = new Set<string>();

  /** AbortController for graceful shutdown. */
  private abortController?: AbortController;

  /** Whether the listener is currently running. */
  private running = false;

  /** Number of consecutive polling errors. */
  private consecutiveErrors = 0;

  /**
   * Create a new WeChat message listener.
   *
   * @param options - Listener configuration
   */
  constructor(options: {
    /** WeChat API client with valid token */
    client: WeChatApiClient;
    /** Callback for each parsed incoming message */
    onMessage: MessageCallback;
    /** Long-poll timeout in milliseconds (default: 35000) */
    pollTimeout?: number;
  }) {
    this.client = options.client;
    this.onMessage = options.onMessage;
    this.pollTimeout = options.pollTimeout ?? DEFAULT_POLL_TIMEOUT_MS;
  }

  /**
   * Start the long-poll loop.
   *
   * Runs in the background until stop() is called.
   * Automatically retries on transient errors with exponential backoff.
   */
  start(): void {
    if (this.running) {
      logger.warn('Message listener is already running');
      return;
    }

    this.running = true;
    this.consecutiveErrors = 0;
    this.abortController = new AbortController();

    logger.info('Message listener started');

    // Run the poll loop in the background
    void this.pollLoop();
  }

  /**
   * Stop the message listener gracefully.
   *
   * Aborts the current long-poll and stops the loop.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.abortController?.abort();
    this.abortController = undefined;

    logger.info('Message listener stopped');
  }

  /**
   * Check if the listener is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Main polling loop with exponential backoff.
   */
  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.client.getUpdates({
          timeout: this.pollTimeout,
        });

        // Reset error counter on successful poll
        this.consecutiveErrors = 0;

        // Process each update
        for (const update of updates) {
          if (!this.running) {
            break;
          }

          // Deduplicate by message ID
          if (this.isDuplicate(update.msg_id)) {
            logger.debug({ msgId: update.msg_id }, 'Duplicate message ignored');
            continue;
          }

          // Convert WeChat update to IncomingMessage
          const message = this.toIncomingMessage(update);

          // Forward to callback (fire-and-forget error handling)
          try {
            await this.onMessage(message);
          } catch (error) {
            logger.error(
              { err: error, msgId: update.msg_id },
              'Message handler callback threw error'
            );
          }
        }
      } catch (error) {
        this.consecutiveErrors++;

        if (!this.running) {
          break;
        }

        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logger.error(
            { consecutiveErrors: this.consecutiveErrors },
            'Max consecutive errors reached, stopping message listener'
          );
          break;
        }

        const delay = this.calculateBackoff();
        logger.warn(
          { err: error, consecutiveErrors: this.consecutiveErrors, delay },
          'getUpdates polling error, backing off'
        );

        await this.sleep(delay);
      }
    }

    this.running = false;
  }

  /**
   * Check if a message ID has been seen before.
   * Uses FIFO eviction when the set exceeds MAX_DEDUP_SIZE.
   */
  private isDuplicate(msgId: string): boolean {
    if (this.seenIds.has(msgId)) {
      return true;
    }

    this.seenIds.add(msgId);

    // FIFO eviction: remove oldest entries when set is too large
    if (this.seenIds.size > MAX_DEDUP_SIZE) {
      // Convert to array, remove first half (simple FIFO)
      const entries = Array.from(this.seenIds);
      const toRemove = entries.slice(0, Math.floor(MAX_DEDUP_SIZE / 2));
      for (const id of toRemove) {
        this.seenIds.delete(id);
      }
      logger.debug(
        { removedCount: toRemove.length, remainingSize: this.seenIds.size },
        'Dedup set evicted old entries'
      );
    }

    return false;
  }

  /**
   * Convert a WeChat update to the framework's IncomingMessage format.
   */
  private toIncomingMessage(update: WeChatUpdate): IncomingMessage {
    // Extract text content from item_list
    const textParts: string[] = [];
    if (update.item_list) {
      for (const item of update.item_list) {
        if (item.type === 1 && item.text_item?.text) {
          textParts.push(item.text_item.text);
        }
      }
    }
    const content = textParts.join('') || '';

    // Determine message type based on WeChat message_type
    let messageType: IncomingMessage['messageType'] = 'text';
    if (update.message_type === 3) {
      messageType = 'image';
    } else if (update.message_type === 6) {
      messageType = 'file';
    }

    const message: IncomingMessage = {
      messageId: update.msg_id,
      chatId: update.from_user_id,
      userId: update.from_user_id,
      content,
      messageType,
      timestamp: update.create_time,
    };

    // Add threadId if context_token is present
    if (update.context_token) {
      message.threadId = update.context_token;
    }

    return message;
  }

  /**
   * Calculate exponential backoff delay.
   */
  private calculateBackoff(): number {
    const delay = BACKOFF_BASE_MS * Math.pow(2, this.consecutiveErrors - 1);
    // Add jitter (±20%)
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    return Math.min(delay + jitter, BACKOFF_MAX_MS);
  }

  /**
   * Sleep for the specified duration, abortable via AbortController.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);

      // If aborted during backoff, resolve immediately
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };

      this.abortController?.signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
