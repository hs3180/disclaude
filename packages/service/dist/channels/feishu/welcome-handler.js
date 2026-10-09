/**
 * Welcome Handler.
 *
 * Handles welcome messages for new chats and group joins.
 * Issue #463: Send welcome message on first private chat
 * Issue #676: Send help message when users join a group
 * Issue #694: Extracted from feishu-channel.ts
 *
 * Migrated to @disclaude/service (Issue #1040)
 */
import { createLogger } from "../../../../core/dist/index.js";
/**
 * Chat type is implied by the Feishu event type at this boundary (the event
 * payloads themselves carry no `chat_type` field):
 * - bot_p2p_chat_entered_v1  → 'p2p'   (a user opened a private chat with the bot)
 * - im.chat.member.added     → 'group' (members are added to group chats; P2P
 *                                      chats are established by messaging, not
 *                                      by member-add events)
 *
 * Classifying by event type — not by sniffing the chat ID prefix — keeps the
 * welcome flow decoupled from Feishu's ID scheme. Issue #4136.
 */
const CHAT_TYPE_FROM_P2P_ENTERED = 'p2p';
const CHAT_TYPE_FROM_MEMBER_ADDED = 'group';
const logger = createLogger('WelcomeHandler');
/**
 * Welcome Handler.
 *
 * Handles P2P chat entered and chat member added events.
 */
export class WelcomeHandler {
    welcomeService;
    appId;
    isRunning;
    /**
     * Create a WelcomeHandler.
     *
     * @param appId - Feishu App ID for bot identification
     * @param isRunning - Function to check if channel is running
     */
    constructor(appId, isRunning) {
        this.appId = appId;
        this.isRunning = isRunning;
    }
    /**
     * Set the WelcomeService.
     */
    setWelcomeService(service) {
        this.welcomeService = service;
    }
    /**
     * Handle P2P chat entered event.
     * Triggered when a user starts a private chat with the bot.
     */
    async handleP2PChatEntered(data) {
        if (!this.isRunning() || !this.welcomeService) {
            return;
        }
        const { event } = data;
        if (!event?.user?.open_id) {
            logger.debug('P2P chat entered event missing user info');
            return;
        }
        const userId = event.user.open_id;
        logger.info({ userId }, 'P2P chat entered, sending welcome message');
        await this.welcomeService.handleP2PChatEntered(userId, CHAT_TYPE_FROM_P2P_ENTERED);
    }
    /**
     * Handle chat member added event.
     * Triggered when members are added to a chat.
     */
    async handleChatMemberAdded(data) {
        if (!this.isRunning() || !this.welcomeService) {
            return;
        }
        const { event } = data;
        if (!event?.chat_id || !event?.members || event.members.length === 0) {
            logger.debug('Chat member added event missing required fields');
            return;
        }
        // Filter out null/undefined entries from members array (defensive)
        const members = event.members.filter((m) => m !== null && m !== undefined);
        // Check if the bot is among the added members
        // Bot's member_id_type is "app_id" and member_id is the bot's app_id
        const botMemberAdded = members.some((member) => member.member_id_type === 'app_id' && member.member_id === this.appId);
        // Get non-bot members (users who joined)
        const userMembers = members.filter((member) => !(member.member_id_type === 'app_id' && member.member_id === this.appId));
        if (botMemberAdded) {
            // Bot was added to the group -> send welcome message
            logger.info({ chatId: event.chat_id }, 'Bot added to group, sending welcome message');
            await this.welcomeService.handleBotAddedToGroup(event.chat_id, CHAT_TYPE_FROM_MEMBER_ADDED);
        }
        else if (userMembers.length > 0) {
            // Users joined a group that already has the bot -> send help message
            logger.info({ chatId: event.chat_id, userCount: userMembers.length }, 'New users joined group, sending help message');
            const userIds = userMembers.map((m) => m.member_id);
            await this.welcomeService.handleUserJoinedGroup(event.chat_id, CHAT_TYPE_FROM_MEMBER_ADDED, userIds);
        }
    }
}
