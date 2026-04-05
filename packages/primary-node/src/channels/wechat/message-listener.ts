/**
 * WeChat Message Listener.
 *
 * Long-poll based message listener for the WeChat (Tencent ilink) Bot API.
 * Continuously polls getUpdates and dispatches incoming messages to a processor.
 *
 * Features:
 * - In-memory deduplication with efficient FIFO eviction
 * - Exponential backoff on errors with configurable threshold
 * - Graceful shutdown via AbortController
 *
 * @module channels/wechat/message-listener
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3.1)
 */

import { createLogger, type IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatUpdate, WeChatTextItem, WeChatImageItem, WeChatFileItem } from './types.js';

const logger = createLogger('WeChatMessageListener');

/** Base backoff delay in milliseconds. */
const BACKOFF_BASE_MS = 1_000;

/** Maximum backoff delay in milliseconds. */
const MAX_BACKOFF_MS = 30_000;

/** Maximum number of consecutive errors before logging extended backoff. */
const MAX_CONSECUTIVE_ERRORS = 5;

/** Maximum number of message IDs to keep for deduplication. */
const DEDUP_SET_MAX_SIZE = 10_000;

/** Number of entries to evict when dedup set exceeds max size. */
const DEDUP_EVICT_COUNT = 5_000;

/**
 * Callback for processing incoming messages.
 */
export type MessageProcessor = (message: IncomingMessage) => Promise<void>;

/**
 * WeChat Message Listener.
 *
 * Long-polls the getUpdates API endpoint and dispatches incoming messages
 * to a registered processor. Handles deduplication, backoff, and
 * graceful shutdown.
 */
export class WeChatMessageListener {
  private readonly client: WeChatApiClient;
  private readonly processor: MessageProcessor;
  private readonly dedupMaxSize: number;
  private readonly dedupEvictCount: number;
  private abortController?: AbortController;
  private pollPromise?: Promise<void>;
  private readonly seenMessageIds = new Set<string>();
  private consecutiveErrors = 0;

  /**
   * Create a new WeChat message listener.
   *
   * @param client - WeChat API client (must have a valid token)
   * @param processor - Callback for processing each incoming message
   * @param options - Optional configuration
   */
  constructor(
    client: WeChatApiClient,
    processor: MessageProcessor,
    options?: {
      /** Maximum dedup set size before eviction (default: 10,000) */
      dedupMaxSize?: number;
      /** Number of entries to evict (default: 5,000) */
      dedupEvictCount?: number;
    },
  ) {
    this.client = client;
    this.processor = processor;
    this.dedupMaxSize = options?.dedupMaxSize ?? DEDUP_SET_MAX_SIZE;
    this.dedupEvictCount = options?.dedupEvictCount ?? DEDUP_EVICT_COUNT;
  }

  /**
   * Start the message listener.
   *
   * Begins long-polling in the background. Call stop() to terminate.
   */
  start(): void {
    if (this.isListening()) {
      logger.warn('Message listener is already running');
      return;
    }

    this.abortController = new AbortController();
    this.pollPromise = this.pollLoop();
    logger.info('WeChat message listener started');
  }

  /**
   * Stop the message listener.
   *
   * Aborts the long-poll loop and waits for it to finish.
   */
  async stop(): Promise<void> {
    if (!this.isListening()) {
      return;
    }

    this.abortController?.abort();

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
          BACKOFF_BASE_MS * 2 ** Math.min(this.consecutiveErrors - 1, 5),
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

    // Efficient FIFO eviction: convert to array, trim, rebuild
    if (this.seenMessageIds.size > this.dedupMaxSize) {
      const entries = Array.from(this.seenMessageIds);
      const toKeep = entries.slice(this.dedupEvictCount);
      this.seenMessageIds.clear();
      for (const id of toKeep) {
        this.seenMessageIds.add(id);
      }
      logger.debug({ remaining: this.seenMessageIds.size }, 'Trimmed message dedup cache');
    }

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
      logger.error(
        { err: error instanceof Error ? error.message : String(error), msgId: message.messageId },
        'Message processor failed',
      );
    }
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
        const textParts = (update.item_list ?? [])
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
