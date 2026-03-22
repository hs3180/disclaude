/**
 * WeChat Message Monitor.
 *
 * Handles long polling for incoming messages.
 *
 * @module channels/wechat/monitor
 */

import { createLogger } from '@disclaude/core';
import type { WeChatApiClient } from './api-client.js';
import type { WeChatIncomingMessage } from './types.js';

const logger = createLogger('WeChatMonitor');

/**
 * Message callback type.
 */
export type MessageCallback = (message: WeChatIncomingMessage) => void;

/**
 * Error callback type.
 */
export type ErrorCallback = (error: Error) => void;

/**
 * Default long polling timeout in seconds.
 */
const DEFAULT_POLLING_TIMEOUT = 35;

/**
 * Reconnect delay in milliseconds.
 */
const RECONNECT_DELAY = 5000;

/**
 * Maximum reconnect attempts.
 */
const MAX_RECONNECT_ATTEMPTS = 10;

/**
 * WeChat message monitor.
 *
 * Uses long polling to receive incoming messages.
 * Handles automatic reconnection on failure.
 */
export class WeChatMonitor {
  private readonly client: WeChatApiClient;
  private readonly pollingTimeout: number;
  private messageCallback?: MessageCallback;
  private errorCallback?: ErrorCallback;
  private running = false;
  private pollPromise?: Promise<void>;
  private reconnectAttempts = 0;

  /** Set of processed message IDs for deduplication */
  private processedMessages: Set<string> = new Set();

  /** Maximum number of message IDs to keep for deduplication */
  private readonly MAX_PROCESSED_MESSAGES = 1000;

  constructor(client: WeChatApiClient, pollingTimeout?: number) {
    this.client = client;
    this.pollingTimeout = pollingTimeout ?? DEFAULT_POLLING_TIMEOUT;
  }

  /**
   * Set callback for incoming messages.
   */
  onMessage(callback: MessageCallback): void {
    this.messageCallback = callback;
  }

  /**
   * Set callback for errors.
   */
  onError(callback: ErrorCallback): void {
    this.errorCallback = callback;
  }

  /**
   * Start monitoring for messages.
   */
  start(): void {
    if (this.running) {
      logger.warn('Monitor already running');
      return;
    }

    logger.info('Starting message monitor');
    this.running = true;
    this.reconnectAttempts = 0;
    this.pollPromise = this.pollLoop();
  }

  /**
   * Stop monitoring.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    logger.info('Stopping message monitor');
    this.running = false;

    if (this.pollPromise) {
      await this.pollPromise;
      this.pollPromise = undefined;
    }

    this.processedMessages.clear();
    logger.info('Message monitor stopped');
  }

  /**
   * Check if monitor is running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Main polling loop.
   */
  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.poll();
        // Reset reconnect attempts on successful poll
        this.reconnectAttempts = 0;
      } catch (err) {
        logger.error({ err }, 'Poll error');

        if (!this.running) {
          break;
        }

        // Handle reconnection
        this.reconnectAttempts++;
        if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
          logger.error('Max reconnect attempts reached');
          this.errorCallback?.(new Error('Max reconnect attempts reached'));
          break;
        }

        logger.info(
          { attempt: this.reconnectAttempts, delay: RECONNECT_DELAY },
          'Reconnecting after error'
        );
        await this.sleep(RECONNECT_DELAY);
      }
    }
  }

  /**
   * Single poll operation.
   */
  private async poll(): Promise<void> {
    if (!this.running) {
      return;
    }

    const response = await this.client.getUpdates(this.pollingTimeout);

    if (!response.success) {
      // Authentication error - should stop
      if (response.error.errcode === 401) {
        logger.error('Authentication lost');
        this.errorCallback?.(new Error('Authentication lost'));
        this.running = false;
        return;
      }

      // Other errors - throw to trigger reconnect
      throw new Error(`Poll failed: ${response.error.errmsg}`);
    }

    const { messages } = response.data;

    if (messages && messages.length > 0) {
      logger.debug({ count: messages.length }, 'Received messages');

      for (const message of messages) {
        this.processMessage(message);
      }
    }
  }

  /**
   * Process a single incoming message.
   */
  private processMessage(message: WeChatIncomingMessage): void {
    // Deduplication check
    if (this.processedMessages.has(message.msg_id)) {
      logger.debug({ msgId: message.msg_id }, 'Duplicate message, skipping');
      return;
    }

    // Add to processed set
    this.processedMessages.add(message.msg_id);

    // Trim processed messages set if too large
    if (this.processedMessages.size > this.MAX_PROCESSED_MESSAGES) {
      const toRemove = this.processedMessages.size - this.MAX_PROCESSED_MESSAGES;
      const iterator = this.processedMessages.values();
      for (let i = 0; i < toRemove; i++) {
        const value = iterator.next().value;
        if (value) {
          this.processedMessages.delete(value);
        }
      }
    }

    // Emit to callback
    logger.debug(
      {
        msgId: message.msg_id,
        chatId: message.chat_id,
        type: message.msg_type,
        isGroup: message.is_group,
      },
      'Processing message'
    );

    this.messageCallback?.(message);
  }

  /**
   * Sleep helper.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
