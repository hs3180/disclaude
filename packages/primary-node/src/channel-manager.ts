/**
 * ChannelManager - Manages communication channels.
 *
 * This module handles:
 * - Channel registration
 * - Message broadcasting to all channels
 * - Channel lifecycle management (start/stop)
 *
 * Part of the PrimaryNode architecture.
 *
 * @module @disclaude/primary-node
 */

import {
  createLogger,
  type IChannel,
  type OutgoingMessage,
  type MessageHandler,
  type ControlHandler,
} from '@disclaude/core';

const logger = createLogger('ChannelManager');

/**
 * ChannelManager - Manages communication channels.
 *
 * Features:
 * - Registers and tracks channels
 * - Broadcasts messages to all channels
 * - Handles channel lifecycle (start/stop)
 */
export class ChannelManager {
  private channels: Map<string, IChannel> = new Map();
  /** Issue #3773: chatId → Channel mapping for multi-channel routing */
  private chatIdChannelMap: Map<string, IChannel> = new Map();

  /**
   * Register a communication channel.
   * If a channel with the same ID exists, it will be replaced.
   */
  register(channel: IChannel): void {
    if (this.channels.has(channel.id)) {
      logger.warn({ channelId: channel.id }, 'Channel already registered, replacing');
    }

    this.channels.set(channel.id, channel);
    logger.info({ channelId: channel.id, channelName: channel.name }, 'Channel registered');
  }

  /**
   * Set up message and control handlers for a channel.
   * This is typically called after registration to wire up handlers.
   */
  setupHandlers(
    channel: IChannel,
    messageHandler: MessageHandler,
    controlHandler: ControlHandler
  ): void {
    channel.onMessage(async (message) => {
      // Issue #3773: Register chatId → Channel mapping on incoming message
      this.registerChatId(message.chatId, channel);
      try {
        await messageHandler(message);
      } catch (error) {
        logger.error(
          { channelId: channel.id, messageId: message.messageId, error },
          'Failed to handle channel message'
        );
      }
    });

    channel.onControl(controlHandler);
    logger.debug({ channelId: channel.id }, 'Channel handlers set up');
  }

  /**
   * Get a registered channel by ID.
   */
  get(channelId: string): IChannel | undefined {
    return this.channels.get(channelId);
  }

