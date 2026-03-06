/**
 * Message Handler for Feishu Channel.
 *
 * Handles incoming message events from WebSocket.
 *
 * Issue #694: Extracted from feishu-channel.ts
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import { DEDUPLICATION } from '../../config/constants.js';
import { createLogger } from '../../utils/logger.js';
import { attachmentManager } from '../../file-transfer/inbound/index.js';
import { messageLogger } from '../../feishu/message-logger.js';
import { FeishuFileHandler } from '../../platforms/feishu/feishu-file-handler.js';
import { getCommandRegistry } from '../../nodes/commands/command-registry.js';
import { filteredMessageForwarder } from '../../feishu/filtered-message-forwarder.js';
import type { FilterReason } from '../../config/types.js';
import { stripLeadingMentions } from '../../utils/mention-parser.js';
import type {
  FeishuEventData,
  FeishuMessageEvent,
} from '../../types/platform.js';
import type { MentionDetector } from './mention-detector.js';
import type { PassiveModeManager } from './passive-mode.js';
import { CHAT_HISTORY } from '../../config/constants.js';

const logger = createLogger('FeishuMessageHandler');

/**
 * Message context passed to the handler.
 */
export interface FeishuMessageHandlerContext {
  client: lark.Client;
  fileHandler: FeishuFileHandler;
  mentionDetector: MentionDetector;
  passiveModeManager: PassiveModeManager;
  appId: string;
  addTypingReaction: (messageId: string) => Promise<void>;
  sendMessage: (msg: { chatId: string; type: string; text?: string; card?: Record<string, unknown>; description?: string; filePath?: string }) => Promise<void>;
  emitMessage: (msg: {
    messageId: string;
    chatId: string;
    userId?: string;
    content: string;
    messageType: string;
    timestamp?: number;
    threadId?: string;
    metadata?: Record<string, unknown>;
    attachments?: Array<{ fileName: string; filePath: string; mimeType?: string }>;
  }) => Promise<void>;
  emitControl: (ctrl: { type: string; chatId: string; data: Record<string, unknown> }) => Promise<{ success: boolean; message?: string }>;
  controlHandler: unknown;
}

/**
 * Feishu Message Handler - Handles incoming Feishu message events.
 */
export class FeishuMessageHandler {
  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  /**
   * Handle incoming message event from WebSocket.
   */
  async handleMessageReceive(
    data: FeishuEventData,
    ctx: FeishuMessageHandlerContext
  ): Promise<void> {
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
      await this.handleFileMessage(ctx, message_id, chat_id, message_type as 'image' | 'file' | 'media', content, sender, create_time, threadId);
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

    // Process the text message
    await this.processTextMessage(ctx, message_id, chat_id, chat_type, text, sender, create_time, threadId, mentions);
  }

