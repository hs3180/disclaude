/**
 * Message Handler.
 *
 * Handles incoming message events and card actions for Feishu channel.
 * Issue #694: Extracted from feishu-channel.ts
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import type * as lark from '@larksuiteoapi/node-sdk';
import {
  DEDUPLICATION,
  REACTIONS,
  CHAT_HISTORY,
  createLogger,
  stripLeadingMentions,
  type FeishuEventData,
  type FeishuMessageEvent,
  type FeishuCardActionEvent,
  type FeishuCardActionEventData,
  type IncomingMessage,
  type ControlCommand,
  type ControlResponse,
} from '@disclaude/core';
import { InteractionManager } from '../../platforms/feishu/interaction-manager.js';
import { messageLogger } from './message-logger.js';
import type { PassiveModeManager } from './passive-mode.js';
import type { MentionDetector } from './mention-detector.js';

const logger = createLogger('MessageHandler');

/**
 * Callback interface for emitting messages and control events.
 */
export interface MessageCallbacks {
  emitMessage: (message: IncomingMessage) => Promise<void>;
  emitControl: (control: ControlCommand) => Promise<ControlResponse>;
  sendMessage: (message: { chatId: string; type: string; text?: string; card?: Record<string, unknown>; description?: string; threadId?: string; filePath?: string }) => Promise<void>;
  /**
   * Route card action to Worker Node if applicable.
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
 * Message Handler.
 *
 * Handles incoming Feishu messages and card actions.
 */
export class MessageHandler {
  private client?: lark.Client;
  private interactionManager: InteractionManager;
  private passiveModeManager: PassiveModeManager;
  private mentionDetector: MentionDetector;
  private callbacks: MessageCallbacks;
  private isRunning: () => boolean;
  private controlHandler: boolean;
  private getHasControlHandler: () => boolean;

  private readonly MAX_MESSAGE_AGE = DEDUPLICATION.MAX_MESSAGE_AGE;

  /**
   * Create a MessageHandler.
   */
  constructor(options: {
    passiveModeManager: PassiveModeManager;
    mentionDetector: MentionDetector;
    interactionManager: InteractionManager;
    callbacks: MessageCallbacks;
    isRunning: () => boolean;
    hasControlHandler: () => boolean;
  }) {
    this.passiveModeManager = options.passiveModeManager;
    this.mentionDetector = options.mentionDetector;
    this.interactionManager = options.interactionManager;
    this.callbacks = options.callbacks;
    this.isRunning = options.isRunning;
    this.getHasControlHandler = options.hasControlHandler;
    this.controlHandler = false;
  }

  /**
   * Initialize the handler with client.
   */
  initialize(client: lark.Client): void {
    this.client = client;
    this.controlHandler = this.getHasControlHandler();
    logger.debug({ controlHandler: this.controlHandler }, 'MessageHandler initialized');
  }

  /**
   * Set whether control handler is available.
   */
  setControlHandler(hasHandler: boolean): void {
    this.controlHandler = hasHandler;
  }

  /**
   * Get the client (for external use).
   */
  getClient(): lark.Client | undefined {
    return this.client;
  }

  /**
   * Clear the client (on stop).
   */
  clearClient(): void {
    this.client = undefined;
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
    if (!this.client) {
      return;
    }
    try {
      await this.client.im.messageReaction.create({
        path: {
          message_id: messageId,
        },
        data: {
          reaction_type: {
            emoji_type: REACTIONS.TYPING,
          },
        },
      });
    } catch (error) {
      logger.debug({ err: error, messageId }, 'Failed to add typing reaction');
    }
  }

  /**
   * Check if the chat is a group chat.
   */
  private isGroupChat(chatType?: string): boolean {
    return chatType === 'group' || chatType === 'topic';
  }

