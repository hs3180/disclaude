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
import { createFeishuClient } from '../platforms/feishu/create-feishu-client.js';
import type { WelcomeService } from '../platforms/feishu/welcome-service.js';
import { getCommandRegistry } from '../nodes/commands/command-registry.js';
import { resolvePendingInteraction } from '../mcp/feishu-context-mcp.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { filteredMessageForwarder } from '../feishu/filtered-message-forwarder.js';
import type { FilterReason } from '../config/types.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { stripLeadingMentions } from '../utils/mention-parser.js';
import { BaseChannel } from './base-channel.js';
import {
  PassiveModeManager,
  MentionDetector,
  WelcomeHandler,
  isGroupChat,
  parseTextContent,
  getChatHistoryContext,
  parseMessageEvent,
} from './feishu/index.js';
import type {
  FeishuEventData,
  FeishuMessageEvent,
  FeishuCardActionEvent,
  FeishuCardActionEventData,
  FeishuChatMemberAddedEventData,
  FeishuP2PChatEnteredEventData,
} from '../types/platform.js';
import type {
  OutgoingMessage,
  ChannelCapabilities,
} from './types.js';
import type { FeishuChannelConfig } from './feishu/types.js';

const logger = createLogger('FeishuChannel');

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
  private welcomeService?: WelcomeService;

  // Modular components
  private passiveModeManager: PassiveModeManager;
  private mentionDetector: MentionDetector;
  private welcomeHandler: WelcomeHandler;

  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  constructor(config: FeishuChannelConfig = {}) {
    super(config, 'feishu', 'Feishu');
    this.appId = config.appId || Config.FEISHU_APP_ID;
    this.appSecret = config.appSecret || Config.FEISHU_APP_SECRET;
    this.taskTracker = new TaskTracker();

    // Initialize modular components
    this.passiveModeManager = new PassiveModeManager();
    this.mentionDetector = new MentionDetector(this.appId, this.appSecret);
    this.welcomeHandler = new WelcomeHandler(this.appId, () => this.isRunning);

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

    // Get bot info for mention detection (Issue #600, #681)
    await this.mentionDetector.fetchBotInfo(this.getClient());

    // Create event dispatcher
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.handleMessageReceive(data as FeishuEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle message receive');
        }
      },
      'card.action.trigger': async (data: unknown) => {
        try {
          await this.handleCardAction(data as FeishuCardActionEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle card action');
        }
      },
      'im.message.message_read_v1': async () => {},
      // Issue #463: Handle P2P chat entered for welcome message
      'im.chat.access_event.bot_p2p_chat_entered_v1': async (data: unknown) => {
        try {
          await this.welcomeHandler.handleP2PChatEntered(
            data as FeishuP2PChatEnteredEventData,
            this.welcomeService
          );
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle P2P chat entered');
        }
      },
      // Issue #463: Handle bot added to group for welcome message
      'im.chat.member.added_v1': async (data: unknown) => {
        try {
          await this.welcomeHandler.handleChatMemberAdded(
            data as FeishuChatMemberAddedEventData,
            this.welcomeService
          );
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
   * Get the capabilities of Feishu channel.
   * Feishu supports cards, threads, files, markdown, mentions, and updates.
   * Issue #590 Phase 3: Added supportedMcpTools for dynamic prompt adaptation.
   */
  getCapabilities(): ChannelCapabilities {
    return {
      supportsCard: true,
      supportsThread: true,
      supportsFile: true,
      supportsMarkdown: true,
      supportsMention: true,
      supportsUpdate: true,
      supportedMcpTools: [
        'send_user_feedback',
        'send_file_to_feishu',
        'update_card',
        'wait_for_interaction',
      ],
    };
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
   * Called by PrimaryNode after channel is created.
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

  // ============================================================
  // Public API methods (for backward compatibility)
  // ============================================================

  /**
   * Check if passive mode is disabled for a specific chat.
   * @deprecated Use passiveModeManager.isDisabled() internally
   */
  isPassiveModeDisabled(chatId: string): boolean {
    return this.passiveModeManager.isDisabled(chatId);
  }

  /**
   * Set passive mode state for a specific chat.
   * @deprecated Use passiveModeManager.setDisabled() internally
   */
  setPassiveModeDisabled(chatId: string, disabled: boolean): void {
    this.passiveModeManager.setDisabled(chatId, disabled);
  }

  /**
   * Get all chats with passive mode disabled.
   * @deprecated Use passiveModeManager.getDisabledChats() internally
   */
  getPassiveModeDisabledChats(): string[] {
    return this.passiveModeManager.getDisabledChats();
  }

  /**
   * Get the InteractionManager for this channel.
   * Used for registering custom interaction handlers.
   */
  getInteractionManager(): InteractionManager {
    return this.interactionManager;
  }

  /**
   * Set the WelcomeService for this channel.
   * Used for sending welcome messages on bot added to group or first private chat.
   */
  setWelcomeService(service: WelcomeService): void {
    this.welcomeService = service;
  }

  // ============================================================
  // Private methods
  // ============================================================

  /**
   * Get or create Lark HTTP client with timeout configuration.
   */
  private getClient(): lark.Client {
    if (!this.client) {
      this.client = createFeishuClient(this.appId, this.appSecret);
      this.messageSender = new FeishuMessageSender({
        client: this.client,
        logger,
      });
      // Initialize filtered message forwarder (Issue #597)
      filteredMessageForwarder.setMessageSender({
        sendText: async (chatId: string, text: string) => {
          await this.messageSender!.sendText(chatId, text);
        },
      });
    }
    return this.client;
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
   * Forward a filtered message to the debug chat.
   * @see Issue #597
   */
  private async forwardFilteredMessage(
    reason: FilterReason,
    messageId: string,
    chatId: string,
    content: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await filteredMessageForwarder.forward({
      messageId,
      chatId,
      userId,
      content,
      reason,
      metadata,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle incoming message event from WebSocket.
   */
  private async handleMessageReceive(data: FeishuEventData): Promise<void> {
    if (!this.isRunning) {return;}

    this.getClient();

    const event = (data.event || data) as FeishuMessageEvent;
    const parsed = parseMessageEvent(event);

    if (!parsed) {
      return;
    }

    const { messageId, chatId, chatType, content, messageType, createTime, threadId, mentions, userId } = parsed;

    // Deduplication
    if (messageLogger.isMessageProcessed(messageId)) {
      logger.debug({ messageId }, 'Skipped duplicate message');
      await this.forwardFilteredMessage('duplicate', messageId, chatId, content, userId);
      return;
    }

    // Ignore bot messages
    const sender = event.sender;
    if (sender?.sender_type === 'app') {
      logger.debug('Skipped bot message');
      await this.forwardFilteredMessage('bot', messageId, chatId, content);
      return;
    }

    // Check message age
    if (createTime) {
      const messageAge = Date.now() - createTime;
      if (messageAge > this.MAX_MESSAGE_AGE) {
        logger.debug({ messageId }, 'Skipped old message');
        await this.forwardFilteredMessage('old', messageId, chatId, content, userId, { age: messageAge });
        return;
      }
    }

    // Handle file/image messages
    if (messageType === 'image' || messageType === 'file' || messageType === 'media') {
      await this.handleFileMessage(messageId, chatId, messageType, content, threadId, createTime, userId);
      return;
    }

    // Handle text and post messages
    if (messageType !== 'text' && messageType !== 'post') {
      logger.debug({ messageType }, 'Skipped unsupported message type');
      await this.forwardFilteredMessage('unsupported', messageId, chatId, content, userId, { messageType });
      return;
    }

    // Parse content
    const text = parseTextContent(content, messageType);
    if (!text) {
      logger.debug('Skipped empty text');
      await this.forwardFilteredMessage('empty', messageId, chatId, content, userId);
      return;
    }

    logger.info({ messageId, chatId }, 'Message received');

    // Log message
    await messageLogger.logIncomingMessage(
      messageId,
      userId || 'unknown',
      chatId,
      text,
      messageType,
      createTime
    );

    // Check for control commands and passive mode
    const botMentioned = this.mentionDetector.isBotMentioned(mentions);
    const commandRegistry = getCommandRegistry();
    const textWithoutMentions = stripLeadingMentions(text, mentions);

    // Issue #460 & #511: Group chat passive mode
    const isPassiveCommand = textWithoutMentions.startsWith('/passive');
    const passiveModeDisabled = this.passiveModeManager.isDisabled(chatId);
    if (isGroupChat(chatType) && !botMentioned && !passiveModeDisabled && !isPassiveCommand) {
      logger.debug({ messageId, chatId, chatType }, 'Skipped group chat message without @mention (passive mode)');
      await this.forwardFilteredMessage('passive_mode', messageId, chatId, text, userId, { chatType });
      return;
    }

    // Handle commands
    if (textWithoutMentions.startsWith('/')) {
      const handled = await this.handleCommand(textWithoutMentions, chatId, botMentioned, commandRegistry, userId);
      if (handled) {
        return;
      }
    }

    // Log if bot is mentioned with a non-control command (for debugging)
    if (botMentioned && textWithoutMentions.startsWith('/')) {
      logger.debug({ messageId, chatId, command: textWithoutMentions }, 'Bot mentioned with non-control command, passing to agent');
    }

    // Issue #514: Add typing reaction only for messages that will be processed
    await this.addTypingReaction(messageId);

    // Issue #517: Get chat history for passive mode context
    let chatHistoryContext: string | undefined;
    if (isGroupChat(chatType) && botMentioned) {
      chatHistoryContext = await getChatHistoryContext(chatId);
      logger.debug({ messageId, chatId, historyLength: chatHistoryContext?.length }, 'Including chat history context for passive mode trigger');
    }

    // Emit as incoming message
    await this.emitMessage({
      messageId,
      chatId,
      userId,
      content: text,
      messageType: messageType as any,
      timestamp: createTime,
      threadId,
      metadata: chatHistoryContext ? { chatHistoryContext } : undefined,
    });
  }

  /**
   * Handle file/image message.
   */
  private async handleFileMessage(
    messageId: string,
    chatId: string,
    messageType: 'image' | 'file' | 'media',
    content: string,
    threadId: string,
    createTime?: number,
    userId?: string
  ): Promise<void> {
    logger.info({ chatId, messageType, messageId }, 'Processing file/image message');
    const result = await this.fileHandler.handleFileMessage(chatId, messageType, content, messageId);
    if (!result.success) {
      logger.error({ chatId, messageType, messageId, error: result.error }, 'File/image processing failed - detailed error');
      await this.sendMessage({
        chatId,
        type: 'text',
        text: `❌ 处理${messageType === 'image' ? '图片' : '文件'}失败: ${result.error || '未知错误'}`,
      });
      return;
    }

    const attachments = attachmentManager.getAttachments(chatId);
    if (attachments.length > 0) {
      const latestAttachment = attachments[attachments.length - 1];
      const uploadPrompt = this.fileHandler.buildUploadPrompt(latestAttachment);

      await messageLogger.logIncomingMessage(
        messageId,
        userId || 'unknown',
        chatId,
        `[File uploaded: ${latestAttachment.fileName}]`,
        messageType,
        createTime
      );

      await this.emitMessage({
        messageId: `${messageId}-file`,
        chatId,
        userId,
        content: uploadPrompt,
        messageType: 'file',
        timestamp: createTime,
        threadId,
        attachments: [{
          fileName: latestAttachment.fileName || 'unknown',
          filePath: latestAttachment.localPath || '',
          mimeType: latestAttachment.mimeType,
        }],
      });
    }
  }

  /**
   * Handle command messages.
   * @returns true if command was handled and should return early
   */
  private async handleCommand(
    textWithoutMentions: string,
    chatId: string,
    botMentioned: boolean,
    commandRegistry: ReturnType<typeof getCommandRegistry>,
    userId?: string
  ): Promise<boolean> {
    const [command, ...args] = textWithoutMentions.slice(1).split(/\s+/);
    const cmd = command.toLowerCase();
    const isControlCommand = commandRegistry.has(cmd);

    if (isControlCommand || !botMentioned) {
      if (this.controlHandler) {
        const response = await this.emitControl({
          type: cmd as any,
          chatId,
          data: { args, rawText: textWithoutMentions, senderOpenId: userId },
        });

        if (response.success) {
          if (response.message) {
            await this.sendMessage({
              chatId,
              type: 'text',
              text: response.message,
            });
          }
          return true;
        }

        if (botMentioned) {
          await this.sendMessage({
            chatId,
            type: 'text',
            text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
          });
          return true;
        }
      }

      // Default command handling if no control handler registered
      if (cmd === 'reset') {
        await this.sendMessage({
          chatId,
          type: 'text',
          text: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。',
        });
        return true;
      }

      if (cmd === 'status') {
        await this.sendMessage({
          chatId,
          type: 'text',
          text: `📊 **状态**\n\nChannel: ${this.name}\nStatus: ${this.status}`,
        });
        return true;
      }
    } else {
      // Unknown command with @mention: show error instead of passing to agent
      await this.sendMessage({
        chatId,
        type: 'text',
        text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
      });
      return true;
    }

    return false;
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
    }

    // Issue #657: Always emit card action as a message to the agent
    try {
      const buttonText = action.text || action.value;
      const messageContent = `User clicked '${buttonText}' button`;

      await this.emitMessage({
        messageId: `${message_id}-${action.value}`,
        chatId: chat_id,
        userId: user?.sender_id?.open_id,
        content: messageContent,
        messageType: 'card',
        timestamp: Date.now(),
        metadata: {
          cardAction: action,
          cardMessageId: message_id,
          wasPendingInteraction: resolved,
        },
      });

      logger.debug({ messageId: message_id, chatId: chat_id, actionValue: action.value }, 'Card action emitted as message to agent');
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Failed to emit card action message');
    }

    // Return early if resolved
    if (resolved) {
      return;
    }

    try {
      const handled = await this.interactionManager.handleAction(event, async (defaultEvent) => {
        const buttonText = defaultEvent.action.text || defaultEvent.action.value;
        const messageContent = `The user clicked '${buttonText}' button`;

        await this.emitMessage({
          messageId: `${defaultEvent.message_id}-${defaultEvent.action.value}`,
          chatId: defaultEvent.chat_id,
          userId: defaultEvent.user?.sender_id?.open_id,
          content: messageContent,
          messageType: 'card',
          timestamp: Date.now(),
          metadata: {
            cardAction: defaultEvent.action,
            cardMessageId: defaultEvent.message_id,
          },
        });
      });

      if (!handled) {
        logger.debug({ messageId: message_id, actionValue: action.value }, 'Card action not handled');
      }
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Card action handler error');

      await this.sendMessage({
        chatId: chat_id,
        type: 'text',
        text: `❌ 处理卡片操作时发生错误：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }
}

// Re-export config type for backward compatibility
export type { FeishuChannelConfig } from './feishu/types.js';
