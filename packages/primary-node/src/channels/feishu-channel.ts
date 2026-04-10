/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 *
 * Issue #694: Refactored to use modular components.
 * Migrated to @disclaude/primary-node (Issue #1040)
 * Issue #1351: WsConnectionManager for health detection & auto-reconnect.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  Config,
  WS_HEALTH,
  createLogger,
  BaseChannel,
  type FeishuEventData,
  type FeishuCardActionEventData,
  type FeishuChatMemberAddedEventData,
  type FeishuP2PChatEnteredEventData,
  type OutgoingMessage,
  type ChannelCapabilities,
  DEFAULT_CHANNEL_CAPABILITIES,
  attachmentManager,
} from '@disclaude/core';
import { InteractionManager, WelcomeService, createFeishuClient } from '../platforms/feishu/index.js';
import {
  PassiveModeManager,
  MentionDetector,
  WelcomeHandler,
  MessageHandler as FeishuMessageHandler,
  messageLogger,
  type MessageCallbacks,
  WsConnectionManager,
} from './feishu/index.js';

const logger = createLogger('FeishuChannel');

/**
 * Extract chat ID from various Feishu event data formats.
 *
 * Handles different event types with different data structures:
 * - im.message.receive_v1: data.event.message.chat_id
 * - card.action.trigger: data.context.open_chat_id
 * - bot_p2p_chat_entered_v1: data.event.user.open_id
 * - chat.member.added_v1: data.event.chat_id
 *
 * Issue #1357: Used in event dispatcher catch blocks to notify users of errors.
 */
function extractChatIdFromEvent(data: unknown): string | undefined {
  const raw = data as Record<string, unknown>;
  if (!raw) {
    return undefined;
  }

  // Try message event format: data.event.message.chat_id
  const event = raw.event as Record<string, unknown> | undefined;
  if (event?.message) {
    const message = event.message as Record<string, unknown>;
    if (typeof message.chat_id === 'string') {
      return message.chat_id;
    }
  }

  // Try card action format: data.context.open_chat_id
  if (raw.context) {
    const context = raw.context as Record<string, unknown>;
    if (typeof context.open_chat_id === 'string') {
      return context.open_chat_id;
    }
  }

  // Try member added event format: data.event.chat_id
  if (event && typeof event.chat_id === 'string') {
    return event.chat_id;
  }

  // Try P2P chat entered format: data.event.user.open_id
  if (event?.user) {
    const user = event.user as Record<string, unknown>;
    if (typeof user.open_id === 'string') {
      return user.open_id;
    }
  }

  return undefined;
}

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
   * Issue #1629: Includes resolvedPrompt from InteractiveContextStore
   * so remote Worker Nodes receive the contextual prompt.
   */
  routeCardAction?: (message: {
    chatId: string;
    cardMessageId: string;
    actionType: string;
    actionValue: string;
    actionText?: string;
    userId?: string;
    /** Resolved prompt from InteractiveContextStore (Issue #1629) */
    resolvedPrompt?: string;
    action?: {
      type: string;
      value: string;
      text?: string;
      trigger?: string;
    };
  }) => Promise<boolean>;
  /**
   * Resolve action prompt for a card action.
   * Issue #1572: Looks up the prompt template from InteractiveContextStore.
   */
  resolveActionPrompt?: (
    messageId: string,
    chatId: string,
    actionValue: string,
    actionText?: string,
  ) => string | undefined;
}

/**
 * Feishu Channel - Handles Feishu/Lark messaging via WebSocket.
 *
 * Features:
 * - WebSocket-based event receiving with health monitoring (Issue #1351)
 * - Auto-reconnect with exponential backoff on dead connections
 * - Offline message queue for messages sent during reconnection
 * - Message deduplication
 * - File/image handling
 * - Interactive card support
 * - Typing reactions
 */
export class FeishuChannel extends BaseChannel<FeishuChannelConfig> {
  private appId: string;
  private appSecret: string;
  private client?: lark.Client;

  /** WebSocket connection manager for health detection & auto-reconnect (Issue #1351) */
  private wsConnectionManager?: WsConnectionManager;

  // Modular components
  private passiveModeManager: PassiveModeManager;
  private mentionDetector: MentionDetector;
  private welcomeHandler: WelcomeHandler;
  private feishuMessageHandler: FeishuMessageHandler;
  private interactionManager: InteractionManager;

  /**
   * Offline message queue (Issue #1351).
   *
   * When the WebSocket is reconnecting, outgoing messages are buffered here
   * and automatically flushed after the connection is restored. Messages
   * older than WS_HEALTH.OFFLINE_QUEUE.MAX_MESSAGE_AGE_MS are discarded.
   */
  private offlineQueue: Array<{ message: OutgoingMessage; queuedAt: number }> = [];

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
      resolveActionPrompt: config.resolveActionPrompt,
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