  /**
   * Forward a filtered message (simplified - just logs for now).
   */
  private async forwardFilteredMessage(
    reason: string,
    messageId: string,
    chatId: string,
    _content: string,
    userId?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    logger.debug({ reason, messageId, chatId, userId, metadata }, 'Message filtered');
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

      // Truncate if too long
      let history = rawHistory;
      if (history.length > CHAT_HISTORY.MAX_CONTEXT_LENGTH) {
        const truncatePoint = history.lastIndexOf('## [', history.length - CHAT_HISTORY.MAX_CONTEXT_LENGTH);
        if (truncatePoint > 0) {
          history = `...(earlier messages truncated)...\n\n${history.slice(truncatePoint)}`;
        } else {
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
   * Get quoted/replied message content.
   */
  private async getQuotedMessageContext(parentId: string): Promise<string | undefined> {
    if (!this.client) {
      return undefined;
    }

    try {
      const response = await this.client.im.message.get({
        path: {
          message_id: parentId,
        },
        params: {
          user_id_type: 'open_id',
        },
      });

      const message = response.data as { message?: { message_type?: string; content?: string } };
      if (!message?.message) {
        return undefined;
      }

      let quotedText = '';
      try {
        if (message.message.message_type === 'text') {
          const parsed = JSON.parse(message.message.content || '{}');
          quotedText = parsed.text || message.message.content || '';
        } else if (message.message.message_type === 'post') {
          const parsed = JSON.parse(message.message.content || '{}');
          if (parsed.content && Array.isArray(parsed.content)) {
            for (const row of parsed.content) {
              if (Array.isArray(row)) {
                for (const segment of row) {
                  if (segment?.tag === 'text' && segment.text) {
                    quotedText += segment.text;
                  }
                }
              }
            }
          }
        }
      } catch {
        quotedText = message.message.content || '';
      }

      if (!quotedText.trim()) {
        return undefined;
      }

      return `> **引用的消息**:\n> ${quotedText.split('\n').join('\n> ')}`;
    } catch (error) {
      logger.debug({ err: error, parentId }, 'Failed to get quoted message context');
      return undefined;
    }
  }

  /**
   * Handle incoming message event from WebSocket.
   */
  async handleMessageReceive(data: FeishuEventData): Promise<void> {
    if (!this.isRunning()) {
      return;
    }

    const event = (data.event || data) as FeishuMessageEvent;
    const { message, sender } = event;

    if (!message) {
      return;
    }

    const { message_id, chat_id, chat_type, content, message_type, create_time, mentions, parent_id } = message;
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

    // Handle file/image messages (simplified)
    if (message_type === 'image' || message_type === 'file' || message_type === 'media') {
      logger.info({ chatId: chat_id, messageType: message_type, messageId: message_id }, 'File/image message received');
      // For now, just acknowledge the file and emit a message
      await messageLogger.logIncomingMessage(
        message_id,
        this.extractOpenId(sender) || 'unknown',
        chat_id,
        `[${message_type} received]`,
        message_type,
        create_time
      );

      await this.addTypingReaction(message_id);

      await this.callbacks.emitMessage({
        messageId: `${message_id}-file`,
        chatId: chat_id,
        userId: this.extractOpenId(sender),
        content: `用户上传了一个${message_type === 'image' ? '图片' : '文件'}。`,
        messageType: 'file',
        timestamp: create_time,
        threadId,
      });
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
    const botMentioned = this.mentionDetector.isBotMentioned(mentions);
    const textWithoutMentions = stripLeadingMentions(text, mentions);

    // Group chat passive mode
    const isPassiveCommand = textWithoutMentions.startsWith('/passive');
    const passiveModeDisabled = this.passiveModeManager.isPassiveModeDisabled(chat_id);
    if (this.isGroupChat(chat_type) && !botMentioned && !passiveModeDisabled && !isPassiveCommand) {
      logger.debug({ messageId: message_id, chatId: chat_id, chat_type }, 'Skipped group chat message without @mention (passive mode)');
      await this.forwardFilteredMessage('passive_mode', message_id, chat_id, text, this.extractOpenId(sender), { chat_type });
      return;
    }

    // Add typing reaction
    await this.addTypingReaction(message_id);

    // Handle commands
    if (textWithoutMentions.startsWith('/')) {
      const [command, ...args] = textWithoutMentions.slice(1).split(/\s+/);
      const cmd = command.toLowerCase();

      if (this.controlHandler) {
        const response = await this.callbacks.emitControl({
          type: cmd as 'reset' | 'status' | 'passive',
          chatId: chat_id,
          data: { args, rawText: textWithoutMentions, senderOpenId: this.extractOpenId(sender) },
        });

        if (response.success) {
          if (response.message) {
            await this.callbacks.sendMessage({
              chatId: chat_id,
              type: 'text',
              text: response.message,
            });
          }
          return;
        }
      }

      // Default command handling
      if (cmd === 'reset') {
        await this.callbacks.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: '✅ **对话已重置**\n\n新的会话已启动，之前的上下文已清除。',
        });
        return;
      }

      if (cmd === 'status') {
        await this.callbacks.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: '📊 **状态**\n\nChannel: Feishu\nStatus: running',
        });
        return;
      }

      if (cmd === 'passive') {
        if (args[0] === 'off') {
          this.passiveModeManager.setPassiveModeDisabled(chat_id, true);
          await this.callbacks.sendMessage({
            chatId: chat_id,
            type: 'text',
            text: '✅ 已禁用被动模式，机器人将回复所有消息。',
          });
        } else if (args[0] === 'on') {
          this.passiveModeManager.setPassiveModeDisabled(chat_id, false);
          await this.callbacks.sendMessage({
            chatId: chat_id,
            type: 'text',
            text: '✅ 已启用被动模式，机器人仅在被 @ 时回复。',
          });
        } else {
          await this.callbacks.sendMessage({
            chatId: chat_id,
            type: 'text',
            text: '用法: /passive on|off',
          });
        }
        return;
      }
    }

    // Get quoted/replied message context if this is a reply
    let quotedMessageContext: string | undefined;
    if (parent_id) {
      quotedMessageContext = await this.getQuotedMessageContext(parent_id);
    }

    // Get chat history context for passive mode
    const isPassiveModeTrigger = this.isGroupChat(chat_type) && botMentioned;
    let chatHistoryContext: string | undefined;

    if (isPassiveModeTrigger) {
      chatHistoryContext = await this.getChatHistoryContext(chat_id);
    }

    // Build metadata
    const metadata: Record<string, unknown> = {};
    if (quotedMessageContext) {
      metadata.quotedMessage = quotedMessageContext;
    }
    if (chatHistoryContext) {
      metadata.chatHistoryContext = chatHistoryContext;
    }

    // Emit as incoming message
    await this.callbacks.emitMessage({
      messageId: message_id,
      chatId: chat_id,
      userId: this.extractOpenId(sender),
      content: text,
      messageType: message_type,
      timestamp: create_time,
      threadId,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }

  /**
   * Handle card action event from WebSocket.
   */
  async handleCardAction(data: FeishuCardActionEventData): Promise<void> {
    if (!this.isRunning()) {
      return;
    }

    // Parse actual Feishu event structure
    const rawData = data as Record<string, unknown>;
    const context = rawData.context as { open_message_id?: string; open_chat_id?: string } | undefined;
    const operator = rawData.operator as { open_id?: string; user_id?: string; union_id?: string } | undefined;
    const actionData = rawData.action as { value?: string; tag?: string; type?: string; text?: string } | undefined;

    const message_id = context?.open_message_id;
    const chat_id = context?.open_chat_id;
    const action = actionData ? {
      type: actionData.tag ?? actionData.type ?? '',
      value: actionData.value ?? '',
      trigger: 'button' as const,
      text: actionData.text,
    } : undefined;
    const user = operator ? {
      sender_id: {
        open_id: operator.open_id ?? '',
        user_id: operator.user_id,
        union_id: operator.union_id,
      },
    } : undefined;

    if (!action || !message_id || !chat_id) {
      logger.warn({
        hasAction: !!action,
        hasMessageId: !!message_id,
        hasChatId: !!chat_id,
        eventData: JSON.stringify(data),
      }, 'Missing required card action fields');
      return;
    }

    logger.info(
      {
        messageId: message_id,
        chatId: chat_id,
        actionType: action.type,
        actionValue: action.value,
        userId: user?.sender_id?.open_id,
      },
      'Card action received'
    );

    // Send user-visible confirmation message
    const buttonText = action.text || action.value;
    if (buttonText) {
      try {
        await this.callbacks.sendMessage({
          chatId: chat_id,
          type: 'text',
          text: `✅ 您选择了「${buttonText}」`,
          threadId: message_id,
        });
      } catch (error) {
        logger.warn({ err: error, messageId: message_id, chatId: chat_id }, 'Failed to send user confirmation');
      }
    }

    // Try to route card action to Worker Node first
    if (this.callbacks.routeCardAction) {
      const routed = await this.callbacks.routeCardAction({
        chatId: chat_id,
        cardMessageId: message_id,
        actionType: action.type,
        actionValue: action.value,
        actionText: action.text,
        userId: user?.sender_id?.open_id,
        action: {
          type: action.type,
          value: action.value,
          text: action.text,
          trigger: action.trigger,
        },
      });

      if (routed) {
        logger.debug({ messageId: message_id, chatId: chat_id }, 'Card action routed to Worker Node');
        return;
      }
    }

    // Emit card action as a message to the agent
    try {
      const messageContent = `用户点击了按钮「${buttonText}」`;

      await this.callbacks.emitMessage({
        messageId: `${message_id}-${action.value}`,
        chatId: chat_id,
        userId: user?.sender_id?.open_id,
        content: messageContent,
        messageType: 'card',
        timestamp: Date.now(),
        metadata: {
          cardAction: action,
          cardMessageId: message_id,
        },
      });
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Failed to emit card action message');
    }

    // Try to handle via InteractionManager
    try {
      const compatEvent: FeishuCardActionEvent = {
        action,
        message_id,
        chat_id,
        user: user ?? { sender_id: { open_id: '' } },
        tenant_key: (rawData.tenant_key as string) || '',
      };

      await this.interactionManager.handleAction(compatEvent);
    } catch (error) {
      logger.error({ err: error, messageId: message_id, chatId: chat_id }, 'Card action handler error');

      await this.callbacks.sendMessage({
        chatId: chat_id,
        type: 'text',
        text: `❌ 处理卡片操作时发生错误：${error instanceof Error ? error.message : '未知错误'}`,
      });
    }
  }
}
