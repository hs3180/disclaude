/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 *
 * Issue #694: Refactored to use modular components.
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  Config,
  createLogger,
  type FeishuEventData,
  type FeishuCardActionEventData,
  type FeishuChatMemberAddedEventData,
  type FeishuP2PChatEnteredEventData,
  type OutgoingMessage,
  type ChannelCapabilities,
  DEFAULT_CHANNEL_CAPABILITIES,
  attachmentManager,
} from '@disclaude/core';
import { BaseChannel } from '@disclaude/core';
import { InteractionManager, WelcomeService, createFeishuClient } from '../platforms/feishu/index.js';
import {
  PassiveModeManager,
  MentionDetector,
  WelcomeHandler,
  MessageHandler as FeishuMessageHandler,
  messageLogger,
  type MessageCallbacks,
} from './feishu/index.js';

const logger = createLogger('FeishuChannel');

/**
 * Feishu channel configuration.
 */
export interface FeishuChannelConfig {
  /** Channel ID (optional) */
  id?: string;
  /** Feishu App ID */
  appId?: string;
  /** Feishu App Secret */
  appSecret?: string;
  /**
   * Route card action to Worker Node if applicable.
   */
  routeCardAction?: (message: {
    chatId: string;
    cardMessageId: string;
    actionType: string;
    actionValue: string;
    actionText?: string;
    userId?: string;
    action?: {
      type: string;
      value: string;
      text?: string;
      trigger?: string;
    };
  }) => Promise<boolean>;
}

/**
 * Feishu Channel - Handles Feishu/Lark messaging via WebSocket.
 *
 * Features:
 * - WebSocket-based event receiving
 * - Message deduplication
 * - File/image handling
 * - Interactive card support
 * - Typing reactions
 */
export class FeishuChannel extends BaseChannel<FeishuChannelConfig> {
  private appId: string;
  private appSecret: string;
  private wsClient?: lark.WSClient;
  private client?: lark.Client;

  // Modular components
  private passiveModeManager: PassiveModeManager;
  private mentionDetector: MentionDetector;
  private welcomeHandler: WelcomeHandler;
  private feishuMessageHandler: FeishuMessageHandler;
  private interactionManager: InteractionManager;

  constructor(config: FeishuChannelConfig = {}) {
    super(config, 'feishu', 'Feishu');
    this.appId = config.appId || Config.FEISHU_APP_ID;
    this.appSecret = config.appSecret || Config.FEISHU_APP_SECRET;

    // Initialize modular components
    this.passiveModeManager = new PassiveModeManager();
    this.mentionDetector = new MentionDetector();
    this.interactionManager = new InteractionManager();
    this.welcomeHandler = new WelcomeHandler(this.appId, () => this.isRunning);

    // Create message callbacks
    const callbacks: MessageCallbacks = {
      emitMessage: async (message: Parameters<BaseChannel['emitMessage']>[0]) => {
        await this.emitMessage(message);
      },
      emitControl: async (control: Parameters<BaseChannel['emitControl']>[0]) => {
        if (this.controlHandler) {
          return await this.emitControl(control);
        }
        return { success: false };
      },
      sendMessage: async (message: { chatId: string; type: string; text?: string; card?: Record<string, unknown>; description?: string; threadId?: string; filePath?: string }) => {
        await this.sendMessage(message as OutgoingMessage);
      },
      routeCardAction: config.routeCardAction,
    };

    this.feishuMessageHandler = new FeishuMessageHandler({
      passiveModeManager: this.passiveModeManager,
      mentionDetector: this.mentionDetector,
      interactionManager: this.interactionManager,
      callbacks,
      isRunning: () => this.isRunning,
      hasControlHandler: () => !!this.controlHandler,
    });

    logger.info({ id: this.id }, 'FeishuChannel created');
  }

