/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../config/index.js';
import { DEDUPLICATION, REACTIONS } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { attachmentManager, downloadFile } from '../file-transfer/inbound/index.js';
import { messageLogger } from '../feishu/message-logger.js';
import { FeishuFileHandler } from '../platforms/feishu/feishu-file-handler.js';
import { FeishuMessageSender } from '../platforms/feishu/feishu-message-sender.js';
import { InteractionManager } from '../platforms/feishu/interaction-manager.js';
import { resolvePendingInteraction } from '../mcp/feishu-context-mcp.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { BaseChannel } from './base-channel.js';
import type {
  FeishuEventData,
  FeishuMessageEvent,
  FeishuCardActionEvent,
  FeishuCardActionEventData,
} from '../types/platform.js';
import type {
  ChannelConfig,
  OutgoingMessage,
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
export class FeishuChannel extends BaseChannel<FeishuChannelConfig> {
  private appId: string;
  private appSecret: string;
  private client?: lark.Client;
  private wsClient?: lark.WSClient;
  private eventDispatcher?: lark.EventDispatcher;
  private messageSender?: FeishuMessageSender;
  private fileHandler: FeishuFileHandler;
  private taskTracker: TaskTracker;
  private taskFlowOrchestrator?: TaskFlowOrchestrator;
  private interactionManager: InteractionManager;

  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  constructor(config: FeishuChannelConfig = {}) {
    super(config, 'feishu', 'Feishu');
    this.appId = config.appId || Config.FEISHU_APP_ID;
    this.appSecret = config.appSecret || Config.FEISHU_APP_SECRET;
    this.taskTracker = new TaskTracker();

    // Initialize FileHandler
    this.fileHandler = new FeishuFileHandler({
      attachmentManager,
      downloadFile: async (fileKey: string, messageType: string, fileName?: string, messageId?: string) => {
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
      },
    });

    // Initialize InteractionManager
    this.interactionManager = new InteractionManager();

    logger.info({ id: this.id }, 'FeishuChannel created');
  }

  protected async doStart(): Promise<void> {
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
      'im.message.action_v1': async (data: unknown) => {
        try {
          await this.handleCardAction(data as FeishuCardActionEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle card action');
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
    logger.info('FeishuChannel started');
  }

  protected doStop(): Promise<void> {
    this.wsClient = undefined;
    this.client = undefined;
    this.messageSender = undefined;

    // Dispose interaction manager
    this.interactionManager.dispose();

    // Clean up old attachments to prevent memory leaks
    attachmentManager.cleanupOldAttachments();

    logger.info('FeishuChannel stopped');
    return Promise.resolve();
  }

  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
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

  protected checkHealth(): boolean {
    return this.wsClient !== undefined;
  }

  /**
   * Get the TaskFlowOrchestrator for this channel.
   * Used by deep-task skill MCP tools.
   */
  getTaskFlowOrchestrator(): TaskFlowOrchestrator | undefined {
    return this.taskFlowOrchestrator;
  }

  /**
   * Initialize TaskFlowOrchestrator with callbacks.
   * Called by CommunicationNode after channel is created.
   * Starts the file watcher to detect new Task.md files.
   */
  async initTaskFlowOrchestrator(callbacks: {
    sendMessage: (chatId: string, text: string) => Promise<void>;
    sendCard: (chatId: string, card: Record<string, unknown>, description?: string) => Promise<void>;
    sendFile: (chatId: string, filePath: string) => Promise<void>;
  }): Promise<void> {
    this.taskFlowOrchestrator = new TaskFlowOrchestrator(
      this.taskTracker,
      callbacks,
      logger
    );
    // Start the file watcher
    await this.taskFlowOrchestrator.start();
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
      this.messageSender = new FeishuMessageSender({
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
   * Check if the bot is mentioned in the message.
   * When bot is mentioned, commands should be passed through to the agent.
   *
   * @param mentions - Mentions array from Feishu message
   * @returns true if bot is mentioned
   */
  private isBotMentioned(mentions?: FeishuMessageEvent['message']['mentions']): boolean {
    if (!mentions || mentions.length === 0) {
      return false;
    }
    // In Feishu, when bot is mentioned, it appears in the mentions array
    // The bot's id type is typically 'app' or has a specific pattern
    // We check if any mention has an id that looks like a bot/app
    return mentions.some((_mention) => {
      // Bot mentions typically have open_id starting with 'ou_' or 'on_'
      // but we should check all mentions since user might @bot
      // The safest approach: if there's any mention, treat it as bot mention
      // This ensures commands with @mentions are passed to agent
      return true;
    });
  }

  /**
   * Handle incoming message event from WebSocket.
   */
  private async handleMessageReceive(data: FeishuEventData): Promise<void> {
    if (!this.isRunning) {return;}

    this.getClient();

    const event = (data.event || data) as FeishuMessageEvent;
    const { message, sender } = event;

    if (!message) {return;}

    const { message_id, chat_id, content, message_type, create_time, mentions } = message;

    // Bot replies to user message by setting parent_id = message_id
    // Feishu automatically handles thread affiliation
    const threadId = message_id;

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

    // Check if this is a broadcast chat - skip processing user messages
    // @see Issue #453
    if (Config.isBroadcastChat(chat_id)) {
      logger.debug({ chatId: chat_id }, 'Skipped message from broadcast chat');
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
        await this.emitMessage({
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
    // Control commands should ALWAYS be handled through the control channel, regardless of mentions
    // This ensures /reset, /status, etc. work correctly even when bot is @mentioned
    const trimmedText = text.trim();
    const botMentioned = this.isBotMentioned(mentions);

    // Control commands that should always be handled locally through the control channel
    // These commands affect session/agent lifecycle and should not be passed to the agent
    const CONTROL_COMMANDS = ['reset', 'status', 'help', 'restart', 'list-nodes', 'switch-node'];

    if (trimmedText.startsWith('/')) {
      const [command, ...args] = trimmedText.slice(1).split(/\s+/);
      const cmd = command.toLowerCase();

      // Handle control commands through the control channel
      // Control commands are ALWAYS handled locally, regardless of @mentions
      // Non-control commands with @mention are passed to agent
      const isControlCommand = CONTROL_COMMANDS.includes(cmd);

      if (isControlCommand || !botMentioned) {
        if (this.controlHandler) {
          const response = await this.emitControl({
            type: cmd as any,
            chatId: chat_id,
            data: { args, rawText: trimmedText },
          });

          // Only return if command was successfully handled
          // Unknown commands (success: false) will fall through to normal message processing
          if (response.success) {
            if (response.message) {
              await this.sendMessage({
                chatId: chat_id,
                type: 'text',
                text: response.message,
              });
            }
            return;
          }
          // Unknown command: fall through to emitMessage for Agent to handle
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
            text: `📊 **状态**\n\nChannel: ${this.name}\nStatus: ${this.status}`,
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
    }

    // Log if bot is mentioned with a non-control command (for debugging)
    if (botMentioned && trimmedText.startsWith('/')) {
      logger.debug({ messageId: message_id, chatId: chat_id, command: trimmedText }, 'Bot mentioned with non-control command, passing to agent');
    }

    // Emit as incoming message
    await this.emitMessage({
      messageId: message_id,
      chatId: chat_id,
      userId: this.extractOpenId(sender),
      content: text,
      messageType: message_type as any,
      timestamp: create_time,
      threadId,
    });
  }

  /**
   * Handle card action event from WebSocket.
   * Triggered when user clicks button, selects menu, etc. on an interactive card.
   */
  private async handleCardAction(data: FeishuCardActionEventData): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    const event = (data.event || data) as FeishuCardActionEvent;
    const { action, message_id, chat_id, user } = event;

    if (!action || !message_id || !chat_id) {
      logger.warn('Missing required card action fields');
      return;
    }

    logger.info(
      {
        messageId: message_id,
        chatId: chat_id,
        actionType: action.type,
        actionValue: action.value,
        trigger: action.trigger,
        userId: user?.sender_id?.open_id,
      },
      'Card action received'
    );

    // First, try to resolve any pending wait_for_interaction calls
    const resolved = resolvePendingInteraction(
      message_id,
      action.value,
      action.type,
      user?.sender_id?.open_id || 'unknown'
    );

    if (resolved) {
      logger.debug({ messageId: message_id }, 'Card action resolved pending interaction');
      return;
    }

    try {
      // Try to handle via InteractionManager
      const handled = await this.interactionManager.handleAction(event, async (defaultEvent) => {
        // Default handler: emit as interaction message
        await this.emitMessage({
          messageId: `${defaultEvent.message_id}-${defaultEvent.action.value}`,
          chatId: defaultEvent.chat_id,
          userId: defaultEvent.user?.sender_id?.open_id,
          content: `[card_action] ${defaultEvent.action.value}`,
          messageType: 'card',
          timestamp: Date.now(),
          metadata: {
            cardAction: defaultEvent.action,
            cardMessageId: defaultEvent.message_id,
          },
        });
      });

      if (!handled) {
        logger.debug(
          { messageId: message_id, actionValue: action.value },
          'Card action not handled'
        );
      }
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Card action handler error');

      // Notify user of the error
      await this.sendMessage({
        chatId: chat_id,
        type: 'text',
        text: `❌ 处理卡片操作时发生错误：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }

  /**
   * Get the InteractionManager for this channel.
   * Used for registering custom interaction handlers.
   */
  getInteractionManager(): InteractionManager {
    return this.interactionManager;
  }
}
