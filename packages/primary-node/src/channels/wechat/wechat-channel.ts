/**
 * WeChat Channel Implementation.
 *
 * Handles WeChat messaging platform integration via ilink API.
 * Implements the IChannel interface for unified message handling.
 *
 * Based on openclaw-weixin extension.
 *
 * @module channels/wechat/wechat-channel
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createLogger,
  BaseChannel,
  type IncomingMessage,
  type OutgoingMessage,
  type ChannelCapabilities,
  DEFAULT_CHANNEL_CAPABILITIES,
} from '@disclaude/core';
import { WeChatApiClient } from './api-client.js';
import { WeChatAuthHandler } from './auth.js';
import { WeChatMonitor } from './monitor.js';
import type {
  WeChatChannelConfig,
  WeChatIncomingMessage,
  OutgoingTextPayload,
  OutgoingImagePayload,
  OutgoingFilePayload,
} from './types.js';

// Re-export config type for external use
export type { WeChatChannelConfig } from './types.js';

const logger = createLogger('WeChatChannel');

/**
 * WeChat Channel - Handles WeChat messaging via ilink API.
 *
 * Features:
 * - QR code login flow
 * - Long polling for incoming messages
 * - Message sending (text, image, file)
 * - Automatic reconnection
 * - Message deduplication
 */
export class WeChatChannel extends BaseChannel<WeChatChannelConfig> {
  private readonly apiClient: WeChatApiClient;
  private authHandler: WeChatAuthHandler;
  private monitor: WeChatMonitor;

  constructor(config: WeChatChannelConfig) {
    super(config, 'wechat', 'WeChat');

    // Initialize API client
    this.apiClient = new WeChatApiClient(config);

    // Initialize auth handler
    this.authHandler = new WeChatAuthHandler(this.apiClient);
    this.authHandler.onStateChange((state, _token, botId) => {
      logger.info({ state, botId }, 'Auth state changed');
      if (state === 'error') {
        this.setStatus('error');
      }
    });

    // Initialize message monitor
    this.monitor = new WeChatMonitor(this.apiClient, config.pollingTimeout);
    this.monitor.onMessage((msg) => this.handleIncomingMessage(msg));
    this.monitor.onError((err) => {
      logger.error({ err }, 'Monitor error');
    });

    logger.info({ id: this.id }, 'WeChatChannel created');
  }