    // Create event dispatcher — each handler records message receipt as the
    // sole liveness signal for WsConnectionManager (Issue #1666).
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: unknown) => {
        this.recordWsActivity();
        try {
          await this.feishuMessageHandler.handleMessageReceive(data as FeishuEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle message receive');
          await this.notifyUserDirectly(
            extractChatIdFromEvent(data) ?? '',
            '⚠️ 处理消息时遇到内部错误，请稍后重试。',
          );
        }
      },
      'card.action.trigger': async (data: unknown) => {
        this.recordWsActivity();
        try {
          await this.feishuMessageHandler.handleCardAction(data as FeishuCardActionEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle card action');
          await this.notifyUserDirectly(
            extractChatIdFromEvent(data) ?? '',
            '⚠️ 处理卡片操作时遇到错误，请稍后重试。',
          );
        }
      },
      'im.message.message_read_v1': () => {
        this.recordWsActivity();
        // No action needed for read receipts
      },
      'im.chat.access_event.bot_p2p_chat_entered_v1': async (data: unknown) => {
        this.recordWsActivity();
        try {
          await this.welcomeHandler.handleP2PChatEntered(data as FeishuP2PChatEnteredEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle P2P chat entered');
          await this.notifyUserDirectly(
            extractChatIdFromEvent(data) ?? '',
            '⚠️ 欢迎消息发送失败，但这不影响正常使用。',
          );
        }
      },
      'im.chat.member.added_v1': async (data: unknown) => {
        this.recordWsActivity();
        try {
          await this.welcomeHandler.handleChatMemberAdded(data as FeishuChatMemberAddedEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle chat member added');
          await this.notifyUserDirectly(
            extractChatIdFromEvent(data) ?? '',
            '⚠️ 欢迎消息发送失败，但这不影响正常使用。',
          );
        }
      },
    });

    // Create SDK logger
    const sdkLogger = {
      error: (...msg: unknown[]) => logger.error({ context: 'LarkSDK' }, String(msg)),
      warn: (...msg: unknown[]) => logger.warn({ context: 'LarkSDK' }, String(msg)),
      info: (...msg: unknown[]) => logger.info({ context: 'LarkSDK' }, String(msg)),
      debug: (...msg: unknown[]) => logger.debug({ context: 'LarkSDK' }, String(msg)),
      trace: (...msg: unknown[]) => logger.trace({ context: 'LarkSDK' }, String(msg)),
    };

    // Create WebSocket connection manager (Issue #1351)
    this.wsConnectionManager = new WsConnectionManager({
      appId: this.appId,
      appSecret: this.appSecret,
      sdkLogger,
      sdkLogLevel: lark.LoggerLevel.info,
    });

    // Listen for connection state events
    this.wsConnectionManager.on('stateChange', (state) => {
      logger.info({ wsState: state }, 'WebSocket connection state changed');
    });

    this.wsConnectionManager.on('deadConnection', (elapsedMs) => {
      logger.warn(
        { elapsedMs },
        'Dead WebSocket connection detected, initiating reconnect',
      );
    });

    this.wsConnectionManager.on('reconnected', (attempt) => {
      logger.info({ attempt }, 'WebSocket reconnected successfully');
      // Flush offline message queue after reconnect
      void this.flushOfflineQueue();
    });

    this.wsConnectionManager.on('reconnectFailed', (totalAttempts) => {
      logger.error(
        { totalAttempts },
        'WebSocket reconnection failed after all attempts',
      );
    });

    // Start the connection manager (creates WSClient + starts health monitoring)
    await this.wsConnectionManager.start(eventDispatcher);

    logger.info('FeishuChannel started');
  }

  protected async doStop(): Promise<void> {
    // Stop WebSocket connection manager (closes WSClient + health monitoring)
    if (this.wsConnectionManager) {
      await this.wsConnectionManager.stop();
      this.wsConnectionManager = undefined;
    }

    this.feishuMessageHandler.clearClient();

    // Dispose interaction manager
    this.interactionManager.dispose();

    // Clear offline queue
    this.offlineQueue = [];

    // Clean up old attachments to prevent memory leaks
    attachmentManager.cleanupOldAttachments();

    logger.info('FeishuChannel stopped');
  }

  protected async doSendMessage(message: OutgoingMessage): Promise<string | void> {
    if (!this.client) {
      throw new Error('Client not initialized');
    }

    // If WebSocket is reconnecting, queue message for later (Issue #1351)
    if (this.wsConnectionManager && this.wsConnectionManager.state !== 'connected') {
      this.queueOfflineMessage(message);
      return;
    }

    // Issue #1619: Use thread reply when threadId is provided.
    // Consistent with feishu-adapter.ts pattern.
    const useThreadReply = !!message.threadId;

    // Narrow client type for use inside closure (TS can't narrow this.client in closures)
    // eslint-disable-next-line prefer-destructuring
    const client = this.client;

    /**
     * Helper: send a Feishu message via create or reply API.
     * Returns the real message_id from the API response.
     */
    const sendFeishuMessage = async (
      msgType: string,
      content: string,
    ): Promise<string | undefined> => {
      if (useThreadReply) {
        // useThreadReply is !!message.threadId — guaranteed truthy here.
        // TypeScript can't narrow from boolean, so we use non-null assertion.
        const threadId = message.threadId!;
        try {
          const replyResp = await client.im.message.reply({
            path: {
              message_id: threadId,
            },
            data: {
              msg_type: msgType,
              content,
            },
          });
          return replyResp.data?.message_id;
        } catch (err) {
          logger.warn(
            { threadId, err, chatId: message.chatId },
            'Thread reply failed, falling back to message.create',
          );
          // Fall through to create path
        }
      }
      const createResp = await client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: message.chatId,
          msg_type: msgType,
          content,
        },
      });
      return createResp.data?.message_id;
    };

    switch (message.type) {
      case 'text': {
        // Issue #1742: If mentions are provided, send as post (rich text) with @mention tags
        if (message.mentions && message.mentions.length > 0) {
          const postContent = this.buildPostContentWithMentions(message.mentions, message.text || '');
          const messageId = await sendFeishuMessage('post', JSON.stringify(postContent));
          logger.debug({ chatId: message.chatId, messageId, mentionCount: message.mentions.length, threadReply: useThreadReply }, 'Post message (with mentions) sent');
          return messageId;
        }
        const messageId = await sendFeishuMessage(
          'text',
          JSON.stringify({ text: message.text || '' }),
        );
        logger.debug({ chatId: message.chatId, messageId, threadReply: useThreadReply }, 'Text message sent');
        return messageId;
      }

      case 'card': {
        const messageId = await sendFeishuMessage(
          'interactive',
          JSON.stringify(message.card || {}),
        );
        logger.debug({ chatId: message.chatId, messageId, threadReply: useThreadReply }, 'Card message sent');
        return messageId;
      }

      case 'file': {
        if (!message.filePath) {
          logger.error({ chatId: message.chatId }, 'File path missing in file message');
          throw new Error('File path is required for file messages');
        }

        // eslint-disable-next-line prefer-destructuring
        const filePath = message.filePath;
        const fileName = path.basename(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const { size: fileSize } = fs.statSync(filePath);

        logger.info({ chatId: message.chatId, filePath, fileName, fileSize }, 'Uploading file');

        // Determine message type based on file extension
        const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tiff', '.bmp', '.ico'];
        const isImage = imageExtensions.includes(ext);

        let fileMessageId: string | undefined;

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
          fileMessageId = await sendFeishuMessage(
            'image',
            JSON.stringify({ image_key: imageKey }),
          );
          logger.info({ chatId: message.chatId, messageId: fileMessageId, fileName, threadReply: useThreadReply }, 'Image message sent');
        } else {
          // Upload file using im.file.create
          if (fileSize > 30 * 1024 * 1024) {
            throw new Error(`File too large: ${fileSize} bytes (max 30MB)`);
          }

          // Map file extension to Feishu file_type
          const extToType: Record<string, 'opus' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'> = {
            '.opus': 'opus',
            // Note: .mp4 is intentionally mapped to 'stream' because Feishu requires
            // video files to be sent with msg_type:'media' + cover image. Using 'stream'
            // allows mp4 files to be sent as regular file attachments.
            // See: https://github.com/hs3180/disclaude/issues/2265
            '.mp4': 'stream',
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
          fileMessageId = await sendFeishuMessage(
            'file',
            JSON.stringify({ file_key: fileKey }),
          );
          logger.info({ chatId: message.chatId, messageId: fileMessageId, fileName, threadReply: useThreadReply }, 'File message sent');
        }
        return fileMessageId;
      }

      case 'done':
        logger.debug({ chatId: message.chatId }, 'Task completed (done signal)');
        return;

      default:
        throw new Error(`Unsupported message type: ${(message as { type: string }).type}`);
    }
  }

  /**
   * Build Feishu post content with @mention tags.
   *
   * Constructs a rich text (post) message structure with @mention elements
   * followed by the text content. Used when sending messages with mentions
   * to properly render @mention tags in Feishu.
   *
   * Issue #1742: Bot-to-bot @mention support.
   *
   * @param mentions - Array of mention targets with openId and optional name
   * @param text - The text content to include after mentions
   * @returns Feishu post content structure
   */
  private buildPostContentWithMentions(
    mentions: Array<{ openId: string; name?: string }>,
    text: string
  ): Record<string, unknown> {
    const inlineElements: Array<Record<string, unknown>> = [];
    for (const mention of mentions) {
      inlineElements.push({ tag: 'at', user_id: mention.openId });
    }
    if (text) {
      inlineElements.push({ tag: 'text', text: ` ${text}` });
    }
    return {
      zh_cn: {
        title: '',
        content: [inlineElements],
      },
    };
  }

  protected checkHealth(): boolean {
    // Use WsConnectionManager's health check (Issue #1351)
    if (this.wsConnectionManager) {
      return this.wsConnectionManager.isHealthy();
    }
    return false;
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
   * Get the PassiveModeManager instance.
   * Issue #2069: Allows external initialization from persisted records.
   */
  getPassiveModeManager(): PassiveModeManager {
    return this.passiveModeManager;
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

  // ─── WebSocket health monitoring (Issue #1351, #1666) ────────────────

  /**
   * Record that an event was received from the server.
   *
   * This is the sole liveness signal for WsConnectionManager (Issue #1666).
   * Called from every event handler in the EventDispatcher for all
   * incoming server messages. WsConnectionManager uses this to detect
   * dead connections (no message within 130s → reconnect).
   */
  private recordWsActivity(): void {
    this.wsConnectionManager?.recordMessageReceived();
  }

  /**
   * Send a text message directly via Feishu API client, bypassing all routing/queue logic.
   *
   * Used as a last-resort fallback for error notifications when the normal message
   * flow has failed. This is intentionally simple — no offline queue, no routing,
   * no formatting — to maximize the chance of delivery.
   *
   * The notification itself is wrapped in try/catch to ensure it never throws.
   *
   * Issue #1357: Error notification for critical event handler failures.
   */
  private async notifyUserDirectly(chatId: string, text: string): Promise<void> {
    if (!this.client || !chatId) {
      return;
    }
    try {
      await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
    } catch (notifyErr) {
      // Never throw from error notification — just log the secondary failure
      logger.error({ err: notifyErr, chatId }, 'Failed to send error notification to user');
    }
  }

  /**
   * Get WebSocket connection metrics for observability.
   */
  getWsMetrics(): ReturnType<WsConnectionManager['getMetrics']> | undefined {
    return this.wsConnectionManager?.getMetrics();
  }

  /**
   * Queue a message for later delivery when the WebSocket is reconnecting.
   *
   * Messages older than `MAX_MESSAGE_AGE_MS` are discarded during flush.
   * Queue size is bounded by `MAX_SIZE` — oldest messages are dropped when full.
   */
  private queueOfflineMessage(message: OutgoingMessage): void {
    const maxSize = WS_HEALTH.OFFLINE_QUEUE.MAX_SIZE;

    // Drop oldest if queue is full
    if (this.offlineQueue.length >= maxSize) {
      const dropped = this.offlineQueue.shift();
      logger.warn(
        { chatId: dropped?.message.chatId, type: dropped?.message.type },
        'Offline queue full, dropping oldest message',
      );
    }

    this.offlineQueue.push({ message, queuedAt: Date.now() });

    logger.info(
      { chatId: message.chatId, type: message.type, queueSize: this.offlineQueue.length },
      'Message queued (WebSocket reconnecting)',
    );
  }

  /**
   * Flush the offline message queue after a successful reconnection.
   *
   * Filters out expired messages (older than `MAX_MESSAGE_AGE_MS`) and
   * sends the remaining ones via `doSendMessage()`. Errors on individual
   * messages are logged but do not prevent other messages from being sent.
   */
  private async flushOfflineQueue(): Promise<void> {
    if (this.offlineQueue.length === 0) {
      return;
    }

    const now = Date.now();
    const maxAge = WS_HEALTH.OFFLINE_QUEUE.MAX_MESSAGE_AGE_MS;
    const queue = this.offlineQueue;
    this.offlineQueue = [];

    // Filter out expired messages
    const valid = queue.filter((entry) => {
      const age = now - entry.queuedAt;
      if (age > maxAge) {
        logger.debug(
          { chatId: entry.message.chatId, type: entry.message.type, ageMs: age, maxAgeMs: maxAge },
          'Discarding expired offline message',
        );
        return false;
      }
      return true;
    });

    if (valid.length === 0) {
      return;
    }

    logger.info({ count: valid.length }, 'Flushing offline message queue');

    // Send each message; don't let individual failures block others
    for (const entry of valid) {
      try {
        await this.doSendMessage(entry.message);
      } catch (error) {
        logger.error(
          { err: error, chatId: entry.message.chatId, type: entry.message.type },
          'Failed to send queued message',
        );
      }
    }

    logger.info({ flushed: valid.length, dropped: queue.length - valid.length }, 'Offline queue flushed');
  }
}
