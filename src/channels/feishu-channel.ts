/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { EventEmitter } from 'events';
import { Config } from '../config/index.js';
import { DEDUPLICATION, REACTIONS } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { attachmentManager } from '../feishu/attachment-manager.js';
import { downloadFile } from '../feishu/file-downloader.js';
import { messageLogger } from '../feishu/message-logger.js';
import { FileHandler } from '../feishu/file-handler.js';
import { MessageSender } from '../feishu/message-sender.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { setTaskFlowOrchestrator } from '../mcp/task-skill-mcp.js';
import { TaskTracker } from '../utils/task-tracker.js';
import type { FeishuEventData, FeishuMessageEvent } from '../types/platform.js';
import type {
  IChannel,
  ChannelConfig,
  ChannelStatus,
  OutgoingMessage,
  MessageHandler,
  ControlHandler,
} from './types.js';

const logger = createLogger('FeishuChannel');

/**
 * Feishu channel configuration.
 */
export interface FeishuChannelConfig extends ChannelConfig {
  /** Feishu App ID */
  appId?: string;
  /** Feishu App Secret */
  appSecret?: string;
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
export class FeishuChannel extends EventEmitter implements IChannel {
  readonly id: string;
  readonly name: string = 'Feishu';

  private appId: string;
  private appSecret: string;
  private client?: lark.Client;
  private wsClient?: lark.WSClient;
  private eventDispatcher?: lark.EventDispatcher;
  private messageSender?: MessageSender;
  private fileHandler: FileHandler;
  private taskTracker: TaskTracker;
  private taskFlowOrchestrator?: TaskFlowOrchestrator;

  private _status: ChannelStatus = 'stopped';
  private messageHandler?: MessageHandler;
  private controlHandler?: ControlHandler;

  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  constructor(config: FeishuChannelConfig = {}) {
    super();
    this.id = config.id || 'feishu';
    this.appId = config.appId || Config.FEISHU_APP_ID;
    this.appSecret = config.appSecret || Config.FEISHU_APP_SECRET;
    this.taskTracker = new TaskTracker();

    // Initialize FileHandler
    this.fileHandler = new FileHandler(
      attachmentManager,
      async (fileKey: string, messageType: string, fileName?: string, messageId?: string) => {
        if (!this.client) {
          logger.error({ fileKey }, 'Client not initialized for file download');
          return { success: false };
        }
        try {
          const filePath = await downloadFile(this.client, fileKey, messageType, fileName, messageId);
          return { success: true, filePath };
        } catch (error) {
          logger.error({ err: error, fileKey, messageType }, 'File download failed');
          return { success: false };
        }
      }
    );

    logger.info({ id: this.id }, 'FeishuChannel created');
  }

  get status(): ChannelStatus {
    return this._status;
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onControl(handler: ControlHandler): void {
    this.controlHandler = handler;
  }

  async sendMessage(message: OutgoingMessage): Promise<void> {
    if (!this.messageSender) {
      this.getClient();
    }

    const sender = this.messageSender;
    if (!sender) {
      throw new Error('MessageSender not initialized');
    }

    switch (message.type) {
      case 'text':
        await sender.sendText(message.chatId, message.text || '', message.threadId);
        break;
      case 'card':
        await sender.sendCard(
          message.chatId,
          message.card || {},
          message.description,
          message.threadId
        );
        break;
      case 'file':
        // TODO: Pass threadId when Issue #68 is implemented
        await sender.sendFile(message.chatId, message.filePath || '');
        break;
      case 'done':
        // Task completion signal, no actual message to send
        // This is used for REST sync mode and internal signaling
        logger.debug({ chatId: message.chatId }, 'Task completed (done signal)');
        break;
      default:
        throw new Error(`Unsupported message type: ${(message as { type: string }).type}`);
    }
  }

  async start(): Promise<void> {
    if (this._status === 'running') {
      logger.warn('FeishuChannel already running');
      return;
    }

    this._status = 'starting';

    // Initialize message logger
    await messageLogger.init();

    // Create event dispatcher
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.handleMessageReceive(data as FeishuEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle message receive');
        }
      },
      'im.message.message_read_v1': async () => {},
      'im.chat.access_event.bot_p2p_chat_entered_v1': async () => {},
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

    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });

