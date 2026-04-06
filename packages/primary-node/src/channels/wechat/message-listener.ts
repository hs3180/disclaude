/**
 * WeChat Message Listener.
 *
 * Implements long-poll based message listening via the getUpdates API.
 * Handles message deduplication, type parsing, and graceful shutdown.
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

/** Exponential backoff base for consecutive errors (milliseconds). */
const BACKOFF_BASE_MS = 2_000;

/** Maximum backoff delay (milliseconds). */
const MAX_BACKOFF_MS = 30_000;

/** Maximum dedup cache size before FIFO eviction. */
const MAX_DEDUP_CACHE_SIZE = 10_000;

/** Number of entries to evict when dedup cache is full. */
const DEDUP_EVICTION_COUNT = 5_000;

/**
 * Callback for processing received messages.
 */
export type MessageProcessor = (message: IncomingMessage) => Promise<void>;

/**
 * WeChat Message Listener.
 *
 * Long-polls the getUpdates API for incoming messages, converts them
 * to the universal IncomingMessage format, and passes them to the
 * registered message processor.
 *
 * Features:
 * - Long-poll based message receiving (35s timeout)
 * - Message deduplication via seen message IDs (FIFO eviction)
 * - Exponential backoff on consecutive errors
 * - Graceful shutdown via AbortController
 */
export class WeChatMessageListener {
  private readonly client: WeChatApiClient;
  private readonly processor: MessageProcessor;
  private abortController?: AbortController;
  private pollPromise?: Promise<void>;
  private readonly seenMessageIds: Set<string>;
  private consecutiveErrors: number;

  /**
   * Create a new message listener.
   *
   * @param client - WeChat API client
   * @param processor - Callback to process incoming messages
   */
  constructor(client: WeChatApiClient, processor: MessageProcessor) {
    this.client = client;
    this.processor = processor;
    this.seenMessageIds = new Set();
    this.consecutiveErrors = 0;
  }

  /**
   * Start the message listening loop.
   *
   * Begins long-polling for incoming messages. The loop runs
   * until stop() is called or an unrecoverable error occurs.
   */
  start(): void {
    if (this.abortController) {
      logger.warn('Message listener already running');
      return;
    }

    this.abortController = new AbortController();
    this.consecutiveErrors = 0;
    this.pollPromise = this.pollLoop();
    logger.info('WeChat message listener started');
  }

  /**
   * Stop the message listening loop.
   *
   * Aborts the current poll and waits for the loop to exit.
   * Safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (!this.abortController) {
      return;
    }

    logger.info('Stopping WeChat message listener...');
    this.abortController.abort();
    this.abortController = undefined;

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
   *
   * Yields to the macrotask queue between iterations to prevent
   * microtask starvation and allow stop() to interleave.
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
          await this.processUpdate(update);
        }

        // Yield to macrotask queue to prevent microtask starvation
        // and allow stop()/abort to interleave between poll cycles
        await new Promise<void>((resolve) => setImmediate(resolve));
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          // Graceful shutdown
          break;
        }

        this.consecutiveErrors++;
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(
          { err: errMsg, consecutiveErrors: this.consecutiveErrors },
          'Error in message poll loop',
        );

        if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logger.error(
            { consecutiveErrors: this.consecutiveErrors },
            'Too many consecutive errors, applying extended backoff',
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

    // FIFO eviction when cache exceeds limit
    this.evictDedupCacheIfNeeded();

    const message = this.convertToIncomingMessage(update);
    if (!message) {
      logger.debug({ msgId: update.msg_id }, 'Could not convert update to message, skipping');
      return;
    }

    logger.info(
      { msgId: message.messageId, chatId: message.chatId, type: message.messageType },
      'WeChat message received',
    );

    try {
      await this.processor(message);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: errMsg, msgId: message.messageId },
        'Message processor failed',
      );
    }
  }

  /**
   * Evict oldest entries from dedup cache when it exceeds MAX_DEDUP_CACHE_SIZE.
   *
   * Uses FIFO eviction: removes the first DEDUP_EVICTION_COUNT entries
   * that were inserted (oldest first).
   */
  private evictDedupCacheIfNeeded(): void {
    if (this.seenMessageIds.size <= MAX_DEDUP_CACHE_SIZE) {
      return;
    }

    let count = 0;
    for (const id of this.seenMessageIds) {
      this.seenMessageIds.delete(id);
      count++;
      if (count >= DEDUP_EVICTION_COUNT) {
        break;
      }
    }
    logger.debug(
      { evicted: count, remaining: this.seenMessageIds.size },
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
          .filter((item): item is WeChatTextItem => item.type === 1 && !!(item as WeChatTextItem).text_item?.text)
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
