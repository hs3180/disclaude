/**
 * WeChat Message Monitor.
 *
 * Long-polling based message listener that continuously fetches new messages
 * from the WeChat (Tencent ilink) Bot API and forwards them to the registered
 * handler after deduplication.
 *
 * Features:
 * - Long-polling via POST /ilink/bot/getupdates (35s timeout)
 * - Message deduplication using seen message IDs
 * - Exponential backoff on errors (1s → 60s max)
 * - Graceful start/stop lifecycle
 *
 * Based on official @tencent-weixin/openclaw-weixin implementation.
 *
 * @module channels/wechat/monitor
 * @see Issue #1474 - WeChat Channel: Message Listening (Long Polling)
 */

import { createLogger } from '@disclaude/core';
import type { IncomingMessage } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';

const logger = createLogger('WeChatMonitor');

/** Default long polling timeout in seconds. */
const DEFAULT_POLL_TIMEOUT_S = 35;

/** Default error backoff base delay in milliseconds. */
const DEFAULT_BACKOFF_BASE_MS = 1_000;

/** Maximum backoff delay in milliseconds. */
const MAX_BACKOFF_MS = 60_000;

/** Default maximum number of seen message IDs to track (for deduplication). */
const DEFAULT_DEDUP_MAX_SIZE = 1000;

/**
 * WeChat API update (incoming message) structure.
 *
 * Maps the raw ilink/bot/getupdates response to typed fields.
 */
export interface WeChatUpdate {
  /** Message ID for deduplication */
  msgId: string;
  /** Sender user ID */
  fromUserId: string;
  /** Recipient user ID (bot ID) */
  toUserId: string;
  /** Client-generated message ID (for context/reply) */
  clientId?: string;
  /** Message type (1=text, 3=image, 4=file, etc.) */
  msgType?: number;
  /** Text content (for text messages) */
  text?: string;
  /** Media/file info */
  media?: {
    /** File name */
    fileName?: string;
    /** CDN URL */
    cdnUrl?: string;
    /** File size */
    fileSize?: number;
    /** MIME type */
    fileType?: string;
  };
  /** Context token for threaded replies */
  contextToken?: string;
  /** Timestamp (Unix seconds) */
  createTime?: number;
}

/**
 * Monitor state.
 */
export type MonitorState = 'idle' | 'polling' | 'backoff' | 'stopped' | 'error';

/**
 * Callback for incoming messages.
 */
export type MessageCallback = (message: IncomingMessage) => Promise<void>;

/**
 * WeChat message monitor.
 *
 * Continuously long-polls the WeChat API for new messages,
 * deduplicates them, converts to IncomingMessage format,
 * and forwards them to the registered handler.
 *
 * Error handling strategy:
 * - On network/API errors, applies exponential backoff (1s → 60s max)
 * - On AbortError (timeout from long-poll), immediately retries (no backoff)
 * - Continues polling until stop() is called
 */
export class WeChatMonitor {
  private readonly client: WeChatApiClient;
  private readonly pollTimeout: number;
  private readonly backoffBaseMs: number;
  private readonly dedupMaxSize: number;

  /** Registered message callback */
  private messageCallback?: MessageCallback;

  /** Current monitor state */
  private state: MonitorState = 'idle';

  /** Abort controller for stopping the poll loop */
  private abortController?: AbortController;

  /** Current backoff delay in milliseconds */
  private currentBackoffMs: number;

  /** Seen message IDs for deduplication */
  private readonly seenMessageIds: Set<string>;

  /** Poll loop promise (for awaiting stop) */
  private pollLoopPromise?: Promise<void>;

  /** Counters for monitoring */
  private pollCount = 0;
  private messageCount = 0;
  private errorCount = 0;