  protected async doStart(): Promise<void> {
    // Initialize message logger
    await messageLogger.init();

    // Create Feishu client
    this.client = createFeishuClient(this.appId, this.appSecret, {
      loggerLevel: lark.LoggerLevel.info,
    });

    // Set client on mention detector and fetch bot info
    this.mentionDetector.setClient(this.client);
    await this.mentionDetector.fetchBotInfo();

    // Initialize message handler
    this.feishuMessageHandler.initialize(this.client);

    // Create event dispatcher
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.feishuMessageHandler.handleMessageReceive(data as FeishuEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle message receive');
        }
      },
      'card.action.trigger': async (data: unknown) => {
        try {
          await this.feishuMessageHandler.handleCardAction(data as FeishuCardActionEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle card action');
        }
      },
      'im.message.message_read_v1': () => {
        // No action needed for read receipts
      },
      'im.chat.access_event.bot_p2p_chat_entered_v1': async (data: unknown) => {
        try {
          await this.welcomeHandler.handleP2PChatEntered(data as FeishuP2PChatEnteredEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle P2P chat entered');
        }
      },
      'im.chat.member.added_v1': async (data: unknown) => {
        try {
          await this.welcomeHandler.handleChatMemberAdded(data as FeishuChatMemberAddedEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle chat member added');
        }
      },
    });

    // Create WebSocket client
    const sdkLogger = {
      error: (...msg: unknown[]) => logger.error({ context: 'LarkSDK' }, String(msg)),
      warn: (...msg: unknown[]) => logger.warn({ context: 'LarkSDK' }, String(msg)),
      info: (...msg: unknown[]) => logger.info({ context: 'LarkSDK' }, String(msg)),
      debug: (...msg: unknown[]) => logger.debug({ context: 'LarkSDK' }, String(msg)),
      trace: (...msg: unknown[]) => logger.trace({ context: 'LarkSDK' }, String(msg)),
    };

    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      logger: sdkLogger,
      loggerLevel: lark.LoggerLevel.info,
    });

    await this.wsClient.start({ eventDispatcher });

    logger.info('FeishuChannel started');
  }

  protected doStop(): Promise<void> {
    this.wsClient = undefined;
    this.feishuMessageHandler.clearClient();

    // Dispose interaction manager
    this.interactionManager.dispose();

    // Clean up old attachments to prevent memory leaks
    attachmentManager.cleanupOldAttachments();

    logger.info('FeishuChannel stopped');
    return Promise.resolve();
  }

  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    switch (message.type) {
      case 'text': {
        const response = await this.client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: message.chatId,
            msg_type: 'text',
            content: JSON.stringify({ text: message.text || '' }),
          },
        });
        logger.debug({ chatId: message.chatId, messageId: response.data?.message_id }, 'Text message sent');
        break;
      }

      case 'card': {
        const response = await this.client.im.message.create({
          params: {
            receive_id_type: 'chat_id',
          },
          data: {
            receive_id: message.chatId,
            msg_type: 'interactive',
            content: JSON.stringify(message.card || {}),
          },
        });
        logger.debug({ chatId: message.chatId, messageId: response.data?.message_id }, 'Card message sent');
        break;
      }

      case 'file': {
        if (!message.filePath) {
          logger.error({ chatId: message.chatId }, 'File path missing in file message');
          throw new Error('File path is required for file messages');
        }

        const filePath = message.filePath;
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const fileStats = fs.statSync(filePath);
        const fileSize = fileStats.size;

        logger.info({ chatId: message.chatId, filePath, fileName, fileSize }, 'Uploading file');

        // Determine message type based on file extension
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];
        const isImage = imageExtensions.includes(ext);

        if (isImage) {
          // Upload image using im.image.create
          if (fileSize > 10 * 1024 * 1024) {
            throw new Error(`Image file too large: ${fileSize} bytes (max 10MB)`);
          }
          const uploadResp = await this.client.im.image.create({
            data: {
              image_type: 'message',
              image: fs.createReadStream(filePath),
            },
          });
          const imageKey = uploadResp?.image_key;
          if (!imageKey) {
            logger.error({ chatId: message.chatId, fileName }, 'Failed to upload image, no image_key returned');
            throw new Error(`Failed to upload image: ${fileName}`);
          }
          logger.info({ chatId: message.chatId, imageKey, fileName }, 'Image uploaded, sending message');

          // Send image message
          const response = await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: message.chatId,
              msg_type: 'image',
              content: JSON.stringify({ image_key: imageKey }),
            },
          });
          logger.info({ chatId: message.chatId, messageId: response.data?.message_id, fileName }, 'Image message sent');
        } else {
          // Upload file using im.file.create
          if (fileSize > 30 * 1024 * 1024) {
            throw new Error(`File too large: ${fileSize} bytes (max 30MB)`);
          }

          // Map file extension to Feishu file_type
          const extToType: Record<string, 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
            '.opus': 'opus',
            '.mp4': 'mp4',
            '.pdf': 'pdf',
            '.doc': 'doc', '.docx': 'doc',
            '.xls': 'xls', '.xlsx': 'xls', '.csv': 'xls',
            '.ppt': 'ppt', '.pptx': 'ppt',
          };
          const fileType = extToType[ext] || 'stream';

          const uploadResp = await this.client.im.file.create({
            data: {
              file_type: fileType,
              file_name: fileName,
              file: fs.createReadStream(filePath),
            },
          });
          const fileKey = uploadResp?.file_key;
          if (!fileKey) {
            logger.error({ chatId: message.chatId, fileName }, 'Failed to upload file, no file_key returned');
            throw new Error(`Failed to upload file: ${fileName}`);
          }
          logger.info({ chatId: message.chatId, fileKey, fileName, fileType }, 'File uploaded, sending message');

          // Send file message
          const response = await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: message.chatId,
              msg_type: 'file',
              content: JSON.stringify({ file_key: fileKey }),
            },
          });
          logger.info({ chatId: message.chatId, messageId: response.data?.message_id, fileName }, 'File message sent');
        }
        break;
      }

      case 'done':
        logger.debug({ chatId: message.chatId }, 'Task completed (done signal)');
        break;

      default:
        throw new Error(`Unsupported message type: ${(message as { type: string }).type}`);
    }
  }

  protected checkHealth(): boolean {
    return this.wsClient !== undefined;
  }

  /**
   * Get the capabilities of Feishu channel.
   */
  getCapabilities(): ChannelCapabilities {
    return {
      ...DEFAULT_CHANNEL_CAPABILITIES,
      supportsCard: true,
      supportsThread: true,
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: true,
      supportedMcpTools: [
        'send_text',
        'send_card',
        'send_interactive',
        'send_file',
      ],
    };
  }

  // Delegate passive mode methods to PassiveModeManager
  isPassiveModeDisabled(chatId: string): boolean {
    return this.passiveModeManager.isPassiveModeDisabled(chatId);
  }

  setPassiveModeDisabled(chatId: string, disabled: boolean): void {
    this.passiveModeManager.setPassiveModeDisabled(chatId, disabled);
  }

  getPassiveModeDisabledChats(): string[] {
    return this.passiveModeManager.getPassiveModeDisabledChats();
  }

  /**
   * Get the InteractionManager for this channel.
   */
  getInteractionManager(): InteractionManager {
    return this.interactionManager;
  }

  /**
   * Set the WelcomeService for this channel.
   */
  setWelcomeService(service: WelcomeService): void {
    this.welcomeHandler.setWelcomeService(service);
  }

  /**
   * Handle incoming message event (for testing purposes).
   * @internal
   */
  handleMessageReceive(data: FeishuEventData): Promise<void> {
    return this.feishuMessageHandler.handleMessageReceive(data);
  }

  /**
   * Get bot info for IPC handlers.
   * Returns bot's open_id and app_id.
   */
  getBotInfo(): { openId: string; name?: string; avatarUrl?: string } {
    const botInfo = this.mentionDetector.getBotInfo();
    return {
      openId: botInfo?.open_id || '',
      name: 'Bot',
    };
  }
}
