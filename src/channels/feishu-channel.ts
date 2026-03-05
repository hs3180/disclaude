/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 *
 * Refactored (Issue #694): Split into multiple components:
 * - mention-detector.ts: Bot mention detection
 * - passive-mode.ts: Passive mode state management
 * - welcome-handler.ts: Welcome message handling
 * - message-handler.ts: Message processing
 * - card-handler.ts: Card action handling
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';
import { attachmentManager } from '../file-transfer/inbound/index.js';
import { messageLogger } from '../feishu/message-logger.js';
import { FeishuMessageSender } from '../platforms/feishu/feishu-message-sender.js';
import { InteractionManager } from '../platforms/feishu/interaction-manager.js';
import { createFeishuClient } from '../platforms/feishu/create-feishu-client.js';
import type { WelcomeService } from '../platforms/feishu/welcome-service.js';
import { TaskFlowOrchestrator } from '../feishu/task-flow-orchestrator.js';
import { TaskTracker } from '../utils/task-tracker.js';
import { BaseChannel } from './base-channel.js';
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
import {
  MentionDetector,
  PassiveModeManager,
  WelcomeHandler,
  FeishuMessageProcessor,
  CardHandler,
} from './feishu/index.js';

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
  private taskTracker: TaskTracker;
  private taskFlowOrchestrator?: TaskFlowOrchestrator;
  private interactionManager: InteractionManager;

  // Extracted components (Issue #694)
  private mentionDetector: MentionDetector;
  private passiveModeManager: PassiveModeManager;
  private welcomeHandler: WelcomeHandler;
  private feishuMessageProcessor: FeishuMessageProcessor;
  private cardHandler: CardHandler;

  constructor(config: FeishuChannelConfig = {}) {
    super(config, 'feishu', 'Feishu');
    this.appId = config.appId || Config.FEISHU_APP_ID;
    this.appSecret = config.appSecret || Config.FEISHU_APP_SECRET;
    this.taskTracker = new TaskTracker();

    // Initialize InteractionManager
    this.interactionManager = new InteractionManager();

    // Initialize extracted components (Issue #694)
    this.mentionDetector = new MentionDetector();
    this.passiveModeManager = new PassiveModeManager();
    this.welcomeHandler = new WelcomeHandler(this.appId);

    // Initialize message handler with callbacks
    this.feishuMessageProcessor = new FeishuMessageProcessor(
      {
        isRunning: () => this.isRunning,
        emitMessage: (msg: IncomingMessage) => this.emitMessage(msg),
        emitControl: (cmd: ControlCommand) => this.emitControl(cmd),
        sendMessage: (msg) => this.sendMessage(msg as OutgoingMessage),
        getClient: () => this.getClient(),
        getMessageSender: () => this.messageSender,
      },
      this.mentionDetector,
      this.passiveModeManager
    );

    // Initialize card handler with callbacks
    this.cardHandler = new CardHandler(
      {
        isRunning: () => this.isRunning,
        emitMessage: (msg: IncomingMessage) => this.emitMessage(msg),
        sendMessage: (msg) => this.sendMessage(msg as OutgoingMessage),
      },
      this.interactionManager
    );

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
          await this.feishuMessageProcessor.handleMessageReceive(data as FeishuEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle message receive');
        }
      },
      'card.action.trigger': async (data: unknown) => {
        try {
          await this.cardHandler.handleCardAction(data as FeishuCardActionEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle card action');
        }
      },
      'im.message.message_read_v1': async () => {},
      // Issue #463: Handle P2P chat entered for welcome message
      'im.chat.access_event.bot_p2p_chat_entered_v1': async (data: unknown) => {
        try {
          await this.welcomeHandler.handleP2PChatEntered(data as FeishuP2PChatEnteredEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle P2P chat entered');
        }
      },
      // Issue #463: Handle bot added to group for welcome message
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
      // Note: This is done lazily when client is first created
    }
    return this.client;
  }

  // ==========================================
  // Public API - Delegated to components
  // ==========================================

  /**
   * Check if passive mode is disabled for a specific chat.
   * Delegated to PassiveModeManager.
   *
   * Issue #511: Group chat passive mode control
   */
  isPassiveModeDisabled(chatId: string): boolean {
    return this.passiveModeManager.isPassiveModeDisabled(chatId);
  }

  /**
   * Set passive mode state for a specific chat.
   * Delegated to PassiveModeManager.
   *
   * Issue #511: Group chat passive mode control
   */
  setPassiveModeDisabled(chatId: string, disabled: boolean): void {
    this.passiveModeManager.setPassiveModeDisabled(chatId, disabled);
  }

  /**
   * Get all chats with passive mode disabled.
   * Delegated to PassiveModeManager.
   *
   * Issue #511: Group chat passive mode control
   */
  getPassiveModeDisabledChats(): string[] {
    return this.passiveModeManager.getPassiveModeDisabledChats();
  }

  /**
   * Get the InteractionManager for this channel.
   * Used for registering custom interaction handlers.
   */
  getInteractionManager(): InteractionManager {
    return this.interactionManager;
  }

  /**
   * Handle incoming message - exposed for testing.
   * @internal
   */
  async handleMessageReceive(data: FeishuEventData): Promise<void> {
    return this.feishuMessageProcessor.handleMessageReceive(data);
  }

  /**
   * Get the FeishuMessageProcessor for testing purposes.
   * @internal
   */
  getMessageProcessor(): FeishuMessageProcessor {
    return this.feishuMessageProcessor;
  }

  /**
   * Set the WelcomeService for this channel.
   * Delegated to WelcomeHandler.
   */
  setWelcomeService(service: WelcomeService): void {
    this.welcomeHandler.setWelcomeService(service);
  }
}
