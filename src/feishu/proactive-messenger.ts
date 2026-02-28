/**
 * Proactive Messenger - Send messages without user trigger.
 *
 * Enables the bot to send messages to registered chats without
 * receiving a message first. Used by scheduled tasks and other
 * automated processes.
 */

import * as lark from '@larksuiteoapi/node-sdk';
import type { Logger } from 'pino';
import { chatRegistry, type ChatInfo } from './chat-registry.js';
import { createLogger } from '../utils/logger.js';
import { buildTextContent } from '../platforms/feishu/card-builders/content-builder.js';

const logger = createLogger('ProactiveMessenger');

/**
 * Recommendation for scheduled task.
 */
export interface Recommendation {
  /** Task type */
  taskType: string;
  /** Detected pattern description */
  pattern: string;
  /** Recommended cron expression */
  suggestedCron: string;
  /** Confidence level */
  confidence: 'High' | 'Medium' | 'Low';
  /** Number of occurrences */
  occurrenceCount: number;
  /** Suggested prompt for the scheduled task */
  suggestedPrompt: string;
}

/**
 * Proactive Messenger Configuration.
 */
export interface ProactiveMessengerConfig {
  /** Feishu API client */
  client: lark.Client;
  /** Logger instance (optional) */
  logger?: Logger;
}

/**
 * Proactive Messenger - Send messages without user trigger.
 *
 * Usage:
 * ```typescript
 * const messenger = new ProactiveMessenger({ client });
 *
 * // Send a text message to a specific chat
 * await messenger.sendMessage('oc_xxx', 'Hello from scheduled task!');
 *
 * // Send a recommendation card
 * await messenger.sendRecommendation('oc_xxx', recommendation);
 *
 * // Broadcast to all enabled chats
 * await messenger.broadcast('Daily report: ...');
 * ```
 */
export class ProactiveMessenger {
  private client: lark.Client;

  constructor(config: ProactiveMessengerConfig) {
    this.client = config.client;
  }

  /**
   * Send a text message to a specific chat.
   *
   * @param chatId - Target chat ID
   * @param content - Text content to send
   * @returns true if message was sent successfully
   */
  async sendMessage(chatId: string, content: string): Promise<boolean> {
    try {
      await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: buildTextContent(content),
        },
      });

      logger.info({ chatId }, 'Proactive message sent');
      return true;
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to send proactive message');
      return false;
    }
  }

  /**
   * Send a recommendation card to a specific chat.
   *
   * @param chatId - Target chat ID
   * @param recommendation - Recommendation details
   * @returns true if card was sent successfully
   */
  async sendRecommendation(chatId: string, recommendation: Recommendation): Promise<boolean> {
    try {
      const card = this.buildRecommendationCard(recommendation);

      await this.client.im.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      logger.info({ chatId, taskType: recommendation.taskType }, 'Recommendation card sent');
      return true;
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to send recommendation card');
      return false;
    }
  }

  /**
   * Broadcast a message to all enabled chats.
   *
   * @param content - Text content to broadcast
   * @returns Number of successful sends
   */
  async broadcast(content: string): Promise<number> {
    const chats = await chatRegistry.getEnabledChats();
    let successCount = 0;

    for (const chat of chats) {
      const success = await this.sendMessage(chat.chatId, content);
      if (success) {
        successCount++;
      }
    }

    logger.info({ total: chats.length, success: successCount }, 'Broadcast completed');
    return successCount;
  }

  /**
   * Build an interactive card for a recommendation.
   *
   * @param recommendation - Recommendation details
   * @returns Interactive card object
   */
  private buildRecommendationCard(recommendation: Recommendation): Record<string, unknown> {
    const confidenceEmoji = {
      High: '🟢',
      Medium: '🟡',
      Low: '🔴',
    };

    return {
      config: {
        wide_screen_mode: true,
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `## 💡 定时任务推荐\n\n**任务类型**: ${recommendation.taskType}\n**检测到的模式**: ${recommendation.pattern}\n**建议时间**: ${recommendation.suggestedCron}\n**置信度**: ${confidenceEmoji[recommendation.confidence]} ${recommendation.confidence}\n**出现次数**: ${recommendation.occurrenceCount}`,
          },
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**建议的定时任务内容**:\n\`\`\`\n${recommendation.suggestedPrompt}\n\`\`\``,
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '✅ 创建定时任务',
              },
              type: 'primary',
              value: {
                action: 'create_schedule',
                prompt: recommendation.suggestedPrompt,
                cron: recommendation.suggestedCron,
              },
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '❌ 忽略',
              },
              type: 'default',
              value: {
                action: 'ignore',
              },
            },
          ],
        },
      ],
    };
  }

  /**
   * Get all enabled chats for proactive messaging.
   *
   * @returns Array of enabled chat info
   */
  getEnabledChats(): Promise<ChatInfo[]> {
    return chatRegistry.getEnabledChats();
  }

  /**
   * Register a chat for proactive messaging.
   *
   * @param chatId - Chat ID to register
   * @param options - Optional metadata
   */
  async registerChat(
    chatId: string,
    options?: { userId?: string; chatName?: string }
  ): Promise<void> {
    await chatRegistry.register(chatId, options);
    logger.info({ chatId }, 'Chat registered for proactive messaging');
  }
}

/**
 * Create a ProactiveMessenger instance.
 *
 * @param client - Feishu API client
 * @returns ProactiveMessenger instance
 */
export function createProactiveMessenger(client: lark.Client): ProactiveMessenger {
  return new ProactiveMessenger({ client });
}