  /**
   * Get all registered channels.
   */
  getAll(): IChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Get all channel IDs.
   */
  getIds(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Check if a channel is registered.
   */
  has(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /**
   * Unregister a channel by ID.
   * Issue #1594: Added for PrimaryNode integration.
   */
  unregister(channelId: string): boolean {
    const removed = this.channels.delete(channelId);
    if (removed) {
      logger.info({ channelId }, 'Channel unregistered');
    }
    return removed;
  }

  /**
   * Get the number of registered channels.
   */
  size(): number {
    return this.channels.size;
  }

  /**
   * Register a chatId → Channel mapping.
   * Called automatically when a channel receives a message (Issue #3773).
   * Can also be called manually to establish ownership for system-initiated messages.
   */
  registerChatId(chatId: string, channel: IChannel): void {
    const existing = this.chatIdChannelMap.get(chatId);
    if (existing && existing.id !== channel.id) {
      logger.debug(
        { chatId, fromChannelId: existing.id, toChannelId: channel.id },
        'ChatId ownership reassigned to different channel'
      );
    }
    this.chatIdChannelMap.set(chatId, channel);
  }

  /**
   * Resolve the channel that owns a given chatId.
   * Returns undefined if no mapping exists — the caller must handle this case.
   */
  getChannelForChatId(chatId: string): IChannel | undefined {
    return this.chatIdChannelMap.get(chatId);
  }

  /**
   * Broadcast a message to all registered channels.
   * Uses Promise.allSettled to ensure one channel's failure doesn't affect others.
   */
  async broadcast(message: OutgoingMessage): Promise<void> {
    if (this.channels.size === 0) {
      logger.warn({ chatId: message.chatId }, 'No channels registered');
      return;
    }

    const results = await Promise.allSettled(
      Array.from(this.channels.values()).map(async (channel) => {
        try {
          await channel.sendMessage(message);
        } catch (error) {
          logger.warn(
            { channelId: channel.id, chatId: message.chatId, error },
            'Channel failed to send message'
          );
          throw error;
        }
      })
    );

    // Log any failures
    const channelArray = Array.from(this.channels.values());
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.warn(
          { channelId: channelArray[index].id, chatId: message.chatId },
          'Message delivery failed'
        );
      }
    });
  }

  /**
   * Start all registered channels.
   * Uses Promise.allSettled to ensure one channel's failure doesn't prevent others from starting.
   * If any channel fails to start, attempts to stop already-started channels before throwing.
   */
  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      Array.from(this.channels.values()).map(async (channel) => {
        try {
          await channel.start();
          logger.info({ channelId: channel.id }, 'Channel started');
        } catch (error) {
          logger.error({ channelId: channel.id, error }, 'Failed to start channel');
          throw error;
        }
      })
    );

    // Check for any failures
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      const failureCount = failures.length;
      // Attempt to stop any channels that did start
      logger.warn({ failureCount, total: this.channels.size }, 'Some channels failed to start, stopping already-started channels');
      await this.stopAll();

      throw new Error(`${failureCount} channel(s) failed to start`);
    }
  }

  /**
   * Stop all registered channels.
   * Uses Promise.allSettled to ensure one channel's failure doesn't prevent others from stopping.
   * Critical for graceful shutdown — all channels must be stopped regardless of individual failures.
   */
  async stopAll(): Promise<void> {
    if (this.channels.size === 0) {
      return;
    }

    const results = await Promise.allSettled(
      Array.from(this.channels.values()).map(async (channel) => {
        try {
          await channel.stop();
          logger.info({ channelId: channel.id }, 'Channel stopped');
        } catch (error) {
          logger.error({ channelId: channel.id, error }, 'Failed to stop channel');
          throw error;
        }
      })
    );

    // Log failures but don't throw — shutdown must complete
    const failures = results.filter((r) => r.status === 'rejected');
    if (failures.length > 0) {
      logger.warn(
        { failureCount: failures.length, total: this.channels.size },
        'Some channels failed to stop during shutdown'
      );
    }
  }

  /**
   * Get status info for all channels.
   */
  getStatusInfo(): Array<{ id: string; name: string; status: string }> {
    return Array.from(this.channels.entries()).map(([id, channel]) => ({
      id,
      name: channel.name,
      status: channel.status,
    }));
  }

  /**
   * Pre-register chatIds to available channels.
   * Issue #3835: Ensures chatId→Channel mappings exist at startup,
   * before any user message triggers the lazy registration via setupHandlers.
   *
   * @param chatIds - Array of chatIds to register (e.g. from scheduled tasks)
   * @returns Number of newly registered chatIds
   */
  preregisterScheduleChatIds(chatIds: string[]): number {
    if (chatIds.length === 0 || this.channels.size === 0) {
      return 0;
    }

    const channels = this.getAll();
    let registered = 0;

    for (const chatId of chatIds) {
      if (this.chatIdChannelMap.has(chatId)) {
        continue;
      }

      // Prefer non-REST channels: REST channels don't handle chatId-based routing,
      // while Feishu/WeChat channels can deliver to any chatId they own.
      const channel = channels.find(ch => ch.id !== 'rest') || channels[0];
      if (channel) {
        this.registerChatId(chatId, channel);
        registered++;
      }
    }

    if (registered > 0) {
      logger.info(
        { registered, total: chatIds.length },
        'Pre-registered chatId→Channel mappings from scheduled tasks'
      );
    }

    return registered;
  }

  /**
   * Clear all channels without stopping them.
   */
  clear(): void {
    this.channels.clear();
    this.chatIdChannelMap.clear();
  }
}