    this._status = 'running';
    logger.info('FeishuChannel started');
  }

  async stop(): Promise<void> {
    if (this._status === 'stopped') {
      return;
    }

    this._status = 'stopping';

    this.wsClient = undefined;
    this.client = undefined;
    this.messageSender = undefined;

    this._status = 'stopped';
    logger.info('FeishuChannel stopped');
  }

  isHealthy(): boolean {
    return this._status === 'running' && this.wsClient !== undefined;
  }

  /**
   * Get the TaskFlowOrchestrator for this channel.
   * Used by task skill MCP tools.
   */
  getTaskFlowOrchestrator(): TaskFlowOrchestrator | undefined {
    return this.taskFlowOrchestrator;
  }

  /**
   * Initialize TaskFlowOrchestrator with callbacks.
   * Called by CommunicationNode after channel is created.
   */
  initTaskFlowOrchestrator(callbacks: {
    sendMessage: (chatId: string, text: string) => Promise<void>;
    sendCard: (chatId: string, card: Record<string, unknown>, description?: string) => Promise<void>;
    sendFile: (chatId: string, filePath: string) => Promise<void>;
  }): void {
    this.taskFlowOrchestrator = new TaskFlowOrchestrator(
      this.taskTracker,
      callbacks,
      logger
    );
    setTaskFlowOrchestrator(this.taskFlowOrchestrator);
  }

  /**
   * Get or create Lark HTTP client.
   */
  private getClient(): lark.Client {
    if (!this.client) {
      this.client = new lark.Client({
        appId: this.appId,
        appSecret: this.appSecret,
      });
      this.messageSender = new MessageSender({
        client: this.client,
        logger,
      });
    }
    return this.client;
  }

  /**
   * Extract open_id from sender object.
   */
  private extractOpenId(sender?: { sender_type?: string; sender_id?: unknown }): string | undefined {
    if (!sender?.sender_id) {
      return undefined;
    }
    if (typeof sender.sender_id === 'object' && sender.sender_id !== null) {
      const senderId = sender.sender_id as { open_id?: string };
      return senderId.open_id;
    }
    if (typeof sender.sender_id === 'string') {
      return sender.sender_id;
    }
    return undefined;
  }

  /**
   * Add typing reaction to indicate processing started.
   */
  private async addTypingReaction(messageId: string): Promise<void> {
    if (this.messageSender) {
      await this.messageSender.addReaction(messageId, REACTIONS.TYPING);
    }
  }

  /**
   * Handle incoming message event from WebSocket.
   */
  private async handleMessageReceive(data: FeishuEventData): Promise<void> {
    if (this._status !== 'running') return;

    this.getClient();

    const event = (data.event || data) as FeishuMessageEvent;
    const { message, sender } = event;

    if (!message) return;

    const { message_id, chat_id, content, message_type, create_time, parent_id, root_id } = message;

    // Use root_id for thread replies (this ensures all replies go to the same thread)
    // root_id is the thread root message ID, parent_id is the direct parent
    const threadId = root_id || parent_id;

    if (!message_id || !chat_id || !content || !message_type) {
      logger.warn('Missing required message fields');
      return;
    }

    // Deduplication
    if (messageLogger.isMessageProcessed(message_id)) {
      logger.debug({ messageId: message_id }, 'Skipped duplicate message');
      return;
    }

    // Ignore bot messages
    if (sender?.sender_type === 'app') {
      logger.debug('Skipped bot message');
      return;
    }

    // Check message age
    if (create_time) {
      const messageAge = Date.now() - create_time;
      if (messageAge > this.MAX_MESSAGE_AGE) {
        logger.debug({ messageId: message_id }, 'Skipped old message');
        return;
      }
    }

    // Add typing reaction
    await this.addTypingReaction(message_id);

    // Handle file/image messages
    if (message_type === 'image' || message_type === 'file' || message_type === 'media') {
      const result = await this.fileHandler.handleFileMessage(chat_id, message_type, content, message_id);
      if (!result.success) {
        await this.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: `❌ 处理${message_type === 'image' ? '图片' : '文件'}失败`,
        });
        return;
      }

      const attachments = attachmentManager.getAttachments(chat_id);
      if (attachments.length > 0) {
        const latestAttachment = attachments[attachments.length - 1];
        const uploadPrompt = this.fileHandler.buildUploadPrompt(latestAttachment);

        await messageLogger.logIncomingMessage(
          message_id,
          this.extractOpenId(sender) || 'unknown',
          chat_id,
          `[File uploaded: ${latestAttachment.fileName}]`,
          message_type,
          create_time
        );

        // Emit as incoming message
        if (this.messageHandler) {
          await this.messageHandler({
            messageId: `${message_id}-file`,
            chatId: chat_id,
            userId: this.extractOpenId(sender),
            content: uploadPrompt,
            messageType: 'file',
            timestamp: create_time,
            threadId,
            attachments: [{
              fileName: latestAttachment.fileName || 'unknown',
              filePath: latestAttachment.localPath || '',
              mimeType: latestAttachment.mimeType,
            }],
          });
        }
      }
      return;
    }

    // Handle text and post messages
    if (message_type !== 'text' && message_type !== 'post') {
      logger.debug({ messageType: message_type }, 'Skipped unsupported message type');
      return;
    }

    // Parse content
    let text = '';
    try {
      const parsed = JSON.parse(content);
      if (message_type === 'text') {
        text = parsed.text?.trim() || '';
      } else if (message_type === 'post' && parsed.content && Array.isArray(parsed.content)) {
        for (const row of parsed.content) {
          if (Array.isArray(row)) {
            for (const segment of row) {
              if (segment?.tag === 'text' && segment.text) {
                text += segment.text;
              }
            }
          }
        }
        text = text.trim();
      }
    } catch {
      logger.error('Failed to parse content');
      return;
    }

    if (!text) {
      logger.debug('Skipped empty text');
      return;
    }

    logger.info({ messageId: message_id, chatId: chat_id }, 'Message received');

    // Log message
    await messageLogger.logIncomingMessage(
      message_id,
      this.extractOpenId(sender) || 'unknown',
      chat_id,
      text,
      message_type,
      create_time
    );

    // Check for control commands
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/')) {
      const [command, ...args] = trimmedText.slice(1).split(/\s+/);
      const cmd = command.toLowerCase();

      if (this.controlHandler) {
        const response = await this.controlHandler({
          type: cmd as any,
          chatId: chat_id,
          data: { args, rawText: trimmedText },
        });

        if (response.message) {
          await this.sendMessage({
            chatId: chat_id,
            type: 'text',
            text: response.message,
          });
        }
        return;
      }

      // Default command handling if no control handler registered
      if (cmd === 'reset') {
        await this.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。',
        });
        return;
      }

      if (cmd === 'status') {
        await this.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: `📊 **状态**\n\nChannel: ${this.name}\nStatus: ${this._status}`,
        });
        return;
      }

      if (cmd === 'help') {
        await this.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: '📖 **帮助**\n\n可用命令:\n- /reset - 重置对话\n- /status - 查看状态\n- /help - 显示帮助',
        });
        return;
      }
    }

    // Emit as incoming message
    if (this.messageHandler) {
      await this.messageHandler({
        messageId: message_id,
        chatId: chat_id,
        userId: this.extractOpenId(sender),
        content: text,
        messageType: message_type as any,
        timestamp: create_time,
        threadId,
      });
    }
  }
}
