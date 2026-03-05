/**
 * Message Handler.
 *
 * Handles incoming Feishu message events.
 * Extracted from feishu-channel.ts for Issue #694.
 */

import { createLogger } from '../../utils/logger.js';
import { DEDUPLICATION } from '../../config/constants.js';
import { stripLeadingMentions } from '../../utils/mention-parser.js';
import { getCommandRegistry } from '../../nodes/commands/command-registry.js';
import { messageLogger } from '../../feishu/message-logger.js';
import { attachmentManager } from '../../file-transfer/inbound/index.js';
import type { FeishuFileHandler } from '../../platforms/feishu/feishu-file-handler.js';
import type { FeishuEventData, FeishuMessageEvent } from '../../types/platform.js';
import type { FilterReason } from '../../config/types.js';
import type { PassiveModeManager } from './passive-mode.js';
import type { MentionDetector } from './mention-detector.js';
import type { IncomingMessage, ControlCommand, ControlResponse, ControlCommandType } from '../types.js';

const logger = createLogger('MessageHandler');

/**
 * FeishuMessageHandlerDeps - Dependencies for message handler.
 */
export interface FeishuMessageHandlerDeps {
  /** Check if channel is running */
  isRunning: () => boolean;
  /** Get or create the lark client */
  getClient: () => unknown;
  /** Extract open_id from sender */
  extractOpenId: (sender?: { sender_type?: string; sender_id?: unknown }) => string | undefined;
  /** Add typing reaction */
  addTypingReaction: (messageId: string) => Promise<void>;
  /** Send a message */
  sendMessage: (message: { chatId: string; type: string; text?: string; card?: unknown; threadId?: string }) => Promise<void>;
  /** Emit an incoming message */
  emitMessage: (message: IncomingMessage) => Promise<void>;
  /** Emit a control command */
  emitControl: (control: ControlCommand) => Promise<ControlResponse>;
  /** Forward filtered message to debug chat */
  forwardFilteredMessage: (
    reason: FilterReason,
    messageId: string,
    chatId: string,
    content: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ) => Promise<void>;
  /** Get chat history context */
  getChatHistoryContext: (chatId: string) => Promise<string | undefined>;
  /** Check if it's a group chat */
  isGroupChat: (chatType?: string) => boolean;
  /** Passive mode manager */
  passiveModeManager: PassiveModeManager;
  /** Mention detector */
  mentionDetector: MentionDetector;
  /** File handler */
  fileHandler: FeishuFileHandler;
  /** Get control handler */
  getControlHandler: () => unknown;
}

/**
 * FeishuMessageHandler - Handles incoming Feishu message events.
 */
export class FeishuMessageHandler {
  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  constructor(private readonly deps: FeishuMessageHandlerDeps) {}

  /**
   * Handle incoming message event from WebSocket.
   */
  async handleMessageReceive(data: FeishuEventData): Promise<void> {
    if (!this.deps.isRunning()) {
      return;
    }

    this.deps.getClient();

    const event = (data.event || data) as FeishuMessageEvent;
    const { message, sender } = event;

    if (!message) {
      return;
    }

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
      await this.deps.forwardFilteredMessage('duplicate', message_id, chat_id, content, this.deps.extractOpenId(sender));
      return;
    }

    // Ignore bot messages
    if (sender?.sender_type === 'app') {
      logger.debug('Skipped bot message');
      await this.deps.forwardFilteredMessage('bot', message_id, chat_id, content);
      return;
    }

    // Check message age
    if (create_time) {
      const messageAge = Date.now() - create_time;
      if (messageAge > this.MAX_MESSAGE_AGE) {
        logger.debug({ messageId: message_id }, 'Skipped old message');
        await this.deps.forwardFilteredMessage('old', message_id, chat_id, content, this.deps.extractOpenId(sender), { age: messageAge });
        return;
      }
    }

    // Handle file/image messages
    if (message_type === 'image' || message_type === 'file' || message_type === 'media') {
      await this.handleFileMessage(message_id, chat_id, message_type, content, threadId, sender, create_time);
      return;
    }

