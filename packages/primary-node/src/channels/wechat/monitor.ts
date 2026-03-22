/**
 * WeChat Message Monitor.
 *
 * Long-polling based message listener that continuously fetches new messages
 * from the WeChat Bot API and converts them to IncomingMessage format.
 *
 * Features:
 * - Long polling with configurable interval
 * - Message deduplication to prevent duplicate processing
 * - Automatic backoff on errors
 * - Graceful shutdown support
 *
 * @module channels/wechat/monitor
 */

import { createLogger } from '@disclaude/core';
import type { IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatApiMessage, DeduplicationEntry, MonitorState } from './types.js';

const logger = createLogger('WeChatMonitor');

/** Default long polling timeout in seconds. */
const DEFAULT_POLL_TIMEOUT = 35;

/** Default error backoff base delay in milliseconds. */
const DEFAULT_BACKOFF_MS = 1000;

/** Maximum backoff delay in milliseconds. */
const MAX_BACKOFF_MS = 60000;

/** Maximum number of deduplication entries to keep. */
const MAX_DEDUP_ENTRIES = 1000;

/** Maximum age for deduplication entries in milliseconds (5 minutes). */
const MAX_DEDUP_AGE_MS = 5 * 60 * 1000;

/**
 * Message handler callback type.
 * Called for each new incoming message after deduplication.
 */
export type MessageCallback = (message: IncomingMessage) => Promise<void>;

/**
 * WeChat message monitor.
 *
 * Continuously long-polls the WeChat API for new messages,
 * deduplicates them, and forwards them to the registered handler.
 */
export class WeChatMonitor {
  private readonly client: WeChatApiClient;
  private readonly pollTimeout: number;
  private state: MonitorState = 'idle';
  private abortController?: AbortController;
  private messageCallback?: MessageCallback;

  /** Message deduplication cache. */
  private dedupCache: Map<string, DeduplicationEntry> = new Map();

  /** Current backoff delay in milliseconds. */
  private backoffMs: number = DEFAULT_BACKOFF_MS;

  /** Polling loop promise (for awaiting shutdown). */
  private pollingPromise?: Promise<void>;

  /**
   * Create a new message monitor.
   *
   * @param client - WeChat API client
   * @param options - Monitor options
   */
  constructor(
    client: WeChatApiClient,
    options?: {
      /** Long polling timeout in seconds (default: 35) */
      pollTimeout?: number;
    }
  ) {
    this.client = client;
    this.pollTimeout = options?.pollTimeout || DEFAULT_POLL_TIMEOUT;
  }

  /**
   * Get the current monitor state.
   */
  getState(): MonitorState {
    return this.state;
  }

  /**
   * Check if the monitor is currently polling.
   */
  isPolling(): boolean {
    return this.state === 'polling';
  }

  /**
   * Register a callback for incoming messages.
   *
   * @param callback - Function to call for each new message
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Start the long-polling loop.
   *
   * This method starts a background loop that continuously polls
   * for new messages. It will keep running until stop() is called.
   */
  start(): void {
    if (this.state === 'polling') {
      logger.warn('Monitor already polling');
      return;
    }

    if (!this.client.hasToken()) {
      throw new Error('Cannot start monitor without authentication token');
    }

    this.state = 'polling';
    this.abortController = new AbortController();
    this.backoffMs = DEFAULT_BACKOFF_MS;

    logger.info({ pollTimeout: this.pollTimeout }, 'Starting message monitor');

    // Start polling loop (don't await - runs in background)
    this.pollingPromise = this.pollingLoop();
  }

  /**
   * Stop the long-polling loop.
   *
   * Gracefully shuts down the monitor and waits for the
   * current polling request to complete.
   */
  async stop(): Promise<void> {
    if (this.state !== 'polling') {
      return;
    }

    logger.info('Stopping message monitor');
    this.state = 'stopped';

    if (this.abortController) {
      this.abortController.abort();
    }

    // Wait for polling loop to finish
    if (this.pollingPromise) {
      try {
        await this.pollingPromise;
      } catch (error) {
        // Expected - abort causes the loop to throw
      }
      this.pollingPromise = undefined;
    }

    logger.info('Message monitor stopped');
  }

