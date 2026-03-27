/**
 * WeChat Message Listener.
 *
 * Long-poll based message listener for the WeChat (Tencent ilink) Bot API.
 * Continuously polls getUpdates and dispatches incoming messages to a
 * registered processor callback.
 *
 * Features:
 * - Continuous long-poll loop with automatic retry
 * - Message deduplication via msg_id Set with FIFO eviction
 * - Exponential backoff on errors (capped at 60s)
 * - Graceful shutdown via AbortController
 *
 * @module channels/wechat/message-listener
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1)
 */

import { createLogger, type IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type {
  WeChatUpdate,
  WeChatTextItem,
  WeChatImageItem,
  WeChatFileItem,
} from './types.js';

const logger = createLogger('WeChatMessageListener');

/** Maximum number of consecutive errors before extended backoff. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Base delay for exponential backoff (ms). */
const BACKOFF_BASE_MS = 1_000;

/** Maximum backoff delay (ms). */
const MAX_BACKOFF_MS = 60_000;

/** Maximum dedup cache size before FIFO eviction. */
const MAX_DEDUP_CACHE_SIZE = 10_000;

/** Number of entries to evict when dedup cache is full. */
const DEDUP_EVICT_COUNT = 5_000;

/**
 * Callback type for processing incoming messages.
 */
export type MessageProcessor = (message: IncomingMessage) => Promise<void>;

/**
 * WeChat Message Listener.
 *
 * Polls the getUpdates API in a continuous loop, deduplicates messages,
 * converts them to the universal IncomingMessage format, and dispatches
 * them to a registered processor.
 */
export class WeChatMessageListener {
  private readonly client: WeChatApiClient;
  private readonly processor: MessageProcessor;
  private abortController?: AbortController;
  private pollPromise?: Promise<void>;
  private consecutiveErrors = 0;
  private readonly seenMessageIds = new Set<string>();

  /**
   * Create a new WeChat message listener.
   *
   * @param client - WeChat API client (must have a valid token)
   * @param processor - Callback for processing incoming messages
   */
  constructor(client: WeChatApiClient, processor: MessageProcessor) {
    this.client = client;
    this.processor = processor;
  }

  /**
   * Start the message listener.
   *
   * Begins the long-poll loop in the background. Safe to call multiple
   * times — subsequent calls are no-ops with a warning.
   */
  start(): void {
    if (this.abortController && !this.abortController.signal.aborted) {
      logger.warn('Message listener is already running');
      return;
    }

    this.abortController = new AbortController();
    this.pollPromise = this.pollLoop().catch((error) => {
      if (error instanceof Error && error.name === 'AbortError') {
        // Graceful shutdown — not an error
        return;
      }
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Message listener poll loop crashed'
      );
    });

    logger.info('WeChat message listener started');
  }

  /**
   * Stop the message listener.
   *
   * Aborts the current poll and waits for the loop to finish.
   * Safe to call when not started.
   */
  async stop(): Promise<void> {
    if (!this.abortController) {
      return;
    }

    this.abortController.abort();

    if (this.pollPromise) {
      try {
        await this.pollPromise;
      } catch {
        // Expected: poll loop throws on abort
      }
      this.pollPromise = undefined;
    }

    // Clear seen messages to free memory
    this.seenMessageIds.clear();
    logger.info('WeChat message listener stopped');
  }

  /**
   * Check if the listener is currently active.
   */
  isListening(): boolean {
    return !!this.abortController && !this.abortController.signal.aborted;
  }

  /**
   * Main polling loop.
   *
   * Continuously polls getUpdates until aborted. On timeout (normal),
   * immediately re-polls. On error, applies exponential backoff.
   */
  private async pollLoop(): Promise<void> {
    while (this.abortController && !this.abortController.signal.aborted) {
      try {
        const updates = await this.client.getUpdates({
          signal: this.abortController.signal,
        });

        // Reset error counter on successful poll
        this.consecutiveErrors = 0;

        // Process each update
        for (const update of updates) {
          // eslint-disable-next-line no-await-in-loop — sequential processing preserves order
          await this.processUpdate(update);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          // Graceful shutdown
          break;
        }

        this.consecutiveErrors++;
        logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            consecutiveErrors: this.consecutiveErrors,
          },
          'Error in message poll loop'
        );

        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logger.error(
            { consecutiveErrors: this.consecutiveErrors },
            'Too many consecutive errors, applying extended backoff'
          );
        }

        // Exponential backoff with cap
        const backoffMs = Math.min(
          BACKOFF_BASE_MS * Math.pow(2, Math.min(this.consecutiveErrors - 1, 5)),
          MAX_BACKOFF_MS,
        );

        logger.debug({ backoffMs }, 'Waiting before retry');

        await this.delay(backoffMs, this.abortController.signal);
      }
    }
  }

  /**
   * Process a single update from getUpdates.
   *
   * Deduplicates by msg_id, converts to IncomingMessage, and
   * calls the registered processor.
   */
  private async processUpdate(update: WeChatUpdate): Promise<void> {
    if (!update.msg_id) {
      logger.warn({ update }, 'Received update without msg_id, skipping');
      return;
    }

    // Deduplication
    if (this.seenMessageIds.has(update.msg_id)) {
      logger.debug({ msgId: update.msg_id }, 'Duplicate message, skipping');
      return;
    }
    this.seenMessageIds.add(update.msg_id);

    // FIFO eviction when cache is full
    this.evictDedupCache();

    const message = this.convertToIncomingMessage(update);
    if (!message) {
      logger.debug({ msgId: update.msg_id }, 'Could not convert update to message, skipping');
      return;
    }

    logger.info(
      { msgId: message.messageId, chatId: message.chatId, type: message.messageType },
      'WeChat message received'
    );

    try {
      await this.processor(message);
    } catch (error) {
      logger.error(
        { err: error instanceof Error ? error.message : String(error), msgId: message.messageId },
        'Message processor failed'
      );
    }
  }

  /**
   * Evict old entries from the dedup cache using FIFO strategy.
   *
   * When the cache exceeds MAX_DEDUP_CACHE_SIZE, remove the oldest
   * DEDUP_EVICT_COUNT entries. Uses iterator-based deletion for
   * efficient FIFO ordering (Set preserves insertion order).
   */
  private evictDedupCache(): void {
    if (this.seenMessageIds.size <= MAX_DEDUP_CACHE_SIZE) {
      return;
    }

    let count = 0;
    const iter = this.seenMessageIds.values();
    const toRemove: string[] = [];

    while (count < DEDUP_EVICT_COUNT) {
      const result = iter.next();
      if (result.done) {
        break;
      }
      toRemove.push(result.value);
      count++;
    }

    for (const id of toRemove) {
      this.seenMessageIds.delete(id);
    }

    logger.debug(
      { evicted: toRemove.length, remaining: this.seenMessageIds.size },
      'Trimmed message dedup cache',
    );
  }

  /**
   * Convert a WeChat update to the universal IncomingMessage format.
   */
  private convertToIncomingMessage(update: WeChatUpdate): IncomingMessage | null {
    if (!update.from_user_id || !update.item_list?.length) {
      return null;
    }

    // Determine message type and content from first item
    const [firstItem] = update.item_list;
    let messageType: IncomingMessage['messageType'];
    let content: string;
    let attachments: IncomingMessage['attachments'];

    switch (firstItem.type) {
      case 1: {
        // Text message
        messageType = 'text';
        content = (firstItem as WeChatTextItem).text_item?.text ?? '';
        break;
      }
      case 2: {
        // Image message
        messageType = 'image';
        content = '[Image received]';
        attachments = [{
          fileName: 'image',
          filePath: (firstItem as WeChatImageItem).image_item?.url ?? '',
        }];
        break;
      }
      case 3: {
        // File message
        const fileItem = firstItem as WeChatFileItem;
        messageType = 'file';
        const fileName = fileItem.file_item?.file_name ?? 'unknown';
        content = `[File received: ${fileName}]`;
        attachments = [{
          fileName,
          filePath: fileItem.file_item?.url ?? '',
          size: fileItem.file_item?.file_size,
        }];
        break;
      }
      default: {
        // Unknown type — try to extract text from all items
        messageType = 'text';
        const textParts = update.item_list
          .filter((item): item is WeChatTextItem =>
            item.type === 1 && !!(item as WeChatTextItem).text_item?.text,
          )
          .map((item) => (item as WeChatTextItem).text_item.text);
        content = textParts.join('\n') || `[Unsupported message type: ${firstItem.type}]`;
        break;
      }
    }

    return {
      messageId: update.msg_id,
      chatId: update.from_user_id, // In WeChat, chatId = userId for P2P
      userId: update.from_user_id,
      content,
      messageType,
      timestamp: update.create_time ? update.create_time * 1000 : Date.now(),
      threadId: update.context_token,
      attachments,
    };
  }

  /**
   * Delay helper that respects AbortSignal.
   */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