  /**
   * Create a new message monitor.
   *
   * @param client - WeChat API client (must have a valid token)
   * @param options - Monitor configuration
   */
  constructor(
    client: WeChatApiClient,
    options?: {
      /** Long-poll timeout in seconds (default: 35) */
      pollTimeout?: number;
      /** Base delay for exponential backoff in ms (default: 1000) */
      backoffBaseMs?: number;
      /** Max dedup set size (default: 1000) */
      dedupMaxSize?: number;
    }
  ) {
    this.client = client;
    this.pollTimeout = options?.pollTimeout ?? DEFAULT_POLL_TIMEOUT_S;
    this.backoffBaseMs = options?.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.dedupMaxSize = options?.dedupMaxSize ?? DEFAULT_DEDUP_MAX_SIZE;
    this.currentBackoffMs = this.backoffBaseMs;
    this.seenMessageIds = new Set();

    if (!client.hasToken()) {
      logger.warn('Monitor created without a valid token; polling will fail until authenticated');
    }
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
    return this.state === 'polling' || this.state === 'backoff';
  }

  /**
   * Register a callback for incoming messages.
   *
   * @param callback - Function to call for each deduplicated new message
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Start the long-polling loop.
   *
   * This method starts a background loop that continuously polls
   * for new messages. It will keep running until stop() is called.
   * Long-poll timeouts are normal and do not trigger backoff.
   *
   * @throws {Error} If the client does not have a valid token
   */
  start(): void {
    if (this.state === 'polling' || this.state === 'backoff') {
      logger.warn('Monitor is already running');
      return;
    }

    if (!this.client.hasToken()) {
      throw new Error('Cannot start monitor: no valid bot token');
    }

    this.abortController = new AbortController();
    this.state = 'polling';
    this.currentBackoffMs = this.backoffBaseMs;
    this.pollCount = 0;
    this.messageCount = 0;
    this.errorCount = 0;

    logger.info(
      { pollTimeout: this.pollTimeout, backoffBaseMs: this.backoffBaseMs },
      'Starting WeChat message monitor'
    );

    // Run poll loop in background (don't await)
    this.pollLoopPromise = this.pollLoop(this.abortController.signal);
  }

  /**
   * Stop the long-polling loop.
   *
   * Aborts the current poll request and waits for the loop to exit.
   * Returns a promise that resolves when the monitor has fully stopped.
   *
   * @returns Promise that resolves when the monitor has stopped
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') {
      return;
    }

    logger.info(
      { polls: this.pollCount, messages: this.messageCount, errors: this.errorCount },
      'Stopping WeChat message monitor'
    );

    this.state = 'stopped';

    if (this.abortController) {
      this.abortController.abort();
    }

    // Wait for the poll loop to finish
    await this.pollLoopPromise;
    this.pollLoopPromise = undefined;
    this.abortController = undefined;

    logger.info('WeChat message monitor stopped');
  }

  /**
   * Main polling loop.
   *
   * Continuously calls getUpdates() with exponential backoff on errors.
   * Long-poll timeouts (AbortError) are treated as normal and do not trigger backoff.
   */
  private async pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        this.state = 'polling';
        this.pollCount++;

        const updates = await this.raceWithAbort(
          this.client.getUpdates(this.pollTimeout),
          signal
        );

        // Check abort after await
        if (signal.aborted) break;

        // Reset backoff on successful poll (even if no messages)
        this.currentBackoffMs = this.backoffBaseMs;

