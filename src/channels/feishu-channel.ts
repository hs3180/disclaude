/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 *
 * Issue #694: Refactored to use extracted modules:
 * - PassiveModeManager: passive-mode.ts
 * - MentionDetector: mention-detector.ts
 * - WelcomeEventHandler: welcome-event-handler.ts
 * - MessageHandler: message-handler.ts
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../config/index.js';
import { REACTIONS, CHAT_HISTORY } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { attachmentManager, downloadFile } from '../file-transfer/inbound/index.js';
import { messageLogger } from '../feishu/message-logger.js';
import { FeishuFileHandler } from '../platforms/feishu/feishu-file-handler.js';
import { FeishuMessageSender } from '../platforms/feishu/feishu-message-sender.js';
import { InteractionManager } from '../platforms/feishu/interaction-manager.js';
import { createFeishuClient } from '../platforms/feishu/create-feishu-client.js';
import type { WelcomeService } from '../platforms/feishu/welcome-service.js';
import { resolvePendingInteraction } from '../mcp/feishu-context-mcp.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { filteredMessageForwarder } from '../feishu/filtered-message-forwarder.js';
import type { FilterReason } from '../config/types.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { BaseChannel } from './base-channel.js';
import {
  PassiveModeManager,
  MentionDetector,
  WelcomeEventHandler,
  FeishuMessageHandler,
} from './feishu/index.js';
import type {
  FeishuEventData,
  FeishuCardActionEvent,
  FeishuCardActionEventData,
  FeishuChatMemberAddedEventData,
  FeishuP2PChatEnteredEventData,
} from '../types/platform.js';
import type {
  ChannelConfig,
  OutgoingMessage,
  ChannelCapabilities,
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
  private welcomeService?: WelcomeService;

  // Extracted modules (Issue #694)
  private passiveModeManager: PassiveModeManager;
  private mentionDetector: MentionDetector;
  private welcomeEventHandler: WelcomeEventHandler;
  private feishuMessageHandler: FeishuMessageHandler;

  constructor(config: FeishuChannelConfig = {}) {
    super(config, 'feishu', 'Feishu');
    this.appId = config.appId || Config.FEISHU_APP_ID;
    this.appSecret = config.appSecret || Config.FEISHU_APP_SECRET;
    this.taskTracker = new TaskTracker();

    // Initialize FileHandler first (needed by FeishuMessageHandler)
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

    // Initialize extracted modules (Issue #694)
    this.passiveModeManager = new PassiveModeManager();
    this.mentionDetector = new MentionDetector();
    this.welcomeEventHandler = new WelcomeEventHandler({
      isRunning: () => this.isRunning,
      getWelcomeService: () => this.welcomeService,
      getAppId: () => this.appId,
    });
    this.feishuMessageHandler = new FeishuMessageHandler({
      isRunning: () => this.isRunning,
      getClient: () => this.getClient(),
      extractOpenId: (sender) => this.extractOpenId(sender),
      addTypingReaction: (messageId) => this.addTypingReaction(messageId),
      sendMessage: (message) => this.sendMessage(message as OutgoingMessage),
      emitMessage: (message) => this.emitMessage(message),
      emitControl: (control) => this.emitControl(control),
      forwardFilteredMessage: (reason, messageId, chatId, content, userId, metadata) =>
        this.forwardFilteredMessage(reason as FilterReason, messageId, chatId, content, userId, metadata),
      getChatHistoryContext: (chatId) => this.getChatHistoryContext(chatId),
      isGroupChat: (chatType) => this.isGroupChat(chatType),
      passiveModeManager: this.passiveModeManager,
      mentionDetector: this.mentionDetector,
      fileHandler: this.fileHandler,
      getControlHandler: () => this.controlHandler,
    });

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
          await this.feishuMessageHandler.handleMessageReceive(data as FeishuEventData);
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
          await this.welcomeEventHandler.handleP2PChatEntered(data as FeishuP2PChatEnteredEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle P2P chat entered');
        }
      },
      // Issue #463: Handle bot added to group for welcome message
      'im.chat.member.added_v1': async (data: unknown) => {
        try {
          await this.welcomeEventHandler.handleChatMemberAdded(data as FeishuChatMemberAddedEventData);
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
   * Check if the chat is a group chat.
   * Uses chat_type field from message event.
   *
   * @param chatType - Chat type from message event ('p2p', 'group', 'topic')
   * @returns true if it's a group chat
   */
  private isGroupChat(chatType?: string): boolean {
    return chatType === 'group' || chatType === 'topic';
  }

  /**
   * Check if passive mode is disabled for a specific chat.
   * When passive mode is disabled, the bot responds to all messages in group chats.
   *
   * Issue #511: Group chat passive mode control
   *
   * @param chatId - Chat ID to check
   * @returns true if passive mode is disabled (bot responds to all messages)
   */
  isPassiveModeDisabled(chatId: string): boolean {
    return this.passiveModeManager.isDisabled(chatId);
  }

  /**
   * Set passive mode state for a specific chat.
   *
   * Issue #511: Group chat passive mode control
   *
   * @param chatId - Chat ID to configure
   * @param disabled - true to disable passive mode (respond to all messages)
   */
  setPassiveModeDisabled(chatId: string, disabled: boolean): void {
    this.passiveModeManager.setDisabled(chatId, disabled);
  }

  /**
   * Get all chats with passive mode disabled.
   *
   * Issue #511: Group chat passive mode control
   *
   * @returns Array of chat IDs with passive mode disabled
   */
  getPassiveModeDisabledChats(): string[] {
    return this.passiveModeManager.getDisabledChats();
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
   * Get formatted chat history context for passive mode.
   * Issue #517: Include recent chat history when bot is mentioned in group chats.
   */
  private async getChatHistoryContext(chatId: string): Promise<string | undefined> {
    try {
      const rawHistory = await messageLogger.getChatHistory(chatId);

      if (!rawHistory || rawHistory.length === 0) {
        return undefined;
      }

      // Truncate if too long (keep the most recent content)
      let history = rawHistory;
      if (history.length > CHAT_HISTORY.MAX_CONTEXT_LENGTH) {
        // Try to truncate at a reasonable point (e.g., at a message boundary)
        const truncatePoint = history.lastIndexOf('## [', history.length - CHAT_HISTORY.MAX_CONTEXT_LENGTH);
        if (truncatePoint > 0) {
          history = `...(earlier messages truncated)...\n\n${history.slice(truncatePoint)}`;
        } else {
          // Fallback: just truncate from the end
          history = history.slice(-CHAT_HISTORY.MAX_CONTEXT_LENGTH);
          history = `...(earlier messages truncated)...\n\n${history.slice(history.indexOf('## ['))}`;
        }
      }

      return history;
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to get chat history context');
      return undefined;
    }
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
      // Issue #657: Continue to emit message to agent instead of returning early
      // This allows the agent to handle the interaction and decide what to do next
    }

    // Issue #657: Always emit card action as a message to the agent
    // This enables the agent to handle user interactions and take appropriate actions
    try {
      // Get button text for user-friendly message
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

      logger.debug(
        { messageId: message_id, chatId: chat_id, actionValue: action.value },
        'Card action emitted as message to agent'
      );
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Failed to emit card action message');
    }

    // Return early if resolved - the wait_for_interaction tool already returned the result
    if (resolved) {
      return;
    }

    try {
      // Try to handle via InteractionManager
      const handled = await this.interactionManager.handleAction(event, async (defaultEvent) => {
        // Default handler: emit as interaction message
        // Issue #525: Use button text to generate user-friendly prompt
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

  /**
   * Set the WelcomeService for this channel.
   * Used for sending welcome messages on bot added to group or first private chat.
   */
  setWelcomeService(service: WelcomeService): void {
    this.welcomeService = service;
  }

  /**
   * Handle incoming message event.
   * Proxy method for testing compatibility.
   * @internal
   */
  handleMessageReceive(data: FeishuEventData): Promise<void> {
    return this.feishuMessageHandler.handleMessageReceive(data);
  }
}