    // Handle text and post messages
    if (message_type !== 'text' && message_type !== 'post') {
      logger.debug({ messageType: message_type }, 'Skipped unsupported message type');
      await this.deps.forwardFilteredMessage('unsupported', message_id, chat_id, content, this.deps.extractOpenId(sender), { messageType: message_type });
      return;
    }

    // Parse content
    const text = this.parseMessageContent(content, message_type);
    if (!text) {
      logger.debug('Skipped empty text');
      await this.deps.forwardFilteredMessage('empty', message_id, chat_id, content, this.deps.extractOpenId(sender));
      return;
    }

    logger.info({ messageId: message_id, chatId: chat_id }, 'Message received');

    // Log message
    await messageLogger.logIncomingMessage(
      message_id,
      this.deps.extractOpenId(sender) || 'unknown',
      chat_id,
      text,
      message_type,
      create_time
    );

    // Process the text message
    await this.processTextMessage(
      message_id,
      chat_id,
      chat_type,
      text,
      message_type,
      create_time,
      mentions,
      threadId,
      sender
    );
  }

  /**
   * Parse message content based on message type.
   */
  private parseMessageContent(content: string, messageType: string): string {
    try {
      const parsed = JSON.parse(content);
      if (messageType === 'text') {
        return parsed.text?.trim() || '';
      } else if (messageType === 'post' && parsed.content && Array.isArray(parsed.content)) {
        let text = '';
        for (const row of parsed.content) {
          if (Array.isArray(row)) {
            for (const segment of row) {
              if (segment?.tag === 'text' && segment.text) {
                text += segment.text;
              }
            }
          }
        }
        return text.trim();
      }
    } catch {
      logger.error('Failed to parse content');
    }
    return '';
  }

  /**
   * Handle file/image messages.
   */
  private async handleFileMessage(
    messageId: string,
    chatId: string,
    messageType: 'image' | 'file' | 'media',
    content: string,
    threadId: string,
    sender?: { sender_type?: string; sender_id?: unknown },
    createTime?: number
  ): Promise<void> {
    logger.info(
      { chatId, messageType, messageId },
      'Processing file/image message'
    );

    const result = await this.deps.fileHandler.handleFileMessage(chatId, messageType, content, messageId);
    if (!result.success) {
      logger.error(
        { chatId, messageType, messageId, error: result.error },
        'File/image processing failed - detailed error'
      );
      await this.deps.sendMessage({
        chatId,
        type: 'text',
        text: `❌ 处理${messageType === 'image' ? '图片' : '文件'}失败: ${result.error || '未知错误'}`,
      });
      return;
    }

    const attachments = attachmentManager.getAttachments(chatId);
    if (attachments.length > 0) {
      const latestAttachment = attachments[attachments.length - 1];
      const uploadPrompt = this.deps.fileHandler.buildUploadPrompt(latestAttachment);

      await messageLogger.logIncomingMessage(
        messageId,
        this.deps.extractOpenId(sender) || 'unknown',
        chatId,
        `[File uploaded: ${latestAttachment.fileName}]`,
        messageType,
        createTime
      );

      // Emit as incoming message
      await this.deps.emitMessage({
        messageId: `${messageId}-file`,
        chatId,
        userId: this.deps.extractOpenId(sender),
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
   * Process text message.
   */
  private async processTextMessage(
    messageId: string,
    chatId: string,
    chatType?: string,
    text?: string,
    messageType?: 'text' | 'image' | 'file' | 'media' | 'post' | 'card',
    createTime?: number,
    mentions?: FeishuMessageEvent['message']['mentions'],
    threadId?: string,
    sender?: { sender_type?: string; sender_id?: unknown }
  ): Promise<void> {
    if (!text) {
      return;
    }

    // Check for control commands
    const botMentioned = this.deps.mentionDetector.isBotMentioned(mentions);

    // Get control commands from CommandRegistry
    const commandRegistry = getCommandRegistry();

    // Strip leading mentions to detect commands in messages like "@bot /help"
    const textWithoutMentions = stripLeadingMentions(text, mentions);

    // Issue #460 & #511: Group chat passive mode
    const isPassiveCommand = textWithoutMentions.startsWith('/passive');
    const passiveModeDisabled = this.deps.passiveModeManager.isDisabled(chatId);
    if (this.deps.isGroupChat(chatType) && !botMentioned && !passiveModeDisabled && !isPassiveCommand) {
      logger.debug(
        { messageId, chatId, chat_type: chatType },
        'Skipped group chat message without @mention (passive mode)'
      );
      await this.deps.forwardFilteredMessage('passive_mode', messageId, chatId, text, this.deps.extractOpenId(sender), { chat_type: chatType });
      return;
    }

    // Handle commands
    if (textWithoutMentions.startsWith('/')) {
      const handled = await this.handleCommand(
        messageId,
        chatId,
        textWithoutMentions,
        botMentioned,
        commandRegistry
      );
      if (handled) {
        return;
      }
    }

    // Log if bot is mentioned with a non-control command
    if (botMentioned && textWithoutMentions.startsWith('/')) {
      logger.debug({ messageId, chatId, command: textWithoutMentions }, 'Bot mentioned with non-control command, passing to agent');
    }

    // Add typing reaction for messages that will be processed
    await this.deps.addTypingReaction(messageId);

    // Get chat history context for passive mode trigger
    const isPassiveModeTrigger = this.deps.isGroupChat(chatType) && botMentioned;
    let chatHistoryContext: string | undefined;

    if (isPassiveModeTrigger) {
      chatHistoryContext = await this.deps.getChatHistoryContext(chatId);
      logger.debug(
        { messageId, chatId, historyLength: chatHistoryContext?.length },
        'Including chat history context for passive mode trigger'
      );
    }

    // Emit as incoming message
    await this.deps.emitMessage({
      messageId,
      chatId,
      userId: this.deps.extractOpenId(sender),
      content: text,
      messageType: messageType || 'text',
      timestamp: createTime,
      threadId,
      metadata: chatHistoryContext ? { chatHistoryContext } : undefined,
    });
  }

  /**
   * Handle command messages.
   * @returns true if command was handled
   */
  private async handleCommand(
    _messageId: string,
    chatId: string,
    textWithoutMentions: string,
    botMentioned: boolean,
    commandRegistry: ReturnType<typeof getCommandRegistry>
  ): Promise<boolean> {
    const [command, ...args] = textWithoutMentions.slice(1).split(/\s+/);
    const cmd = command.toLowerCase();

    const isControlCommand = commandRegistry.has(cmd);

    if (isControlCommand || !botMentioned) {
      if (this.deps.getControlHandler()) {
        const response = await this.deps.emitControl({
          type: cmd as ControlCommandType,
          chatId,
          data: { args, rawText: textWithoutMentions },
        });

        if (response.success) {
          if (response.message) {
            await this.deps.sendMessage({
              chatId,
              type: 'text',
              text: response.message,
            });
          }
          return true;
        }

        // Without @mention: unknown commands fall through to agent
        // With @mention: show error instead of passing to agent (Issue #595)
        if (botMentioned) {
          await this.deps.sendMessage({
            chatId,
            type: 'text',
            text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
          });
          return true;
        }
      }

      // Default command handling if no control handler registered
      if (cmd === 'reset') {
        await this.deps.sendMessage({
          chatId,
          type: 'text',
          text: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。',
        });
        return true;
      }

      if (cmd === 'status') {
        await this.deps.sendMessage({
          chatId,
          type: 'text',
          text: `📊 **状态**\n\nChannel: Feishu\nStatus: running`,
        });
        return true;
      }
    } else {
      // Unknown command with @mention: show error instead of passing to agent
      await this.deps.sendMessage({
        chatId,
        type: 'text',
        text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
      });
      return true;
    }

    return false;
  }
}