        if (updates.length > 0) {
          await this.processUpdates(updates);
        }
      } catch (error) {
        // AbortError from long-poll timeout is normal — no backoff
        if (error instanceof Error && error.name === 'AbortError') {
          logger.debug('Long-poll timed out, retrying immediately');
          continue;
        }

        // Check if this was our own abort (stop called)
        if (signal.aborted) {
          break;
        }

        // Real error — apply backoff
        this.errorCount++;
        this.state = 'backoff';

        const errMsg = error instanceof Error ? error.message : String(error);
        logger.warn(
          { error: errMsg, backoffMs: this.currentBackoffMs },
          'Poll error, applying backoff'
        );

        await this.backoffWait(signal);
        this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /**
   * Race a promise against an abort signal.
   * Rejects with an AbortError if the signal fires before the promise resolves.
   */
  private raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        promise.then(resolve, reject);
      }, 0);

      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };

      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (val) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          resolve(val);
        },
        (err) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', onAbort);
          reject(err);
        }
      );
    });
  }

  /**
   * Wait for the current backoff period.
   * Resolves early if the signal is aborted.
   */
  private backoffWait(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.currentBackoffMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }

  /**
   * Process a batch of updates from getUpdates.
   *
   * Deduplicates messages and forwards new ones to the callback.
   */
  private async processUpdates(updates: WeChatUpdate[]): Promise<void> {
    const newMessages: IncomingMessage[] = [];

    for (const update of updates) {
      // Deduplicate by message ID
      if (this.seenMessageIds.has(update.msgId)) {
        logger.debug({ msgId: update.msgId }, 'Duplicate message, skipping');
        continue;
      }

      this.seenMessageIds.add(update.msgId);
      this.messageCount++;

      // Evict old entries to prevent unbounded growth
      if (this.seenMessageIds.size > this.dedupMaxSize) {
        const excess = this.seenMessageIds.size - this.dedupMaxSize;
        const iter = this.seenMessageIds.values();
        for (let i = 0; i < excess; i++) {
          const val = iter.next().value;
          if (val !== undefined) {
            this.seenMessageIds.delete(val);
          }
        }
      }

      const incoming = this.toIncomingMessage(update);
      if (incoming) {
        newMessages.push(incoming);
      }
    }

    // Forward new messages to callback
    if (this.messageCallback && newMessages.length > 0) {
      for (const msg of newMessages) {
        try {
          await this.messageCallback(msg);
        } catch (error) {
          logger.error(
            { err: error instanceof Error ? error.message : String(error), messageId: msg.messageId },
            'Message callback threw an error'
          );
        }
      }
    }

    if (newMessages.length > 0) {
      logger.info({ count: newMessages.length }, 'Processed new messages');
    }
  }

  /**
   * Convert a WeChat update to the standard IncomingMessage format.
   *
   * Maps ilink API message types to standard message types:
   * - 1 → text
   * - 3 → image
   * - 4 → file
   * - other → text (fallback)
   */
  private toIncomingMessage(update: WeChatUpdate): IncomingMessage | null {
    const msgType = update.msgType ?? 1;

    // Determine message type and extract content
    let messageType: IncomingMessage['messageType'];
    let content: string;

    switch (msgType) {
      case 3: // Image
        messageType = 'image';
        content = update.media?.cdnUrl ?? '[image]';
        break;

      case 4: // File
        messageType = 'file';
        content = update.media?.fileName ?? update.media?.cdnUrl ?? '[file]';
        break;

      case 1: // Text
      default:
        messageType = 'text';
        content = update.text ?? '';
        break;
    }

    // Skip empty text messages
    if (messageType === 'text' && !content.trim()) {
      logger.debug({ msgId: update.msgId }, 'Skipping empty text message');
      return null;
    }

    const message: IncomingMessage = {
      messageId: update.msgId,
      chatId: update.fromUserId,
      userId: update.fromUserId,
      content,
      messageType,
      timestamp: update.createTime ? update.createTime * 1000 : Date.now(),
      threadId: update.contextToken,
      metadata: {
        toUserId: update.toUserId,
        clientId: update.clientId,
        msgType,
      },
    };

    // Add attachment info for media messages
    if (update.media && (messageType === 'image' || messageType === 'file')) {
      message.attachments = [
        {
          fileName: update.media.fileName ?? 'unknown',
          filePath: update.media.cdnUrl ?? '',
          mimeType: update.media.fileType,
          size: update.media.fileSize,
        },
      ];
    }

    return message;
  }

  /**
   * Get monitor statistics (for debugging/monitoring).
   */
  getStats(): {
    state: MonitorState;
    pollCount: number;
    messageCount: number;
    errorCount: number;
    dedupSetSize: number;
    currentBackoffMs: number;
  } {
    return {
      state: this.state,
      pollCount: this.pollCount,
      messageCount: this.messageCount,
      errorCount: this.errorCount,
      dedupSetSize: this.seenMessageIds.size,
      currentBackoffMs: this.currentBackoffMs,
    };
  }
}