  protected async doStart(): Promise<void> {
    logger.info('Starting WeChatChannel');

    // Check if already authenticated (token provided in config)
    if (this.apiClient.isAuthenticated()) {
      logger.info('Using provided authentication token');
      // Start message monitor
      this.monitor.start();
      logger.info('WeChatChannel started');
      return;
    }

    // Need to authenticate via QR code
    logger.info('No authentication token, starting QR login flow');

    // Set up QR code callback to log the URL
    this.authHandler.onQRCode((qrCodeUrl) => {
      logger.info({ qrCodeUrl }, 'Please scan QR code to login');
      // Emit event for external handling
      this.emit('qrcode', qrCodeUrl);
    });

    // Wait for authentication
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Authentication timeout'));
      }, 5 * 60 * 1000); // 5 minutes

      this.authHandler.onStateChange((state, _token, _botId) => {
        if (state === 'authenticated') {
          clearTimeout(timeout);
          resolve();
        } else if (state === 'error') {
          clearTimeout(timeout);
          reject(new Error('Authentication failed'));
        }
      });

      // Start login flow
      void this.authHandler.startLogin();
    });

    // Start message monitor
    this.monitor.start();
    logger.info('WeChatChannel started');
  }

  protected async doStop(): Promise<void> {
    logger.info('Stopping WeChatChannel');

    // Stop message monitor
    await this.monitor.stop();

    // Dispose auth handler
    this.authHandler.dispose();

    logger.info('WeChatChannel stopped');
  }

  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
    switch (message.type) {
      case 'text': {
        await this.sendTextMessage(message.chatId, message.text || '');
        break;
      }

      case 'file': {
        if (!message.filePath) {
          throw new Error('File path is required for file messages');
        }
        await this.sendFileMessage(message.chatId, message.filePath);
        break;
      }

      case 'card': {
        // WeChat doesn't support interactive cards, convert to text
        const text = this.cardToText(message.card);
        await this.sendTextMessage(message.chatId, text);
        logger.warn('Card message converted to text (WeChat does not support cards)');
        break;
      }

      case 'done': {
        logger.debug({ chatId: message.chatId }, 'Task completed (done signal)');
        break;
      }

      default:
        throw new Error(`Unsupported message type: ${(message as { type: string }).type}`);
    }
  }

  protected checkHealth(): boolean {
    return this.apiClient.isAuthenticated() && this.monitor.isRunning();
  }

  /**
   * Get the capabilities of WeChat channel.
   */
  getCapabilities(): ChannelCapabilities {
    return {
      ...DEFAULT_CHANNEL_CAPABILITIES,
      supportsCard: false, // WeChat doesn't support complex cards
      supportsThread: false, // No native thread support
      supportsFile: true, // Supports file attachments
      supportsMarkdown: false, // Doesn't support markdown
      supportsMention: true, // Supports @mentions
      supportsUpdate: false, // Doesn't support message updates
      supportedMcpTools: [
        'mcp__channel-mcp__send_text',
        'mcp__channel-mcp__send_file',
        'mcp__channel-mcp__send_card', // Converted to text
      ],
    };
  }

  /**
   * Handle incoming message from monitor.
   */
  private async handleIncomingMessage(msg: WeChatIncomingMessage): Promise<void> {
    logger.debug({ msgId: msg.msg_id, type: msg.msg_type }, 'Handling incoming message');

    // Convert to unified IncomingMessage format
    const incoming: IncomingMessage = {
      messageId: msg.msg_id,
      chatId: msg.chat_id,
      userId: msg.from_user,
      content: this.extractContent(msg),
      messageType: this.mapMessageType(msg.msg_type),
      timestamp: msg.timestamp * 1000, // Convert to ms
      metadata: {
        isGroup: msg.is_group,
        groupId: msg.group_id,
        atUserList: msg.at_user_list,
      },
    };

    // Emit to message handler
    await this.emitMessage(incoming);
  }

  /**
   * Extract text content from WeChat message.
   */
  private extractContent(msg: WeChatIncomingMessage): string {
    const content = msg.content;

    switch (msg.msg_type) {
      case 'text':
        return (content as { text: string }).text;

      case 'image':
        return '[图片]';

      case 'file': {
        const file = content as { file_name: string };
        return `[文件] ${file.file_name}`;
      }

      case 'video':
        return '[视频]';

      case 'audio':
        return '[语音]';

      case 'link': {
        const link = content as { title: string; url: string };
        return `[链接] ${link.title}: ${link.url}`;
      }

      case 'location': {
        const location = content as { label?: string; latitude: number; longitude: number };
        return location.label ? `[位置] ${location.label}` : '[位置]';
      }

      case 'emoji':
        return '[表情]';

      default:
        return '[未知消息类型]';
    }
  }

  /**
   * Map WeChat message type to unified type.
   */
  private mapMessageType(type: string): IncomingMessage['messageType'] {
    switch (type) {
      case 'text':
        return 'text';
      case 'image':
        return 'image';
      case 'file':
        return 'file';
      case 'video':
      case 'audio':
        return 'media';
      default:
        return 'text';
    }
  }

  /**
   * Send text message.
   */
  private async sendTextMessage(chatId: string, text: string): Promise<void> {
    const payload: OutgoingTextPayload = {
      msgtype: 'text',
      text: { content: text },
    };

    const response = await this.apiClient.sendMessage(chatId, payload);

    if (!response.success) {
      throw new Error(`Failed to send text message: ${response.error.errmsg}`);
    }

    logger.debug({ chatId, msgId: response.data.msg_id }, 'Text message sent');
  }

  /**
   * Send file message (image or file).
   */
  private async sendFileMessage(chatId: string, filePath: string): Promise<void> {
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const { size: fileSize } = fs.statSync(filePath);

    // Check if it's an image
    const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const isImage = imageExtensions.includes(ext);

    // Get upload URL
    const uploadResponse = await this.apiClient.getUploadUrl(fileName, fileSize);

    if (!uploadResponse.success) {
      throw new Error(`Failed to get upload URL: ${uploadResponse.error.errmsg}`);
    }

    const { upload_url, file_id } = uploadResponse.data;

    // Upload file
    const fileBuffer = fs.readFileSync(filePath);
    const uploaded = await this.apiClient.uploadFile(upload_url, fileBuffer, fileName);

    if (!uploaded) {
      throw new Error('Failed to upload file');
    }

    // Send message with file
    if (isImage) {
      const payload: OutgoingImagePayload = {
        msgtype: 'image',
        image: { file_id },
      };

      const response = await this.apiClient.sendMessage(chatId, payload);

      if (!response.success) {
        throw new Error(`Failed to send image: ${response.error.errmsg}`);
      }

      logger.info({ chatId, msgId: response.data.msg_id, fileName }, 'Image message sent');
    } else {
      const payload: OutgoingFilePayload = {
        msgtype: 'file',
        file: { file_id, file_name: fileName },
      };

      const response = await this.apiClient.sendMessage(chatId, payload);

      if (!response.success) {
        throw new Error(`Failed to send file: ${response.error.errmsg}`);
      }

      logger.info({ chatId, msgId: response.data.msg_id, fileName }, 'File message sent');
    }
  }

  /**
   * Convert card to text representation.
   * WeChat doesn't support interactive cards, so we extract the text content.
   */
  private cardToText(card: Record<string, unknown> | undefined): string {
    if (!card) {
      return '';
    }

    // Try to extract text from common card structures
    const elements = (card.elements as Array<unknown>) || [];
    const texts: string[] = [];

    for (const element of elements) {
      const el = element as Record<string, unknown>;
      if (el.tag === 'markdown' && typeof el.content === 'string') {
        texts.push(el.content);
      } else if (el.tag === 'plain_text' && typeof el.content === 'string') {
        texts.push(el.content);
      } else if (typeof el.text === 'string') {
        texts.push(el.text);
      }
    }

    // Also check header
    const header = card.header as Record<string, unknown> | undefined;
    if (header?.title) {
      const title = header.title as Record<string, unknown>;
      if (typeof title.content === 'string') {
        texts.unshift(title.content);
      }
    }

    return texts.join('\n') || '[卡片消息]';
  }
}
