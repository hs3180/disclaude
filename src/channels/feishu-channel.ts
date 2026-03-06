/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 *
 * Issue #694: Refactored to use modular components.
 * Issue #959: Added WebSocket reconnection watchdog mechanism.
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
 * WebSocket reconnection watchdog configuration.
 * Issue #959: Monitor WebSocket connection health and detect reconnection issues.
 */
interface WatchdogConfig {
  /** Interval in milliseconds to check connection health (default: 60000 = 1 minute) */
  checkIntervalMs: number;
  /** Threshold in milliseconds after which to warn about potential disconnection (default: 300000 = 5 minutes) */
  warningThresholdMs: number;
  /** Threshold in milliseconds after which to log error and suggest action (default: 600000 = 10 minutes) */
  errorThresholdMs: number;
}

const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  checkIntervalMs: 60 * 1000, // 1 minute
  warningThresholdMs: 5 * 60 * 1000, // 5 minutes
  errorThresholdMs: 10 * 60 * 1000, // 10 minutes
};

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
  private wsClient?: lark.WSClient;

  // Issue #959: WebSocket reconnection watchdog
  private lastWsReadyTime: number = 0;
  private reconnectWatchdog?: NodeJS.Timeout;
  private watchdogConfig: WatchdogConfig = DEFAULT_WATCHDOG_CONFIG;

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
    await this.mentionDetector.fetchBotInfo(this.appId, this.appSecret);

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
      'im.message.message_read_v1': async () => {},
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

    // Issue #959: Start WebSocket reconnection watchdog
    this.lastWsReadyTime = Date.now();
    this.startReconnectWatchdog();

    logger.info('FeishuChannel started');
  }

  protected doStop(): Promise<void> {
    // Issue #959: Stop WebSocket reconnection watchdog
    this.stopReconnectWatchdog();

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
   * Issue #959: Start the WebSocket reconnection watchdog.
   * Monitors connection health and logs warnings when reconnection takes too long.
   */
  private startReconnectWatchdog(): void {
    if (this.reconnectWatchdog) {
      clearInterval(this.reconnectWatchdog);
    }

    this.reconnectWatchdog = setInterval(() => {
      this.checkWebSocketHealth();
    }, this.watchdogConfig.checkIntervalMs);

    logger.debug(
      { checkIntervalMs: this.watchdogConfig.checkIntervalMs },
      'WebSocket reconnection watchdog started'
    );
  }

  /**
   * Issue #959: Stop the WebSocket reconnection watchdog.
   */
  private stopReconnectWatchdog(): void {
    if (this.reconnectWatchdog) {
      clearInterval(this.reconnectWatchdog);
      this.reconnectWatchdog = undefined;
      logger.debug('WebSocket reconnection watchdog stopped');
    }
  }

  /**
   * Issue #959: Check WebSocket connection health.
   * Uses SDK's getReconnectInfo() API to monitor reconnection status.
   */
  private checkWebSocketHealth(): void {
    if (!this.wsClient) {
      return;
    }

    const now = Date.now();
    const timeSinceLastReady = now - this.lastWsReadyTime;

    try {
      // Get reconnection info from SDK
      const reconnectInfo = this.wsClient.getReconnectInfo();

      if (reconnectInfo) {
        const { lastConnectTime, nextConnectTime } = reconnectInfo;

        // If we have a nextConnectTime, it means we're in reconnecting state
        if (nextConnectTime > 0) {
          const timeUntilNextConnect = nextConnectTime - now;
          logger.warn(
            {
              timeSinceLastReady: Math.round(timeSinceLastReady / 1000),
              timeUntilNextConnect: Math.round(timeUntilNextConnect / 1000),
              lastConnectTime: new Date(lastConnectTime).toISOString(),
            },
            'WebSocket is in reconnection state'
          );

          // Update lastWsReadyTime to lastConnectTime from SDK
          // This gives us the actual last connection attempt time
          if (lastConnectTime > 0) {
            this.lastWsReadyTime = lastConnectTime;
          }
        } else {
          // Connection is healthy, update last ready time
          this.lastWsReadyTime = now;
        }
      }

      // Check if we've been disconnected for too long
      if (timeSinceLastReady > this.watchdogConfig.errorThresholdMs) {
        logger.error(
          {
            disconnectedDuration: Math.round(timeSinceLastReady / 1000 / 60),
            thresholdMinutes: Math.round(this.watchdogConfig.errorThresholdMs / 1000 / 60),
          },
          'WebSocket has been disconnected for an extended period. Consider restarting the channel.'
        );
      } else if (timeSinceLastReady > this.watchdogConfig.warningThresholdMs) {
        logger.warn(
          {
            disconnectedDuration: Math.round(timeSinceLastReady / 1000 / 60),
            thresholdMinutes: Math.round(this.watchdogConfig.warningThresholdMs / 1000 / 60),
          },
          'WebSocket connection may be unstable - no activity detected recently'
        );
      }
    } catch (error) {
      logger.debug({ err: error }, 'Failed to get WebSocket reconnect info');
    }
  }

  /**
   * Issue #959: Update last WebSocket ready time.
   * Called when WebSocket connection is confirmed to be working.
   */
  private updateWsReadyTime(): void {
    this.lastWsReadyTime = Date.now();
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