  /**
   * Main polling loop.
   *
   * Continuously fetches updates from the API and processes them.
   * Implements exponential backoff on errors.
   */
  private async pollingLoop(): Promise<void> {
    while (this.state === 'polling') {
      try {
        const updates = await this.client.getUpdates(this.pollTimeout);

        // Reset backoff on successful poll
        this.backoffMs = DEFAULT_BACKOFF_MS;

        // Process each update
        for (const update of updates) {
          try {
            const apiMessage = update as WeChatApiMessage;
            const message = this.convertMessage(apiMessage);

            if (message && !this.isDuplicate(message.messageId)) {
              this.recordSeen(message.messageId);

              if (this.messageCallback) {
                await this.messageCallback(message);
              }
            }
          } catch (error) {
            logger.error(
              { err: error instanceof Error ? error.message : String(error) },
              'Failed to process message update'
            );
          }
        }
      } catch (error) {
        if (this.state !== 'polling') {
          // Stopped during poll - exit cleanly
          break;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn({ err: errorMessage, backoffMs: this.backoffMs }, 'Polling error, backing off');

        // Exponential backoff
        await this.backoff();
      }
    }
  }

  /**
   * Convert a WeChat API message to the standard IncomingMessage format.
   */
  private convertMessage(apiMessage: WeChatApiMessage): IncomingMessage | null {
    if (!apiMessage.msgId || !apiMessage.chatId) {
      logger.warn({ msg: apiMessage }, 'Invalid message: missing msgId or chatId');
      return null;
    }

    // Extract text content
    let content = '';
    switch (apiMessage.msgType) {
      case 'text':
        content = apiMessage.text?.content || '';
        break;
      case 'image':
        content = `[Image: ${apiMessage.image?.cdnUrl || 'unknown'}]`;
        break;
      case 'file':
        content = `[File: ${apiMessage.file?.fileName || 'unknown'}]`;
        break;
      case 'voice':
        content = '[Voice message]';
        break;
      default:
        content = `[Unsupported message type: ${apiMessage.msgType}]`;
    }

    const message: IncomingMessage = {
      messageId: apiMessage.msgId,
      chatId: apiMessage.chatId,
      userId: apiMessage.fromUser?.id,
      content,
      messageType: apiMessage.msgType === 'file' ? 'file'
        : apiMessage.msgType === 'image' ? 'image'
          : 'text',
      timestamp: apiMessage.timestamp,
      metadata: {
        chatType: apiMessage.chatType,
        mentionedUserIds: apiMessage.mentionedUserIds,
        fromUserName: apiMessage.fromUser?.name,
      },
      attachments: this.extractAttachments(apiMessage),
    };

    return message;
  }

  /**
   * Extract file attachments from a WeChat message.
   */
  private extractAttachments(apiMessage: WeChatApiMessage) {
    if (apiMessage.msgType === 'image' && apiMessage.image?.cdnUrl) {
      return [{
        fileName: `image_${apiMessage.msgId}`,
        filePath: apiMessage.image.cdnUrl,
        size: apiMessage.image.fileSize,
      }];
    }

    if (apiMessage.msgType === 'file' && apiMessage.file?.cdnUrl) {
      return [{
        fileName: apiMessage.file.fileName || `file_${apiMessage.msgId}`,
        filePath: apiMessage.file.cdnUrl,
        mimeType: apiMessage.file.mimeType,
        size: apiMessage.file.fileSize,
      }];
    }

    return undefined;
  }

  /**
   * Check if a message has already been processed.
   */
  private isDuplicate(messageId: string): boolean {
    return this.dedupCache.has(messageId);
  }

  /**
   * Record a message as seen for deduplication.
   */
  private recordSeen(messageId: string): void {
    this.dedupCache.set(messageId, {
      msgId: messageId,
      seenAt: Date.now(),
    });

    // Prune old entries if cache grows too large
    if (this.dedupCache.size > MAX_DEDUP_ENTRIES) {
      this.pruneDedupCache();
    }
  }

  /**
   * Remove expired entries from the deduplication cache.
   */
  private pruneDedupCache(): void {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.dedupCache) {
      if (now - entry.seenAt > MAX_DEDUP_AGE_MS) {
        this.dedupCache.delete(key);
        pruned++;
      }
    }

    if (pruned > 0) {
      logger.debug({ pruned, remaining: this.dedupCache.size }, 'Pruned deduplication cache');
    }
  }

  /**
   * Wait with exponential backoff.
   */
  private async backoff(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.backoffMs);
      if (this.abortController) {
        this.abortController.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      }
    });

    // Increase backoff for next retry
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }
}
