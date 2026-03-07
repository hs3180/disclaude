/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 *
 * Issue #694: Refactored to use modular components.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { messageLogger } from '../feishu/message-logger.js';
import { InteractionManager } from '../platforms/feishu/interaction-manager.js';
import type { WelcomeService } from '../platforms/feishu/welcome-service.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { attachmentManager } from '../file-transfer/inbound/index.js';
import { BaseChannel } from './base-channel.js';
import {
  PassiveModeManager,
  MentionDetector,
  WelcomeHandler,
  MessageHandler as FeishuMessageHandler,
  type MessageCallbacks,
} from './feishu/index.js';
// Issue #992: Import IPC server for cross-process interactive contexts
import { startIpcServer, stopIpcServer } from '../mcp/tools/interactive-message.js';
import type {
  FeishuEventData,
  FeishuCardActionEventData,
  FeishuChatMemberAddedEventData,
  FeishuP2PChatEnteredEventData,
} from '../types/platform.js';
import type {
  ChannelConfig,
  OutgoingMessage,
  ChannelCapabilities,
  IncomingMessage,
  ControlCommand,
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
  /**
   * Route card action to Worker Node if applicable.
   * Issue #935: Returns true if the action was routed to a Worker Node.
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

  // Modular components
  private passiveModeManager: PassiveModeManager;
  private mentionDetector: MentionDetector;
  private welcomeHandler: WelcomeHandler;
  private feishuMessageHandler: FeishuMessageHandler;
  private interactionManager: InteractionManager;
  private taskTracker: TaskTracker;
  private taskFlowOrchestrator?: TaskFlowOrchestrator;

  constructor(config: FeishuChannelConfig = {}) {
    super(config, 'feishu', 'Feishu');
    this.appId = config.appId || Config.FEISHU_APP_ID;
    this.appSecret = config.appSecret || Config.FEISHU_APP_SECRET;
    this.taskTracker = new TaskTracker();

    // Initialize modular components
    this.passiveModeManager = new PassiveModeManager();
    this.mentionDetector = new MentionDetector();
    this.interactionManager = new InteractionManager();
    this.welcomeHandler = new WelcomeHandler(this.appId, () => this.isRunning);

    // Create message callbacks
    const callbacks: MessageCallbacks = {
      emitMessage: async (message) => {
        await this.emitMessage(message as IncomingMessage);
      },
      emitControl: async (control) => {
        if (this.controlHandler) {
          return await this.emitControl(control as ControlCommand);
        }
        return { success: false };
      },
      sendMessage: async (message) => {
        await this.sendMessage(message as OutgoingMessage);
      },
      // Issue #935: Route card action to Worker Node if applicable
      routeCardAction: config.routeCardAction,
    };

    this.feishuMessageHandler = new FeishuMessageHandler({
      appId: this.appId,
      appSecret: this.appSecret,
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

    // Get bot info for mention detection
    // Issue #1033: fetchBotInfo now uses unified LarkClientService
    await this.mentionDetector.fetchBotInfo();

    // Initialize message handler
    this.feishuMessageHandler.initialize();

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

    // Issue #992: Start IPC server for cross-process interactive contexts
    // This must be called during channel startup, not at module load time,
    // to avoid test timeouts (see PR #982)
    try {
      await startIpcServer();
      logger.info('IPC server started for cross-process interactive contexts');
    } catch (error) {
      logger.error({ err: error }, 'Failed to start IPC server, interactive cards may not work across processes');
    }

    logger.info('FeishuChannel started');
  }

  protected doStop(): Promise<void> {
    this.wsClient = undefined;
    this.feishuMessageHandler.clearClient();

    // Dispose interaction manager
    this.interactionManager.dispose();

    // Clean up old attachments to prevent memory leaks
    attachmentManager.cleanupOldAttachments();

    // Issue #992: Stop IPC server
    stopIpcServer();

    logger.info('FeishuChannel stopped');
    return Promise.resolve();
  }

  protected async doSendMessage(message: OutgoingMessage): Promise<void> {
    const sender = this.feishuMessageHandler.getMessageSender();
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
        'send_message',
        'send_file',
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
   * Issue #694: Delegates to MessageHandler.
   * @internal
   */
  handleMessageReceive(data: FeishuEventData): Promise<void> {
    return this.feishuMessageHandler.handleMessageReceive(data);
  }
}
