/**
 * WeChat Message Listener.
 *
 * Long-polls the getUpdates API endpoint to receive incoming messages,
 * deduplicates them, and dispatches them to the registered handler.
 *
 * Features:
 * - Long-poll loop with configurable timeout (35s default)
 * - Message deduplication via FIFO Set (configurable max size)
 * - Exponential backoff on consecutive errors
 * - Max consecutive error threshold to prevent infinite retry
 * - Graceful shutdown via AbortController
 *
 * @module channels/wechat/message-listener
 * @see Issue #1556 - WeChat Channel Feature Enhancement (Phase 3)
 */

import { createLogger, type IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type {
  WeChatRawMessage,
  MessageListenerConfig,
  WeChatGetUpdatesResponse,
  WeChatTextItem,
  WeChatImageItem,
  WeChatFileItem,
} from './types.js';
import { DEFAULT_LISTENER_CONFIG, WECHAT_MESSAGE_TYPE_MAP } from './types.js';

const logger = createLogger('WeChatMessageListener');

/**
 * Callback for handling parsed incoming messages.
 */
export type MessageCallback = (message: IncomingMessage) => Promise<void>;

/**
 * WeChat Message Listener.
 *
 * Polls `POST /ilink/bot/getupdates` in a loop, deduplicates messages,
 * parses them into `IncomingMessage` format, and dispatches to a handler.
 *
 * Usage:
 * ```typescript
 * const listener = new WeChatMessageListener(client, messageHandler);
 * await listener.start();
 * // ... later
 * listener.stop();
 * ```
 */
export class WeChatMessageListener {
  private readonly client: WeChatApiClient;
  private readonly handler: MessageCallback;
  private readonly config: Required<MessageListenerConfig>;

  /** Message IDs already seen (FIFO Set for deduplication). */
  private readonly seenIds = new Set<string>();

  /** AbortController for the current poll request. */
  private pollAbortController?: AbortController;

  /** AbortController for the overall listener lifecycle. */
  private readonly lifecycleAbort = new AbortController();

  /** Current consecutive error count. */
  private consecutiveErrors = 0;

  /** Whether the listener is running. */
  private running = false;

  /** Resolves when the poll loop exits. */
  private pollLoopPromise?: Promise<void>;

  /**
   * Create a new message listener.
   *
   * @param client - WeChat API client (must have a token set)
   * @param handler - Callback for each parsed incoming message
   * @param config - Listener configuration
   */
  constructor(
    client: WeChatApiClient,
    handler: MessageCallback,
    config?: MessageListenerConfig
  ) {
    this.client = client;
    this.handler = handler;
    this.config = { ...DEFAULT_LISTENER_CONFIG, ...config };
  }

  /**
   * Start the message listener.
   *
   * Begins a long-poll loop in the background. Use `stop()` to end it.
   * If already running, this is a no-op.
   */
  start(): void {
    if (this.running) {
      logger.warn('Message listener already running');
      return;
    }

    if (!this.client.hasToken()) {
      logger.error('Cannot start listener: no bot token set');
      throw new Error('Cannot start message listener without bot token');
    }

    this.running = true;
    this.consecutiveErrors = 0;
    logger.info(
      { pollTimeoutMs: this.config.pollTimeoutMs, dedupMaxSize: this.config.dedupMaxSize },
      'Starting WeChat message listener'
    );

    this.pollLoopPromise = this.pollLoop();
  }

  /**
   * Stop the message listener gracefully.
   *
   * Aborts the current poll request and waits for the loop to exit.
   * If already stopped, this is a no-op.
   *
   * @returns Promise that resolves when the listener has fully stopped
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info('Stopping WeChat message listener');
    this.running = false;

    // Abort current poll request
    this.lifecycleAbort.abort();
    this.pollAbortController?.abort();

    // Wait for poll loop to finish
    await this.pollLoopPromise;
    this.pollLoopPromise = undefined;

    logger.info('WeChat message listener stopped');
  }

  /**
   * Check if the listener is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  // ---------------------------------------------------------------------------
  // Internal implementation
  // ---------------------------------------------------------------------------

  /**
   * Main polling loop.
   *
   * Repeatedly calls getUpdates and processes messages until stopped.
   * Uses exponential backoff on errors with a max threshold.
   */
  private async pollLoop(): Promise<void> {
    while (this.running && !this.lifecycleAbort.signal.aborted) {
      try {
        const response = await this.pollOnce();
        this.processResponse(response);

        // Reset error count on successful poll
        if (this.consecutiveErrors > 0) {
          logger.info({ prevErrors: this.consecutiveErrors }, 'Polling recovered');
          this.consecutiveErrors = 0;
        }
      } catch (error) {
        this.consecutiveErrors++;

        if (this.consecutiveErrors >= this.config.maxConsecutiveErrors) {
          logger.error(
            { consecutiveErrors: this.consecutiveErrors, max: this.config.maxConsecutiveErrors },
            'Max consecutive errors reached, stopping listener'
          );
          this.running = false;
          break;
        }

        const backoffMs = this.calculateBackoff(this.consecutiveErrors);
        logger.warn(
          {
            error: error instanceof Error ? error.message : String(error),
            consecutiveErrors: this.consecutiveErrors,
            backoffMs,
            maxErrors: this.config.maxConsecutiveErrors,
          },
          'Poll error, backing off before retry'
        );

        await this.sleep(backoffMs);
        continue;
      }

      // Brief delay between polls to avoid tight loop
      await this.sleep(this.config.pollIntervalMs);
    }
  }

  /**
   * Execute a single getUpdates poll.
   */
  private async pollOnce(): Promise<WeChatGetUpdatesResponse> {
    // Create a per-request AbortController so we can abort individual polls
    this.pollAbortController = new AbortController();
    const { signal } = this.pollAbortController;

    // If lifecycle is aborted, don't start a new poll
    if (this.lifecycleAbort.signal.aborted) {
      return { ret: 0, msg_list: [] };
    }

    // Set up a race between lifecycle abort and the API call
    const lifecycleAbortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener('abort', onAbort);
        reject(new DOMException('Lifecycle aborted', 'AbortError'));
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    try {
      return await Promise.race([
        this.client.getUpdates({ timeoutMs: this.config.pollTimeoutMs }),
        lifecycleAbortPromise,
      ]);
    } finally {
      this.pollAbortController = undefined;
    }
  }

  /**
   * Process the getUpdates response and dispatch messages.
   */
  private async processResponse(response: WeChatGetUpdatesResponse): Promise<void> {
    const messages = response.msg_list;
    if (!messages || messages.length === 0) {
      return;
    }

    logger.debug({ count: messages.length }, 'Processing messages from getUpdates');

    for (const raw of messages) {
      if (!raw.msg_id) {
        logger.debug({ raw }, 'Skipping message without msg_id');
        continue;
      }

      // Deduplication check
      if (this.seenIds.has(raw.msg_id)) {
        logger.debug({ msgId: raw.msg_id }, 'Deduplicating message');
        continue;
      }

      // Track seen message
      this.addToDedup(raw.msg_id);

      // Skip messages from self (bot)
      if (raw.source === 'bot' || raw.from_user_id === raw.to_user_id) {
        logger.debug({ msgId: raw.msg_id }, 'Skipping self-sent message');
        continue;
      }

      // Parse and dispatch
      const message = this.parseMessage(raw);
      if (message) {
        try {
          await this.handler(message);
        } catch (handlerError) {
          logger.error(
            { msgId: raw.msg_id, err: handlerError instanceof Error ? handlerError.message : String(handlerError) },
            'Message handler threw error'
          );
        }
      }
    }
  }

  /**
   * Parse a raw WeChat message into the standard IncomingMessage format.
   */
  private parseMessage(raw: WeChatRawMessage): IncomingMessage | null {
    if (!raw.from_user_id || !raw.msg_id) {
      logger.debug({ raw }, 'Skipping message without from_user_id or msg_id');
      return null;
    }

    const messageType = WECHAT_MESSAGE_TYPE_MAP[raw.message_type ?? 0] ?? 'text';
    const content = this.extractContent(raw, messageType);
    const chatId = raw.from_user_id;

    const message: IncomingMessage = {
      messageId: raw.msg_id,
      chatId,
      userId: raw.from_user_id,
      content,
      messageType,
      timestamp: raw.create_time ? raw.create_time * 1000 : undefined,
      threadId: raw.context_token,
      metadata: {
        toUserId: raw.to_user_id,
        clientId: raw.client_id,
        source: raw.source,
        rawMessageType: raw.message_type,
      },
    };

    return message;
  }

  /**
   * Extract text content from a raw message.
   */
  private extractContent(raw: WeChatRawMessage, messageType: IncomingMessage['messageType']): string {
    const items = raw.item_list;
    if (!items || items.length === 0) {
      return '';
    }

    switch (messageType) {
      case 'text': {
        const textParts: string[] = [];
        for (const item of items) {
          if (item.type === 1) {
            const textItem = item as WeChatTextItem;
            textParts.push(textItem.text_item.text);
          }
        }
        return textParts.join('');
      }
      case 'image': {
        const imgItem = items.find((i): i is WeChatImageItem => i.type === 2);
        if (imgItem?.image_item) {
          const { image_url, image_key } = imgItem.image_item;
          return image_url || image_key || '[image]';
        }
        return '[image]';
      }
      case 'file': {
        const fileItem = items.find((i): i is WeChatFileItem => i.type === 3);
        if (fileItem?.file_item) {
          const { file_name, file_url, file_size } = fileItem.file_item;
          return file_name || file_url || `[file${file_size ? ` (${file_size} bytes)` : ''}]`;
        }
        return '[file]';
      }
      default:
        return '';
    }
  }

  /**
   * Add a message ID to the deduplication set.
   *
   * Uses FIFO eviction when the set exceeds maxSize.
   */
  private addToDedup(msgId: string): void {
    if (this.seenIds.size >= this.config.dedupMaxSize) {
      // FIFO eviction: remove oldest entries
      // Since Set maintains insertion order, we can remove the first entry
      const iter = this.seenIds.values();
      const oldest = iter.next().value;
      if (oldest !== undefined) {
        this.seenIds.delete(oldest);
      }
    }
    this.seenIds.add(msgId);
  }

  /**
   * Calculate exponential backoff delay with jitter.
   */
  private calculateBackoff(errorCount: number): number {
    const baseDelay = this.config.backoffBaseMs * Math.pow(2, errorCount - 1);
    const clampedDelay = Math.min(baseDelay, this.config.backoffMaxMs);
    // Add ±25% jitter
    const jitter = clampedDelay * 0.25;
    return Math.max(0, clampedDelay - jitter + Math.random() * jitter * 2);
  }

  /**
   * Sleep for a given duration, abortable via lifecycle signal.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.lifecycleAbort.signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      this.lifecycleAbort.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
