/**
 * Feishu Channel Implementation.
 *
 * Handles Feishu/Lark messaging platform integration via WebSocket.
 * Implements the IChannel interface for unified message handling.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import { Config } from '../config/index.js';
import { DEDUPLICATION, REACTIONS, CHAT_HISTORY } from '../config/constants.js';
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
import { BaseChannel } from './base-channel.js';
import type {
  FeishuEventData,
  FeishuMessageEvent,
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

  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  /**
   * Passive mode state storage.
   * Key: chatId, Value: true if passive mode is disabled (bot responds to all messages)
   * Issue #511: Group chat passive mode control
   */
  private passiveModeDisabled: Map<string, boolean> = new Map();

  /**
   * Bot's open_id for mention detection.
   * Issue #600: Correctly identify bot mentions in group chats
   */
  private botOpenId?: string;

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

    // Get bot's open_id for mention detection (Issue #600)
    await this.fetchBotOpenId();

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
          await this.handleP2PChatEntered(data as FeishuP2PChatEnteredEventData);
        } catch (error) {
          logger.error({ err: error }, 'Failed to handle P2P chat entered');
        }
      },
      // Issue #463: Handle bot added to group for welcome message
      'im.chat.member.added_v1': async (data: unknown) => {
        try {
          await this.handleChatMemberAdded(data as FeishuChatMemberAddedEventData);
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
   * Fetch bot's open_id from Feishu API.
   * This is used to correctly identify when the bot is mentioned.
   *
   * Issue #600: Correctly identify bot mentions in group chats
   */
  private async fetchBotOpenId(): Promise<void> {
    try {
      const client = this.getClient();
      // Use bot info API to get bot's open_id
      const response = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });

      if (response.data?.bot?.open_id) {
        this.botOpenId = response.data.bot.open_id;
        logger.info({ botOpenId: this.botOpenId }, 'Bot open_id fetched for mention detection');
      } else {
        logger.warn('Failed to fetch bot open_id, mention detection may be less accurate');
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to fetch bot open_id, mention detection may be less accurate');
    }
  }

  /**
   * Check if the bot is mentioned in the message.
   * When bot is mentioned, commands should be passed through to the agent.
   *
   * Issue #600: Correctly identify bot mentions in group chats
   *
   * @param mentions - Mentions array from Feishu message
   * @returns true if bot is mentioned
   */
  private isBotMentioned(mentions?: FeishuMessageEvent['message']['mentions']): boolean {
    if (!mentions || mentions.length === 0) {
      return false;
    }

    // If we have bot's open_id, check if any mention matches
    if (this.botOpenId) {
      return mentions.some((mention) => {
        // Check if the mention's open_id matches bot's open_id
        return mention.id?.open_id === this.botOpenId;
      });
    }

    // Fallback: Check for bot mention patterns
    // Bot mentions typically have open_id starting with 'cli_' (app ID format)
    // or have key containing 'bot'
    return mentions.some((mention) => {
      const openId = mention.id?.open_id || '';
      const key = mention.key || '';
      // Bot's open_id typically starts with 'cli_' (app/bot ID format)
      // or the key contains 'bot' (e.g., '@_bot')
      return openId.startsWith('cli_') || key.toLowerCase().includes('bot');
    });
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
    return this.passiveModeDisabled.get(chatId) === true;
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
    if (disabled) {
      this.passiveModeDisabled.set(chatId, true);
      logger.info({ chatId }, 'Passive mode disabled for chat');
    } else {
      this.passiveModeDisabled.delete(chatId);
      logger.info({ chatId }, 'Passive mode enabled for chat');
    }
  }

  /**
   * Get all chats with passive mode disabled.
   *
   * Issue #511: Group chat passive mode control
   *
   * @returns Array of chat IDs with passive mode disabled
   */
  getPassiveModeDisabledChats(): string[] {
    return Array.from(this.passiveModeDisabled.keys());
  }

  /**
   * Forward a filtered message to the debug chat.
   * @see Issue #597
   *
   * @param reason - The reason the message was filtered
   * @param messageId - The message ID
   * @param chatId - The chat ID
   * @param content - The message content
   * @param userId - The user ID (optional)
   * @param metadata - Additional metadata (optional)
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
    const { message, sender } = event;

    if (!message) {return;}

    const { message_id, chat_id, chat_type, content, message_type, create_time, mentions } = message;

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
      await this.forwardFilteredMessage('duplicate', message_id, chat_id, content, this.extractOpenId(sender));
      return;
    }

    // Ignore bot messages
    if (sender?.sender_type === 'app') {
      logger.debug('Skipped bot message');
      await this.forwardFilteredMessage('bot', message_id, chat_id, content);
      return;
    }

    // Check message age
    if (create_time) {
      const messageAge = Date.now() - create_time;
      if (messageAge > this.MAX_MESSAGE_AGE) {
        logger.debug({ messageId: message_id }, 'Skipped old message');
        await this.forwardFilteredMessage('old', message_id, chat_id, content, this.extractOpenId(sender), { age: messageAge });
        return;
      }
    }

    // Handle file/image messages
    if (message_type === 'image' || message_type === 'file' || message_type === 'media') {
      logger.info(
        { chatId: chat_id, messageType: message_type, messageId: message_id },
        'Processing file/image message'
      );
      const result = await this.fileHandler.handleFileMessage(chat_id, message_type, content, message_id);
      if (!result.success) {
        logger.error(
          { chatId: chat_id, messageType: message_type, messageId: message_id, error: result.error },
          'File/image processing failed - detailed error'
        );
        await this.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: `❌ 处理${message_type === 'image' ? '图片' : '文件'}失败: ${result.error || '未知错误'}`,
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
      await this.forwardFilteredMessage('unsupported', message_id, chat_id, content, this.extractOpenId(sender), { messageType: message_type });
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
      await this.forwardFilteredMessage('empty', message_id, chat_id, content, this.extractOpenId(sender));
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

    // Issue #460 & #511: Group chat passive mode
    // In group chats, only respond when bot is mentioned (@bot)
    // This allows scheduled tasks to broadcast without triggering unwanted responses
    // Issue #511: Passive mode can be disabled per chat via /passive command
    // Issue #650: Move passive mode check BEFORE command processing
    const passiveModeDisabled = this.isPassiveModeDisabled(chat_id);
    if (this.isGroupChat(chat_type) && !botMentioned && !passiveModeDisabled) {
      logger.debug(
        { messageId: message_id, chatId: chat_id, chat_type },
        'Skipped group chat message without @mention (passive mode)'
      );
      // Issue #597: Forward filtered message to debug chat
      await this.forwardFilteredMessage('passive_mode', message_id, chat_id, text, this.extractOpenId(sender), { chat_type });
      return;
    }

    // Get control commands from CommandRegistry (Issue #463: removed hardcoded list)
    const commandRegistry = getCommandRegistry();

    if (trimmedText.startsWith('/')) {
      const [command, ...args] = trimmedText.slice(1).split(/\s+/);
      const cmd = command.toLowerCase();

      // Handle control commands through the control channel
      // Control commands are ALWAYS handled locally, regardless of @mentions
      // Non-control commands with @mention show error instead of passing to agent (Issue #595)
      const isControlCommand = commandRegistry.has(cmd);

      if (isControlCommand || !botMentioned) {
        if (this.controlHandler) {
          const response = await this.emitControl({
            type: cmd as any,
            chatId: chat_id,
            data: { args, rawText: trimmedText, senderOpenId: this.extractOpenId(sender) },
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
          // Without @mention: unknown commands fall through to agent (original behavior)
          // With @mention: show error instead of passing to agent (Issue #595)
          if (botMentioned) {
            await this.sendMessage({
              chatId: chat_id,
              type: 'text',
              text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
            });
            return;
          }
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
      } else {
        // Unknown command with @mention: show error instead of passing to agent
        // Issue #595: Control commands not parsed when bot is @mentioned in group chat
        await this.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
        });
        return;
      }
    }

    // Log if bot is mentioned with a non-control command (for debugging)
    if (botMentioned && trimmedText.startsWith('/')) {
      logger.debug({ messageId: message_id, chatId: chat_id, command: trimmedText }, 'Bot mentioned with non-control command, passing to agent');
    }

    // Issue #514: Add typing reaction only for messages that will be processed
    // This is placed after passive mode check to avoid reacting to skipped messages
    await this.addTypingReaction(message_id);

    // Issue #517: Get chat history for passive mode context
    // When bot is mentioned in a group chat, include recent chat history as context
    const isPassiveModeTrigger = this.isGroupChat(chat_type) && botMentioned;
    let chatHistoryContext: string | undefined;

    if (isPassiveModeTrigger) {
      chatHistoryContext = await this.getChatHistoryContext(chat_id);
      logger.debug(
        { messageId: message_id, chatId: chat_id, historyLength: chatHistoryContext?.length },
        'Including chat history context for passive mode trigger'
      );
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
      metadata: chatHistoryContext ? { chatHistoryContext } : undefined,
    });
  }

  /**
   * Get formatted chat history context for passive mode.
   * Issue #517: Include recent chat history when bot is mentioned in group chats.
   *
   * @param chatId - Chat ID to get history for
   * @returns Formatted chat history string, or undefined if no history
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
   * Handle P2P chat entered event.
   * Triggered when a user starts a private chat with the bot.
   * Issue #463: Send welcome message on first private chat.
   */
  private async handleP2PChatEntered(data: FeishuP2PChatEnteredEventData): Promise<void> {
    if (!this.isRunning || !this.welcomeService) {
      return;
    }

    const { event } = data;
    if (!event?.user?.open_id) {
      logger.debug('P2P chat entered event missing user info');
      return;
    }

    const userId = event.user.open_id;
    logger.info({ userId }, 'P2P chat entered, sending welcome message');

    await this.welcomeService.handleP2PChatEntered(userId);
  }

  /**
   * Handle chat member added event.
   * Triggered when members are added to a chat.
   * Issue #463: Send welcome message when new members join a group.
   */
  private async handleChatMemberAdded(data: FeishuChatMemberAddedEventData): Promise<void> {
    if (!this.isRunning || !this.welcomeService) {
      return;
    }

    const { event } = data;
    if (!event?.chat_id || !event?.members || event.members.length === 0) {
      logger.debug('Chat member added event missing required fields');
      return;
    }

    // Only send welcome to group chats
    if (!this.isGroupChat(event.chat_id)) {
      logger.debug({ chatId: event.chat_id }, 'Member added to non-group chat, skipping welcome');
      return;
    }

    logger.info({ chatId: event.chat_id, memberCount: event.members.length }, 'New members joined group, sending welcome message');

    await this.welcomeService.handleBotAddedToGroup(event.chat_id);
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
}
