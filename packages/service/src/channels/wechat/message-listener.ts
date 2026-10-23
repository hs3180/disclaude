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
import { WeChatApiError, type WeChatApiClient } from './api-client.js';
import type { WeChatUpdate, WeChatImageItem, WeChatFileItem } from './types.js';

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
 * Grace before stop() stops waiting for a poll loop whose transport wait
 * ignored its abort signal (#5479). Shutdown must not be held hostage by a
 * wedged request; the loop still exits on its own once it observes the abort.
 */
const STOP_GRACE_MS = 5_000;

/**
 * Callback for processing received messages.
 */
export type MessageProcessor = (message: IncomingMessage) => Promise<void>;

/**
 * Remote login confirmation derived from actual traffic (#5479).
 *
 * - 'pending': listening started, but the remote has not answered yet
 * - 'confirmed': the remote accepted a poll or a startup session probe
 * - 'login-expired': the remote rejected the credentials (-14/401); re-login required
 */
export type WeChatAuthConfirmation = 'pending' | 'confirmed' | 'login-expired';

export interface WeChatListenerState {
  cursor: string;
  seenMessageIds: string[];
}

export interface WeChatListenerOptions {
  state?: WeChatListenerState;
  checkpoint?: (state: WeChatListenerState) => Promise<void>;
  /** Keep reply credentials out of generic message/thread metadata. */
  onContext?: (peer: string, token: string) => void;
  resolveAttachment?: (item: WeChatImageItem | WeChatFileItem, signal?: AbortSignal) => Promise<NonNullable<IncomingMessage['attachments']>[number]>;
}

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
  private remoteAuth: WeChatAuthConfirmation;

  /**
   * Create a new message listener.
   *
   * @param client - WeChat API client
   * @param processor - Callback to process incoming messages
   */
  constructor(client: WeChatApiClient, processor: MessageProcessor, private readonly options: WeChatListenerOptions = {}) {
    this.client = client;
    this.processor = processor;
    this.seenMessageIds = new Set(options.state?.seenMessageIds.slice(-MAX_DEDUP_CACHE_SIZE));
    if (options.state) { this.client.setUpdatesCursor(options.state.cursor); }
    this.consecutiveErrors = 0;
    this.remoteAuth = 'pending';
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
    this.remoteAuth = 'pending';
    this.pollPromise = this.pollLoop(this.abortController.signal);
    logger.info('WeChat message listener started');
  }

  /**
   * Stop the message listening loop.
   *
   * Aborts the current poll and waits for the loop to exit.
   * Safe to call multiple times.
   */
  async stop(): Promise<void> {
    if (!this.abortController && !this.pollPromise) {
      return;
    }

    logger.info('Stopping WeChat message listener...');
    this.abortController?.abort();
    this.abortController = undefined;

    if (this.pollPromise) {
      const grace = new Promise<void>((resolve) => { setTimeout(resolve, STOP_GRACE_MS).unref(); });
      try {
        await Promise.race([this.pollPromise, grace]);
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

  isHealthy(): boolean { return this.isListening() && this.consecutiveErrors === 0 && this.remoteAuth === 'confirmed'; }

  /**
   * Remote login confirmation state (#5479): a started listener stays
   * 'pending' until the remote accepts a poll, so freshly restored
   * credentials are never reported as proven-healthy without traffic.
   */
  authState(): WeChatAuthConfirmation { return this.remoteAuth; }

  /**
   * Fold a read-only session probe verdict into the auth confirmation state
   * (#5479). An expired verdict always wins; a passing probe only confirms
   * still-pending credentials and never overrides poll traffic. Inconclusive
   * probes (network errors) are not reported here — the listener stays
   * pending until real traffic decides.
   */
  applyAuthProbe(authExpired: boolean): void {
    if (authExpired) { this.remoteAuth = 'login-expired'; return; }
    if (this.remoteAuth === 'pending') { this.remoteAuth = 'confirmed'; }
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
  private async pollLoop(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        try {
          const updates = await this.client.getUpdates({
            signal,
          });

          // Reset error counter on successful poll; the remote just
          // accepted these credentials, so login is confirmed (#5479).
          this.consecutiveErrors = 0;
          this.remoteAuth = 'confirmed';

          // Process each update
          for (const update of updates) {
            if (signal.aborted) { break; }
            await this.processUpdate(update, signal);
          }
          if (signal.aborted) { break; }
          this.client.acknowledgeUpdates();
          await this.checkpoint();

          // Yield to macrotask queue to prevent microtask starvation
          // and allow stop()/abort to interleave between poll cycles
          await new Promise<void>((resolve) => setImmediate(resolve));
        } catch (error) {
          if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
            // Graceful shutdown
            break;
          }
          if (error instanceof WeChatApiError && error.authExpired) {
            this.remoteAuth = 'login-expired';
            logger.error({ code: error.code }, 'WeChat login expired; run disclaude wechat login, then restart this channel');
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

          await this.delay(backoffMs, signal);
        }
      }
    } finally {
      if (this.abortController?.signal === signal) { this.abortController = undefined; }
    }
  }

  private async checkpoint(): Promise<void> {
    await this.options.checkpoint?.({ cursor: this.client.getUpdatesCursor(), seenMessageIds: [...this.seenMessageIds] });
  }

  /**
   * Process a single update from getUpdates.
   *
   * Deduplicates by msg_id, converts to IncomingMessage, and
   * calls the registered processor.
   */
  private async processUpdate(update: WeChatUpdate, signal?: AbortSignal): Promise<void> {
    if (update.message_type === 2 || update.group_id) { return; }
    const id = update.message_id ?? update.msg_id ?? update.client_id;
    if (!id) {
      logger.warn('Received update without message ID, skipping');
      return;
    }

    // Deduplication
    if (this.seenMessageIds.has(id)) {
      logger.debug({ msgId: id }, 'Duplicate message, skipping');
      return;
    }
    const message = await this.convertToIncomingMessage(update, signal);
    if (!message) {
      logger.debug({ msgId: id }, 'Could not convert update to message, skipping');
      return;
    }

    logger.info(
      { msgId: message.messageId, chatId: message.chatId, type: message.messageType },
      'WeChat message received',
    );

    try {
      if (update.context_token) { this.options.onContext?.(message.chatId, update.context_token); }
      await this.processor(message);
      this.seenMessageIds.add(id);
      this.evictDedupCacheIfNeeded();
      await this.checkpoint();
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: errMsg, msgId: message.messageId },
        'Message processor failed',
      );
      throw error;
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
  private async convertToIncomingMessage(update: WeChatUpdate, signal?: AbortSignal): Promise<IncomingMessage | null> {
    if (!update.from_user_id || !update.item_list?.length) {
      return null;
    }

    const textParts: string[] = [];
    const attachments: NonNullable<IncomingMessage['attachments']> = [];
    let messageType: IncomingMessage['messageType'] = 'text';
    for (const item of update.item_list) {
      if (item.type === 1) {
        if (item.text_item?.text) { textParts.push(item.text_item.text); }
      } else if (item.type === 2) {
        messageType = 'image';
        textParts.push('[Image received]');
      } else if (item.type === 4) {
        messageType = 'file';
        const file = item.file_item;
        textParts.push(`[File received: ${file?.file_name ?? 'unknown'}]`);
      } else {
        textParts.push(`[Unsupported message type: ${String((item as { type?: number }).type)}]`);
      }
      if (item.type === 2 || item.type === 4) {
        try {
          if (this.options.resolveAttachment) { attachments.push(await this.options.resolveAttachment(item, signal)); }
          else if (item.type === 2 && item.image_item?.url) { attachments.push({ fileName: 'image', filePath: item.image_item.url }); }
          else if (item.type === 4 && item.file_item?.url) { attachments.push({ fileName: item.file_item.file_name ?? 'unknown', filePath: item.file_item.url, size: item.file_item.file_size }); }
          else { textParts.push('[Attachment unavailable: no media downloader]'); }
        } catch {
          if (signal?.aborted) { throw new DOMException('aborted', 'AbortError'); }
          textParts.push('[Attachment unavailable: download, size or decryption failure; ask the user to resend]');
        }
      }
    }
    const content = textParts.join('\n');

    return {
      messageId: update.message_id ?? update.msg_id ?? update.client_id ?? '',
      chatId: update.from_user_id, // In WeChat, chatId = userId for P2P
      userId: update.from_user_id,
      content,
      messageType,
      timestamp: update.create_time_ms ?? (update.create_time ? update.create_time * 1000 : Date.now()),
      attachments: attachments.length ? attachments : undefined,
    };
  }

  /**
   * Delay helper that respects AbortSignal.
   */
  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) { resolve(); return; }
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
