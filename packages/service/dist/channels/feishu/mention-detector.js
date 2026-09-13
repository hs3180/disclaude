/**
 * Bot Mention Detector.
 *
 * Detects when the bot is mentioned in group chat messages.
 * Issue #600: Correctly identify bot mentions in group chats
 * Issue #681: Improve bot mention detection reliability
 * Issue #694: Extracted from feishu-channel.ts
 *
 * Migrated to @disclaude/service (Issue #1040)
 */
import { createLogger } from "../../../../core/dist/index.js";
const logger = createLogger('MentionDetector');
/**
 * Bot Mention Detector.
 *
 * Fetches bot info from Feishu API and checks if the bot is mentioned in messages.
 */
export class MentionDetector {
    client;
    botInfo;
    /**
     * Set the Lark client for API calls.
     */
    setClient(client) {
        this.client = client;
    }
    /**
     * Fetch bot's info from Feishu API.
     * This is used to correctly identify when the bot is mentioned.
     */
    async fetchBotInfo() {
        if (!this.client) {
            logger.warn('Client not initialized, mention detection may be less accurate');
            return;
        }
        try {
            // Use bot info API to get bot's open_id and app_id
            const response = await this.client.request({
                method: 'GET',
                url: '/open-apis/bot/v3/info',
            });
            // Lark SDK returns response directly with bot/code/msg at top level
            const responseRecord = response;
            const bot = responseRecord.bot;
            if (bot?.open_id) {
                this.botInfo = {
                    open_id: bot.open_id,
                    app_id: bot.app_id,
                };
                logger.info({ botOpenId: bot.open_id, botAppId: bot.app_id }, 'Bot info fetched for mention detection');
            }
            else {
                logger.warn({
                    responseCode: responseRecord.code,
                    responseMsg: responseRecord.msg,
                    hasBot: !!bot,
                    botKeys: bot ? Object.keys(bot) : [],
                }, 'Failed to fetch bot info: no bot.open_id in response, mention detection may be less accurate');
            }
        }
        catch (error) {
            logger.warn({ err: error, errorMessage: error instanceof Error ? error.message : String(error) }, 'Failed to fetch bot info, mention detection may be less accurate');
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
    isBotMentioned(mentions) {
        if (!mentions || mentions.length === 0) {
            return false;
        }
        // Log mentions structure for debugging
        logger.debug({
            mentions: JSON.stringify(mentions),
            botInfo: this.botInfo,
        }, 'Checking bot mention');
        // If we have bot info, check if any mention matches bot's open_id OR app_id
        if (this.botInfo) {
            const botOpenId = this.botInfo.open_id;
            const botAppId = this.botInfo.app_id;
            return mentions.some((mention) => {
                const mentionOpenId = mention.id?.open_id || '';
                // Check against both bot's open_id and app_id
                // Feishu may use either when the bot is mentioned
                return (mentionOpenId === botOpenId ||
                    mentionOpenId === botAppId);
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
    getBotInfo() {
        return this.botInfo;
    }
}
