/**
 * WeChat Message Listener (Phase 3 — Issue #1556).
 *
 * Implements long-poll based message listening via the WeChat ilink Bot API
 * `getUpdates` endpoint. Features:
 *
 * - Long-poll loop with configurable timeout (default 35s)
 * - Message deduplication via in-memory Set with FIFO eviction
 * - Exponential backoff on consecutive errors
 * - Graceful shutdown via AbortController
 * - Max consecutive error threshold to prevent infinite retry loops
 *
 * @module channels/wechat/message-listener
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

import { createLogger, type IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatUpdate, WeChatMessageListenerConfig } from './types.js';

const logger = createLogger('WeChatMessageListener');

/** Default maximum deduplication set size. */
const DEFAULT_MAX_DEDUP_SIZE = 10_000;

/** Default maximum consecutive errors before stopping. */
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 10;

/** Default long-poll timeout (milliseconds). */
const DEFAULT_POLL_TIMEOUT_MS = 35_000;

/** Default exponential backoff base delay (milliseconds). */
const DEFAULT_BACKOFF_BASE_MS = 1_000;

/** Default maximum backoff delay (milliseconds). */
const DEFAULT_BACKOFF_MAX_MS = 30_000;

/** WeChat message type mapping: API type number → IncomingMessage type. */
const WECHAT_MESSAGE_TYPE_MAP: Record<number, IncomingMessage['messageType']> = {
  1: 'text',
  2: 'image',
  3: 'file',
};

/**
 * WeChat Message Listener.
 *
 * Long-polls the `getUpdates` API endpoint to receive incoming messages.
 * Converts WeChat API messages into standard `IncomingMessage` format and
 * passes them to the registered handler.
 *
 * Usage:
 * ```typescript
 * const listener = new WeChatMessageListener(apiClient, (message) => {
 *   // handle incoming message
 * });
 * await listener.start();
 * // ... later
 * listener.stop();
 * ```
 */
export class WeChatMessageListener {
  private readonly client: WeChatApiClient;
  private readonly onMessage: (message: IncomingMessage) => Promise<void>;
  private readonly config: Required<WeChatMessageListenerConfig>;

  private abortController?: AbortController;
  private dedupSet = new Set<string>();
  private consecutiveErrors = 0;
  private cursor?: string;
  private running = false;
  private pollPromise?: Promise<void>;

  /**
   * Create a new WeChat message listener.
   *
   * @param client - Authenticated WeChat API client
   * @param onMessage - Callback for each received message
   * @param config - Listener configuration options
   */
  constructor(
    client: WeChatApiClient,
    onMessage: (message: IncomingMessage) => Promise<void>,
    config?: WeChatMessageListenerConfig,
  ) {
    this.client = client;
    this.onMessage = onMessage;
    this.config = {
      maxDedupSize: config?.maxDedupSize ?? DEFAULT_MAX_DEDUP_SIZE,
      maxConsecutiveErrors: config?.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS,
      pollTimeoutMs: config?.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      backoffBaseMs: config?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      backoffMaxMs: config?.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS,
    };
  }