  /**
   * Handle file/image message.
   */
  private async handleFileMessage(
    ctx: FeishuMessageHandlerContext,
    messageId: string,
    chatId: string,
    messageType: 'image' | 'file' | 'media',
    content: string,
    sender: FeishuMessageEvent['sender'],
    createTime: number | undefined,
    threadId: string
  ): Promise<void> {
    logger.info(
      { chatId, messageType, messageId },
      'Processing file/image message'
    );
    const result = await ctx.fileHandler.handleFileMessage(chatId, messageType, content, messageId);
    if (!result.success) {
      logger.error(
        { chatId, messageType, messageId, error: result.error },
        'File/image processing failed - detailed error'
      );
      await ctx.sendMessage({
        chatId,
        type: 'text',
        text: `❌ 处理${messageType === 'image' ? '图片' : '文件'}失败: ${result.error || '未知错误'}`,
      });
      return;
    }

    const attachments = attachmentManager.getAttachments(chatId);
    if (attachments.length > 0) {
      const latestAttachment = attachments[attachments.length - 1];
      const uploadPrompt = ctx.fileHandler.buildUploadPrompt(latestAttachment);

      await messageLogger.logIncomingMessage(
        messageId,
        this.extractOpenId(sender) || 'unknown',
        chatId,
        `[File uploaded: ${latestAttachment.fileName}]`,
        messageType,
        createTime
      );

      // Emit as incoming message
      await ctx.emitMessage({
        messageId: `${messageId}-file`,
        chatId,
        userId: this.extractOpenId(sender),
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
    ctx: FeishuMessageHandlerContext,
    messageId: string,
    chatId: string,
    chatType: string | undefined,
    text: string,
    sender: FeishuMessageEvent['sender'],
    createTime: number | undefined,
    threadId: string,
    mentions: FeishuMessageEvent['message']['mentions']
  ): Promise<void> {
    // Check for control commands
    const botMentioned = ctx.mentionDetector.isBotMentioned(mentions);

    // Get control commands from CommandRegistry
    const commandRegistry = getCommandRegistry();

    // Strip leading mentions to detect commands in messages like "@bot /help"
    const textWithoutMentions = stripLeadingMentions(text, mentions);

    // Group chat passive mode check
    const isPassiveCommand = textWithoutMentions.startsWith('/passive');
    const passiveModeDisabled = ctx.passiveModeManager.isDisabled(chatId);
    if (this.isGroupChat(chatType) && !botMentioned && !passiveModeDisabled && !isPassiveCommand) {
      logger.debug(
        { messageId, chatId, chat_type: chatType },
        'Skipped group chat message without @mention (passive mode)'
      );
      await this.forwardFilteredMessage('passive_mode', messageId, chatId, text, this.extractOpenId(sender), { chat_type: chatType });
      return;
    }

    if (textWithoutMentions.startsWith('/')) {
      const handled = await this.handleCommand(ctx, chatId, textWithoutMentions, botMentioned, sender, commandRegistry);
      if (handled) {
        return;
      }
    }

    // Log if bot is mentioned with a non-control command (for debugging)
    if (botMentioned && textWithoutMentions.startsWith('/')) {
      logger.debug({ messageId, chatId, command: textWithoutMentions }, 'Bot mentioned with non-control command, passing to agent');
    }

    // Add typing reaction only for messages that will be processed
    await ctx.addTypingReaction(messageId);

    // Get chat history context for passive mode
    const isPassiveModeTrigger = this.isGroupChat(chatType) && botMentioned;
    let chatHistoryContext: string | undefined;

    if (isPassiveModeTrigger) {
      chatHistoryContext = await this.getChatHistoryContext(chatId);
      logger.debug(
        { messageId, chatId, historyLength: chatHistoryContext?.length },
        'Including chat history context for passive mode trigger'
      );
    }

    // Emit as incoming message
    await ctx.emitMessage({
      messageId,
      chatId,
      userId: this.extractOpenId(sender),
      content: text,
      messageType: 'text',
      timestamp: createTime,
      threadId,
      metadata: chatHistoryContext ? { chatHistoryContext } : undefined,
    });
  }

  /**
   * Handle command messages.
   * @returns true if command was handled and processing should stop
   */
  private async handleCommand(
    ctx: FeishuMessageHandlerContext,
    chatId: string,
    textWithoutMentions: string,
    botMentioned: boolean,
    sender: FeishuMessageEvent['sender'],
    commandRegistry: ReturnType<typeof getCommandRegistry>
  ): Promise<boolean> {
    const [command, ...args] = textWithoutMentions.slice(1).split(/\s+/);
    const cmd = command.toLowerCase();

    const isControlCommand = commandRegistry.has(cmd);

    if (isControlCommand || !botMentioned) {
      if (ctx.controlHandler) {
        const response = await ctx.emitControl({
          type: cmd as any,
          chatId,
          data: { args, rawText: textWithoutMentions, senderOpenId: this.extractOpenId(sender) },
        });

        if (response.success) {
          if (response.message) {
            await ctx.sendMessage({
              chatId,
              type: 'text',
              text: response.message,
            });
          }
          return true;
        }

        if (botMentioned) {
          await ctx.sendMessage({
            chatId,
            type: 'text',
            text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
          });
          return true;
        }
      }

      // Default command handling if no control handler registered
      if (cmd === 'reset') {
        await ctx.sendMessage({
          chatId,
          type: 'text',
          text: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。',
        });
        return true;
      }

      if (cmd === 'status') {
        await ctx.sendMessage({
          chatId,
          type: 'text',
          text: `📊 **状态**\n\nChannel: Feishu\nStatus: running`,
        });
        return true;
      }
    } else {
      // Unknown command with @mention: show error instead of passing to agent
      await ctx.sendMessage({
        chatId,
        type: 'text',
        text: `❓ **未知命令**: /${cmd}\n\n使用 /help 查看可用命令列表。`,
      });
      return true;
    }

    return false;
  }

  /**
   * Forward a filtered message to the debug chat.
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
   * Check if the chat is a group chat.
   */
  private isGroupChat(chatType?: string): boolean {
    return chatType === 'group' || chatType === 'topic';
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
   * Get formatted chat history context for passive mode.
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
}
