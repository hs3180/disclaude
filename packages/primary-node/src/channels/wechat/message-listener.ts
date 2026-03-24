/**
 * WeChat Message Listener — long-poll based message receiver.
 *
 * Implements Phase 3.1 of Issue #1556:
 * - POST /ilink/bot/getupdates long-poll loop (35s timeout)
 * - Parse WeChat messages into IncomingMessage format
 * - Message deduplication via LRU-like Set
 * - Graceful shutdown via AbortController
 * - Automatic retry on transient errors
 *
 * Based on the same long-poll pattern used in WeChatAuth (auth.ts).
 *
 * @module channels/wechat/message-listener
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

import { createLogger, type IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type {
  WeChatMessageListenerOptions,
  WeChatRawMessage,
  WeChatMessageItem,
} from './types.js';

const logger = createLogger('WeChatMessageListener');

/** Default delay between retry attempts on error (milliseconds). */
const DEFAULT_RETRY_DELAY_MS = 1_000;

/** Maximum number of message IDs to track for deduplication. */
const DEFAULT_MAX_DEDUP_CACHE_SIZE = 10_000;

/**
 * WeChat Message Listener.
 *
 * Runs a continuous long-poll loop against the WeChat iLink getUpdates API.
 * Each received message is parsed, deduplicated, and forwarded to the
 * registered `onMessage` callback as an `IncomingMessage`.
 *
 * Usage:
 * ```typescript
 * const listener = new WeChatMessageListener(apiClient, {
 *   onMessage: async (msg) => { await handleMessage(msg); },
 *   onError: (err) => { logger.error(err); },
 * });
 * await listener.start();
 * // ... later:
 * listener.stop();
 * ```
 */
export class WeChatMessageListener {
  private readonly client: WeChatApiClient;
  private readonly onMessage: (message: IncomingMessage) => Promise<void>;
  private readonly onError?: (error: Error) => void;
  private readonly retryDelayMs: number;
  private readonly maxDedupCacheSize: number;

  private abortController?: AbortController;
  private running = false;
  private cursor?: string;

  /** Deduplication set — bounded to prevent unbounded memory growth. */
  private readonly seenMessageIds = new Set<string>();

  /**
   * Create a new WeChatMessageListener.
   *
   * @param client - Authenticated WeChatApiClient instance
   * @param options - Listener configuration
   */
  constructor(client: WeChatApiClient, options: WeChatMessageListenerOptions) {
    this.client = client;
    this.onMessage = options.onMessage;
    this.onError = options.onError;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.maxDedupCacheSize = options.maxDedupCacheSize ?? DEFAULT_MAX_DEDUP_CACHE_SIZE;
  }

  /**
   * Start the message listener loop.
   *
   * Begins a long-running loop that polls getUpdates until `stop()` is called.
   * Each poll result is processed: messages are parsed, deduplicated, and
   * forwarded to the `onMessage` callback.
   *
   * This method returns immediately — the loop runs in the background.
   * Errors during individual polls are caught and retried (via `onError`).
   * Only a call to `stop()` will end the loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('Message listener is already running');
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    this.cursor = undefined;
    this.seenMessageIds.clear();

    logger.info('Message listener started');

    // Run the poll loop in the background — do NOT await here so that
    // callers can proceed (e.g. to set up other channels in parallel).
    this.pollLoop().catch((error) => {
      // This catch handles truly unexpected errors (e.g. programming bugs).
      // Normal poll errors are handled inside the loop.
      logger.error({ err: error }, 'Message listener crashed unexpectedly');
      this.running = false;
    });
  }

  /**
   * Stop the message listener.
   *
   * Aborts the current long-poll request and terminates the loop.
   */
  stop(): void {
    if (!this.running) {
      return;
    }

    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }

