/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 *
 * Issue #694: Refactored to use modular components
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../config/index.js';
import { REACTIONS } from '../config/constants.js';
import { createLogger } from '../utils/logger.js';
import { attachmentManager } from '../file-transfer/inbound/index.js';
import { messageLogger } from '../feishu/message-logger.js';
import { FeishuFileHandler } from '../platforms/feishu/feishu-file-handler.js';
import { FeishuMessageSender } from '../platforms/feishu/feishu-message-sender.js';
import { InteractionManager } from '../platforms/feishu/interaction-manager.js';
import { createFeishuClient } from '../platforms/feishu/create-feishu-client.js';
import type { WelcomeService } from '../platforms/feishu/welcome-service.js';
import { resolvePendingInteraction } from '../mcp/feishu-context-mcp.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { filteredMessageForwarder } from '../feishu/filtered-message-forwarder.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { BaseChannel } from './base-channel.js';
import type {
  FeishuCardActionEventData,
  FeishuCardActionEvent,
} from '../types/platform.js';
import type {
  ChannelConfig,
  OutgoingMessage,
  ChannelCapabilities,
} from './types.js';

// Import modular components (Issue #694)
import { PassiveModeManager } from './feishu/passive-mode.js';
import { MentionDetector } from './feishu/mention-detector.js';
import { WelcomeHandler } from './feishu/welcome-handler.js';
import { FeishuMessageHandler, type FeishuMessageHandlerContext } from './feishu/message-handler.js';

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

  // Modular components (Issue #694)
  private passiveModeManager: PassiveModeManager;
  private mentionDetector: MentionDetector;
  private welcomeHandler: WelcomeHandler;
  private feishuMessageHandler: FeishuMessageHandler;

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
          const { downloadFile } = await import('../file-transfer/inbound/index.js');
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

    // Initialize modular components (Issue #694)
    this.passiveModeManager = new PassiveModeManager();
    this.mentionDetector = new MentionDetector();
    this.welcomeHandler = new WelcomeHandler(this.appId, () => this.isRunning);
    this.welcomeHandler.setRunningChecker(() => this.isRunning);
    this.feishuMessageHandler = new FeishuMessageHandler();

    logger.info({ id: this.id }, 'FeishuChannel created');
  }

  protected async doStart(): Promise<void> {
    // Initialize message logger
    await messageLogger.init();

    // Get bot info for mention detection
    this.getClient();
    await this.mentionDetector.fetchBotInfo(this.client!);

    // Create event dispatcher
    this.eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        try {
          await this.feishuMessageHandler.handleMessageReceive(
            data as any,
            this.createMessageHandlerContext()
          );
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
      'im.chat.access_event.bot_p2p_chat_entered_v1': async (data: unknown) => {
        try {
          await this.welcomeHandler.handleP2PChatEntered(data as any);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle P2P chat entered');
        }
      },
      'im.chat.member.added_v1': async (data: unknown) => {
        try {
          await this.welcomeHandler.handleChatMemberAdded(data as any);
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
        await sender.sendFile(message.chatId, message.filePath || '');
        break;
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
   */
  getTaskFlowOrchestrator(): TaskFlowOrchestrator | undefined {
    return this.taskFlowOrchestrator;
  }

  /**
   * Initialize TaskFlowOrchestrator with callbacks.
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
      // Initialize filtered message forwarder
      filteredMessageForwarder.setMessageSender({
        sendText: async (chatId: string, text: string) => {
          await this.messageSender!.sendText(chatId, text);
        },
      });
    }
    return this.client;
  }

  /**
   * Create message handler context.
   */
  private createMessageHandlerContext(): FeishuMessageHandlerContext {
    return {
      client: this.client!,
      fileHandler: this.fileHandler,
      mentionDetector: this.mentionDetector,
      passiveModeManager: this.passiveModeManager,
      appId: this.appId,
      addTypingReaction: async (messageId: string) => {
        if (this.messageSender) {
          await this.messageSender.addReaction(messageId, REACTIONS.TYPING);
        }
      },
      sendMessage: async (msg) => {
        await this.sendMessage(msg as OutgoingMessage);
      },
      emitMessage: async (msg) => {
        await this.emitMessage({
          messageId: msg.messageId,
          chatId: msg.chatId,
          userId: msg.userId,
          content: msg.content,
          messageType: msg.messageType as any,
          timestamp: msg.timestamp,
          threadId: msg.threadId,
          metadata: msg.metadata,
          attachments: msg.attachments,
        });
      },
      emitControl: async (ctrl) => {
        return this.emitControl({
          type: ctrl.type as any,
          chatId: ctrl.chatId,
          data: ctrl.data,
        });
      },
      controlHandler: this.controlHandler,
    };
  }

  /**
   * Handle incoming message event from WebSocket.
   * This method delegates to FeishuMessageHandler for test compatibility.
   * @internal Used by tests
   */
  async handleMessageReceive(data: unknown): Promise<void> {
    if (!this.client) {
      this.getClient();
    }
    await this.feishuMessageHandler.handleMessageReceive(
      data as any,
      this.createMessageHandlerContext()
    );
  }

  /**
   * Check if passive mode is disabled for a specific chat.
   */
  isPassiveModeDisabled(chatId: string): boolean {
    return this.passiveModeManager.isDisabled(chatId);
  }

  /**
   * Set passive mode state for a specific chat.
   */
  setPassiveModeDisabled(chatId: string, disabled: boolean): void {
    this.passiveModeManager.setDisabled(chatId, disabled);
  }

  /**
   * Get all chats with passive mode disabled.
   */
  getPassiveModeDisabledChats(): string[] {
    return this.passiveModeManager.getDisabledChats();
  }

  /**
   * Handle card action event from WebSocket.
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

    // Always emit card action as a message to the agent
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

      logger.debug(
        { messageId: message_id, chatId: chat_id, actionValue: action.value },
        'Card action emitted as message to agent'
      );
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Failed to emit card action message');
    }

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
        logger.debug(
          { messageId: message_id, actionValue: action.value },
          'Card action not handled'
        );
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
}
