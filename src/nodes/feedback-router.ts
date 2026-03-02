/**
 * FeedbackRouter - Routes feedback from execution to channels.
 *
 * Extracts feedback handling concerns from PrimaryNode:
 * - Handles feedback messages (text, card, file, done, error)
 * - Broadcasts to registered channels
 * - Manages file storage for file feedback
 *
 * Architecture:
 * ```
 * ExecutionNode → FeedbackRouter → Channels
 *                       ↓
 *              FileStorageService (for files)
 * ```
 */

import { createLogger } from '../utils/logger.js';
import type { IChannel, OutgoingMessage } from '../channels/index.js';
import type { FeedbackMessage } from '../types/websocket-messages.js';
import type { FileStorageService } from '../file-transfer/node-transfer/file-storage.js';

const logger = createLogger('FeedbackRouter');

/**
 * Configuration for FeedbackRouter.
 */
export interface FeedbackRouterConfig {
  /** File storage service for file handling */
  fileStorageService?: FileStorageService;
  /** Function to send file to user */
  sendFileToUser: (chatId: string, filePath: string, threadId?: string) => Promise<void>;
}

/**
 * FeedbackRouter - Routes execution feedback to channels.
 *
 * Handles:
 * - Text message routing
 * - Card message routing
 * - File handling with storage service
 * - Done/error signal broadcasting
 */
export class FeedbackRouter {
  private readonly fileStorageService?: FileStorageService;
  private readonly sendFileToUser: (chatId: string, filePath: string, threadId?: string) => Promise<void>;
  private readonly channels: Map<string, IChannel> = new Map();

  constructor(config: FeedbackRouterConfig) {
    this.fileStorageService = config.fileStorageService;
    this.sendFileToUser = config.sendFileToUser;
  }

  /**
   * Register a channel for broadcasting.
   */
  registerChannel(channel: IChannel): void {
    this.channels.set(channel.id, channel);
    logger.info({ channelId: channel.id }, 'Channel registered with FeedbackRouter');
  }

  /**
   * Unregister a channel.
   */
  unregisterChannel(channelId: string): void {
    this.channels.delete(channelId);
    logger.info({ channelId }, 'Channel unregistered from FeedbackRouter');
  }

  /**
   * Get all registered channels.
   */
  getChannels(): IChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Handle feedback from execution node.
   */
  async handleFeedback(message: FeedbackMessage): Promise<void> {
    const { chatId, type, text, card, error, threadId, fileRef } = message;

    try {
      switch (type) {
        case 'text':
          if (text) {
            await this.broadcastToChannels({
              chatId,
              type: 'text',
              text,
              threadId,
            });
          }
          break;
        case 'card':
          await this.broadcastToChannels({
            chatId,
            type: 'card',
            card,
            description: undefined,
            threadId,
          });
          break;
        case 'file':
          if (fileRef) {
            const localPath = this.fileStorageService?.getLocalPath(fileRef.id);
            if (localPath) {
              await this.sendFileToUser(chatId, localPath, threadId);
            } else {
              logger.error({ fileId: fileRef.id }, 'File not found in storage');
              await this.broadcastToChannels({
                chatId,
                type: 'text',
                text: `❌ 文件未找到: ${fileRef.fileName}`,
                threadId,
              });
            }
          }
          break;
        case 'done':
          logger.info({ chatId }, 'Execution completed');
          await this.broadcastToChannels({ type: 'done', chatId, threadId });
          break;
        case 'error':
          logger.error({ chatId, error }, 'Execution error');
          await this.broadcastToChannels({
            chatId,
            type: 'text',
            text: `❌ 执行错误: ${error || 'Unknown error'}`,
            threadId,
          });
          break;
      }
    } catch (err) {
      logger.error({ err, message }, 'Failed to handle feedback');
    }
  }

  /**
   * Send a text message to all channels.
   */
  async sendMessage(chatId: string, text: string, threadMessageId?: string): Promise<void> {
    await this.broadcastToChannels({
      chatId,
      type: 'text',
      text,
      threadId: threadMessageId,
    });
  }

  /**
   * Send a card to all channels.
   */
  async sendCard(
    chatId: string,
    card: Record<string, unknown>,
    _description?: string,
    threadMessageId?: string
  ): Promise<void> {
    await this.broadcastToChannels({
      chatId,
      type: 'card',
      card,
      description: _description,
      threadId: threadMessageId,
    });
  }

  /**
   * Broadcast a message to all registered channels.
   */
  private async broadcastToChannels(message: OutgoingMessage): Promise<void> {
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
   * Clear all registered channels.
   */
  clear(): void {
    this.channels.clear();
    logger.info('All channels cleared from FeedbackRouter');
  }
}
