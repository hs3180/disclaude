/**
 * Bot Mention Detector.
 *
 * Detects when the bot is mentioned in group chat messages.
 * Issue #600: Correctly identify bot mentions in group chats
 * Issue #681: Improve bot mention detection reliability
 * Issue #694: Extracted from feishu-channel.ts
 */

import { createLogger } from '../../utils/logger.js';
import { createFeishuClient } from '../../platforms/feishu/create-feishu-client.js';
import type { FeishuMessageEvent } from '../../types/platform.js';

const logger = createLogger('MentionDetector');

/**
 * Bot info structure.
 * Based on Feishu official documentation:
 * - bot/v3/info returns bot.open_id and bot.app_id
 * - When bot is mentioned, mentions[].id.open_id may be bot's open_id or app_id
 *
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/bot-v3/bot_info/get
 */
export interface BotInfo {
  open_id: string;
  app_id: string;
}

/**
 * Bot Mention Detector.
 *
 * Fetches bot info from Feishu API and checks if the bot is mentioned in messages.
 */
export class MentionDetector {
  private botInfo?: BotInfo;

  /**
   * Fetch bot's info from Feishu API.
   * This is used to correctly identify when the bot is mentioned.
   */
  async fetchBotInfo(appId: string, appSecret: string): Promise<void> {
    try {
      const client = createFeishuClient(appId, appSecret);
      // Use bot info API to get bot's open_id and app_id
      const response = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      });

      const bot = response.data?.bot;
      if (bot?.open_id) {
        this.botInfo = {
          open_id: bot.open_id,
          app_id: bot.app_id,
        };
        logger.info(
          { botOpenId: bot.open_id, botAppId: bot.app_id },
          'Bot info fetched for mention detection'
        );
      } else {
        logger.warn('Failed to fetch bot info, mention detection may be less accurate');
      }
    } catch (error) {
      logger.warn({ err: error }, 'Failed to fetch bot info, mention detection may be less accurate');
    }
  }

  /**
   * Check if the bot is mentioned in the message.
   * When bot is mentioned, commands should be passed through to the agent.
   *
   * Based on Feishu official documentation:
   * - When bot is mentioned, mentions[].id.open_id may be bot's open_id OR app_id
   * - We need to check both to ensure reliable detection
   *
   * @param mentions - Mentions array from Feishu message
   * @returns true if bot is mentioned
   */
  isBotMentioned(mentions?: FeishuMessageEvent['message']['mentions']): boolean {
    if (!mentions || mentions.length === 0) {
      return false;
    }

    // Log mentions structure for debugging
    logger.debug(
      {
        mentions: JSON.stringify(mentions),
        botInfo: this.botInfo,
      },
      'Checking bot mention'
    );

    // If we have bot info, check if any mention matches bot's open_id OR app_id
    if (this.botInfo) {
      const botOpenId = this.botInfo.open_id;
      const botAppId = this.botInfo.app_id;
      return mentions.some((mention) => {
        const mentionOpenId = mention.id?.open_id || '';
        // Check against both bot's open_id and app_id
        // Feishu may use either when the bot is mentioned
        return (
          mentionOpenId === botOpenId ||
          mentionOpenId === botAppId
        );
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
   * Get the current bot info.
   * Useful for testing and debugging.
   */
  getBotInfo(): BotInfo | undefined {
    return this.botInfo;
  }
}