  /**
   * Start the message listener.
   *
   * Begins the long-poll loop. Returns immediately; polling runs in the
   * background. Call `stop()` to terminate.
   */
  start(): void {
    if (this.running) {
      logger.warn('Message listener is already running');
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    this.consecutiveErrors = 0;
    this.cursor = undefined;
    this.dedupSet.clear();

    logger.info('Starting WeChat message listener');
    this.pollPromise = this.pollLoop();
  }

  /**
   * Stop the message listener.
   *
   * Gracefully terminates the poll loop. Waits for the current poll to
   * complete before returning.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info('Stopping WeChat message listener');
    this.running = false;

    if (this.abortController) {
      this.abortController.abort();
    }

    await this.pollPromise;
    this.pollPromise = undefined;
    this.abortController = undefined;

    logger.info('WeChat message listener stopped');
  }

  /**
   * Check if the listener is currently running.
   */
  isListening(): boolean {
    return this.running;
  }

  /**
   * Get the number of deduplicated message IDs currently tracked.
   * Useful for monitoring and testing.
   */
  getDedupSize(): number {
    return this.dedupSet.size;
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  /**
   * Main polling loop.
   *
   * Continuously polls getUpdates until stopped or max consecutive errors
   * is reached. Uses exponential backoff on errors.
   */
  private async pollLoop(): Promise<void> {
    if (!this.abortController) {
      return;
    }
    const { signal } = this.abortController;

    while (this.running && !signal.aborted) {
      try {
        const response = await this.client.getUpdates({
          timeoutMs: this.config.pollTimeoutMs,
          cursor: this.cursor,
        });

        // Reset error counter on successful poll
        this.consecutiveErrors = 0;

        // Process updates
        if (response.update_list && response.update_list.length > 0) {
          for (const update of response.update_list) {
            const message = this.parseUpdate(update);
            if (message && !this.isDuplicate(message.messageId)) {
              this.dedupSet.add(message.messageId);
              await this.onMessage(message);
            }
          }
        }

        // Update cursor for next poll
        if (response.cursor) {
          this.cursor = response.cursor;
        }
      } catch (error) {
        this.consecutiveErrors++;
        const { consecutiveErrors } = this;
        const errMsg = error instanceof Error ? error.message : String(error);

        logger.error(
          { consecutiveErrors, maxErrors: this.config.maxConsecutiveErrors, err: errMsg },
          'getUpdates poll error',
        );

        if (consecutiveErrors >= this.config.maxConsecutiveErrors) {
          logger.error(
            { consecutiveErrors },
            'Max consecutive errors reached, stopping message listener',
          );
          this.running = false;
          break;
        }

        // Exponential backoff before retry
        await this.backoff(consecutiveErrors, signal);
      }
    }
  }

  /**
   * Calculate and wait for exponential backoff delay.
   *
   * Delay = min(backoffBaseMs * 2^(attempt-1), backoffMaxMs)
   * Adds jitter (±20%) to avoid thundering herd.
   */
  private async backoff(attempt: number, signal: AbortSignal): Promise<void> {
    const exponentialDelay = this.config.backoffBaseMs * Math.pow(2, attempt - 1);
    const clampedDelay = Math.min(exponentialDelay, this.config.backoffMaxMs);
    // Add ±20% jitter
    const jitter = clampedDelay * 0.2;
    const delay = clampedDelay + (Math.random() * jitter * 2) - jitter;

    logger.debug({ attempt, delayMs: Math.round(delay) }, 'Backing off before retry');

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  /**
   * Parse a WeChat update into a standard IncomingMessage.
   *
   * Returns null if the update is malformed or has an unsupported message type.
   */
  private parseUpdate(update: WeChatUpdate): IncomingMessage | null {
    if (!update.msg_id || !update.from_user_id) {
      logger.trace({ update }, 'Skipping update with missing msg_id or from_user_id');
      return null;
    }

    const messageType = WECHAT_MESSAGE_TYPE_MAP[update.message_type ?? 0];
    if (!messageType) {
      logger.debug(
        { msgId: update.msg_id, type: update.message_type },
        'Unsupported message type, skipping',
      );
      return null;
    }

    const content = this.extractContent(update);
    const timestamp = update.create_time
      ? update.create_time * 1000 // Convert seconds to milliseconds
      : Date.now();

    const message: IncomingMessage = {
      messageId: update.msg_id,
      chatId: update.from_user_id,
      userId: update.from_user_id,
      content,
      messageType,
      timestamp,
    };

    // Attach thread context if available
    if (update.context_token) {
      message.threadId = update.context_token;
    }

    // Attach metadata for file/image messages
    if (messageType === 'file' || messageType === 'image') {
      const attachment = this.extractAttachment(update);
      if (attachment) {
        message.attachments = [attachment];
      }
    }

    return message;
  }

  /**
   * Extract text content from a WeChat update.
   */
  private extractContent(update: WeChatUpdate): string {
    if (!update.item_list || update.item_list.length === 0) {
      return '';
    }

    const parts: string[] = [];
    for (const item of update.item_list) {
      if (item.type === 1 && item.text_item?.text) {
        parts.push(item.text_item.text);
      } else if (item.type === 3 && item.file_item?.file_name) {
        parts.push(`[File: ${item.file_item.file_name}]`);
      } else if (item.type === 2 && item.image_item?.image_url) {
        parts.push('[Image]');
      }
    }

    return parts.join('\n');
  }

  /**
   * Extract file attachment from a WeChat update (for file/image types).
   */
  private extractAttachment(update: WeChatUpdate):
    | { fileName: string; filePath: string; mimeType?: string; size?: number }
    | undefined {
    if (!update.item_list) {
      return undefined;
    }

    for (const item of update.item_list) {
      if (item.type === 3 && item.file_item) {
        return {
          fileName: item.file_item.file_name ?? 'unknown',
          filePath: item.file_item.file_url ?? '',
          size: item.file_item.file_size,
        };
      }
      if (item.type === 2 && item.image_item?.image_url) {
        return {
          fileName: 'image',
          filePath: item.image_item.image_url,
        };
      }
    }

    return undefined;
  }

  /**
   * Check if a message ID has already been processed.
   *
   * Uses FIFO eviction when the dedup set exceeds maxDedupSize.
   */
  private isDuplicate(messageId: string): boolean {
    if (this.dedupSet.has(messageId)) {
      return true;
    }

    // FIFO eviction: if set is full, clear oldest entries by creating a new set
    // This is more efficient than tracking insertion order separately.
    if (this.dedupSet.size >= this.config.maxDedupSize) {
      const oldSize = this.dedupSet.size;
      this.dedupSet = new Set(Array.from(this.dedupSet).slice(Math.floor(this.config.maxDedupSize * 0.5)));
      logger.debug(
        { oldSize, newSize: this.dedupSet.size },
        'Dedup set evicted (FIFO)',
      );
    }

    return false;
  }
}