    logger.info('Message listener stopped');
  }

  /**
   * Check if the listener is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Main long-poll loop.
   *
   * Continuously polls getUpdates, processes messages, and handles errors.
   * Runs until `stop()` is called or the abort signal fires.
   */
  private async pollLoop(): Promise<void> {
    while (this.running) {
      const signal = this.abortController?.signal;

      try {
        const response = await this.client.getUpdates({
          cursor: this.cursor,
          signal,
        });

        // If stop() was called during the poll, exit immediately
        if (!this.running) {
          break;
        }

        // Update cursor for next poll
        if (response.cursor) {
          this.cursor = response.cursor;
        }

        // Process messages
        const messages = response.msg_list ?? [];
        for (const rawMsg of messages) {
          await this.processMessage(rawMsg);
        }
      } catch (error) {
        // If stop() was called, exit silently
        if (!this.running) {
          break;
        }

        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn(
          { err: err.message },
          'Error polling for updates, retrying...'
        );
        this.onError?.(err);

        // Wait before retrying
        await this.delay(this.retryDelayMs, signal);
      }
    }
  }

  /**
   * Process a single raw message from getUpdates.
   *
   * Parses the WeChat message format into IncomingMessage, deduplicates,
   * and forwards to the onMessage callback.
   */
  private async processMessage(rawMsg: WeChatRawMessage): Promise<void> {
    // Deduplication
    const msgId = rawMsg.msg_id;
    if (!msgId) {
      logger.warn('Received message without msg_id, skipping');
      return;
    }

    if (this.seenMessageIds.has(msgId)) {
      logger.debug({ msgId }, 'Duplicate message, skipping');
      return;
    }

    // Add to dedup cache
    this.seenMessageIds.add(msgId);
    this.evictDedupCache();

    // Parse the message
    const incoming = this.parseMessage(rawMsg);
    if (!incoming) {
      logger.warn({ msgId }, 'Failed to parse message, skipping');
      return;
    }

    logger.debug(
      { msgId, chatId: incoming.chatId, type: incoming.messageType },
      'Forwarding message'
    );

    // Forward to handler (errors are caught at the pollLoop level)
    await this.onMessage(incoming);
  }

  /**
   * Parse a raw WeChat message into an IncomingMessage.
   *
   * Maps WeChat iLink fields to the platform-agnostic IncomingMessage format.
   */
  private parseMessage(rawMsg: WeChatRawMessage): IncomingMessage | null {
    const items = rawMsg.item_list ?? [];
    if (items.length === 0) {
      return null;
    }

    // Determine message type and content from the first item
    const primaryItem = items[0];
    const { messageType, content } = this.parseItem(primaryItem);

    if (!content) {
      return null;
    }

    // Use from_user_id as chatId (WeChat iLink is 1:1 bot chat)
    const chatId = rawMsg.from_user_id || rawMsg.to_user_id || '';
    if (!chatId) {
      return null;
    }

    const message: IncomingMessage = {
      messageId: rawMsg.msg_id || crypto.randomUUID(),
      chatId,
      userId: rawMsg.from_user_id,
      content,
      messageType,
      timestamp: rawMsg.create_time ? rawMsg.create_time * 1000 : Date.now(),
    };

    // Map context_token to threadId
    if (rawMsg.context_token) {
      message.threadId = rawMsg.context_token;
    }

    return message;
  }

  /**
   * Parse a WeChat message item into a type and content string.
   */
  private parseItem(
    item: WeChatMessageItem
  ): { messageType: IncomingMessage['messageType']; content: string } {
    switch (item.type) {
      case 1: // text
        return {
          messageType: 'text',
          content: item.text_item?.text ?? '',
        };

      case 2: // image
        return {
          messageType: 'image',
          content: item.image_item?.image_key ?? '[image]',
        };

      case 3: // file
        return {
          messageType: 'file',
          content: item.file_item?.file_name ?? '[file]',
        };

      default:
        return {
          messageType: 'text',
          content: '[unsupported message type]',
        };
    }
  }

  /**
   * Evict oldest entries from the dedup cache when it exceeds the max size.
   *
   * Uses a simple strategy: clear half the cache when full.
   * This avoids O(n) per-insert cost of a true LRU while still bounding memory.
   */
  private evictDedupCache(): void {
    if (this.seenMessageIds.size <= this.maxDedupCacheSize) {
      return;
    }

    const evictCount = Math.floor(this.maxDedupCacheSize / 2);
    logger.debug({ evictCount, totalSize: this.seenMessageIds.size }, 'Evicting dedup cache');

    // Convert to array, remove oldest entries, rebuild set
    const entries = Array.from(this.seenMessageIds);
    this.seenMessageIds.clear();
    for (const entry of entries.slice(evictCount)) {
      this.seenMessageIds.add(entry);
    }
  }

  /**
   * Delay helper that respects the abort signal.
   */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }
}
