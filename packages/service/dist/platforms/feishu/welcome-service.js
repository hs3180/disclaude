/**
 * Welcome Service - Handles welcome messages for new chats.
 *
 * Provides:
 * - Welcome message when bot enters a new P2P chat
 * - Welcome message when bot is added to a group
 * - Help message when users join a group that already has the bot
 * - Tracks first-time private chats in memory
 *
 * Issue #463: 帮助消息系统 - 入群/私聊引导 + 指令注册
 * Issue #676: 新用户加入群聊时发送 /help 信息
 *
 * Migrated to @disclaude/service (Issue #1040)
 */
import { createLogger, isGroupChat, isPrivateChat } from "../../../../core/dist/index.js";
const logger = createLogger('WelcomeService');
/**
 * Welcome Service - Manages welcome messages for new chats.
 */
export class WelcomeService {
    generateWelcomeMessage;
    generateHelpMessage;
    sendMessage;
    sendWelcomeMessage;
    automaticPrompts = new Map();
    disabledChats = new Set();
    privateChatIds = new Map();
    maxChats = 1000;
    /** Track first-time private chats (memory-only, resets on restart) */
    firstTimePrivateChats = new Set();
    constructor(config) {
        this.generateWelcomeMessage = config.generateWelcomeMessage;
        this.generateHelpMessage = config.generateHelpMessage;
        this.sendMessage = config.sendMessage;
        this.sendWelcomeMessage = config.sendWelcomeMessage;
    }
    isEnabled(chatId) {
        return !this.disabledChats.has(this.privateChatIds.get(chatId) ?? chatId);
    }
    setEnabled(chatId, enabled) {
        const key = this.privateChatIds.get(chatId) ?? chatId;
        if (enabled) {
            this.disabledChats.delete(key);
        }
        else {
            if (!this.disabledChats.has(key) && this.disabledChats.size >= this.maxChats) {
                throw new Error('Guidance preference capacity reached');
            }
            this.disabledChats.add(key);
        }
    }
    /** Join the P2P entered-event address to the actual inbound chat's preference/rate state. */
    registerPrivateChat(userId, chatId) {
        if (!this.privateChatIds.has(userId) && this.privateChatIds.size >= this.maxChats) {
            return;
        }
        this.privateChatIds.set(userId, chatId);
        const previous = this.automaticPrompts.get(userId);
        if (previous !== undefined) {
            this.automaticPrompts.set(chatId, Math.max(previous, this.automaticPrompts.get(chatId) ?? 0));
            this.automaticPrompts.delete(userId);
        }
        if (this.disabledChats.delete(userId)) {
            this.disabledChats.add(chatId);
        }
        if (this.firstTimePrivateChats.delete(userId)) {
            this.firstTimePrivateChats.add(chatId);
        }
    }
    /** Reserve before any await, including failed/uncertain delivery; explicit /help bypasses this gate. */
    claimPrompt(chatId, cooldownMs = 5 * 60 * 1000) {
        const key = this.privateChatIds.get(chatId) ?? chatId;
        if (!this.isEnabled(key)) {
            return false;
        }
        const now = Date.now();
        for (const [id, time] of this.automaticPrompts) {
            if (now - time >= 24 * 60 * 60 * 1000) {
                this.automaticPrompts.delete(id);
            }
        }
        const previous = this.automaticPrompts.get(key);
        if (previous !== undefined && now - previous < cooldownMs) {
            return false;
        }
        if (previous === undefined && this.automaticPrompts.size >= this.maxChats) {
            return false;
        }
        this.automaticPrompts.set(key, now);
        return true;
    }
    deliver(chatId, text, chatType) {
        return this.sendWelcomeMessage ? this.sendWelcomeMessage(chatId, text, chatType) : this.sendMessage(chatId, text);
    }
    /**
     * Handle bot being added to a group chat.
     * Sends welcome message with help.
     *
     * @param chatId - The group chat ID (address only; classification is by chatType)
     * @param chatType - The chat type from the triggering event
     */
    async handleBotAddedToGroup(chatId, chatType) {
        if (!isGroupChat(chatType)) {
            logger.warn({ chatId, chatType }, 'handleBotAddedToGroup called with non-group chat type');
            return;
        }
        if (!this.claimPrompt(chatId, 24 * 60 * 60 * 1000)) {
            return;
        }
        logger.info({ chatId }, 'Bot added to group, sending welcome message');
        try {
            const text = this.generateWelcomeMessage(chatId, chatType);
            if (!text) {
                return;
            }
            await this.deliver(chatId, text, chatType);
            logger.info({ chatId }, 'Welcome message sent to group');
        }
        catch (error) {
            logger.error({ err: error, chatId }, 'Failed to send welcome message to group');
        }
    }
    /**
     * Handle users joining a group chat that already has the bot.
     * Sends help message to introduce bot capabilities to new users.
     *
     * Issue #676: 新用户加入群聊时发送 /help 信息
     *
     * @param chatId - The group chat ID (address only; classification is by chatType)
     * @param chatType - The chat type from the triggering event
     * @param userIds - Array of user open_ids who joined (optional, for future use)
     */
    async handleUserJoinedGroup(chatId, chatType, userIds) {
        if (!isGroupChat(chatType)) {
            logger.warn({ chatId, chatType }, 'handleUserJoinedGroup called with non-group chat type');
            return;
        }
        if (!this.claimPrompt(chatId, 24 * 60 * 60 * 1000)) {
            return;
        }
        logger.info({ chatId, userCount: userIds?.length }, 'Users joined group, sending help message');
        try {
            const message = this.generateHelpMessage
                ? this.generateHelpMessage(chatId, chatType)
                : this.generateWelcomeMessage(chatId, chatType);
            if (!message) {
                return;
            }
            await this.deliver(chatId, message, chatType);
            logger.info({ chatId }, 'Help message sent to group for new users');
        }
        catch (error) {
            logger.error({ err: error, chatId }, 'Failed to send help message to group');
        }
    }
    /**
     * Handle first private chat with a user.
     * Sends welcome message with help if this is the first time.
     *
     * @param chatId - The private chat ID / user open_id (address only; classification is by chatType)
     * @param chatType - The chat type from the triggering event
     * @returns 'sent' if welcome was just sent, 'already_sent' if already sent before,
     *          'failed' if an error occurred, 'skipped' if not a private chat.
     */
    async handleFirstPrivateChat(chatId, chatType) {
        if (!isPrivateChat(chatType)) {
            logger.debug({ chatId, chatType }, 'handleFirstPrivateChat called with non-private chat type');
            return 'skipped';
        }
        chatId = this.privateChatIds.get(chatId) ?? chatId;
        // Check if this is the first time
        if (this.firstTimePrivateChats.has(chatId)) {
            logger.debug({ chatId }, 'Already sent welcome to this private chat');
            return 'already_sent';
        }
        if (this.firstTimePrivateChats.size >= this.maxChats || !this.claimPrompt(chatId)) {
            return 'skipped';
        }
        // Mark as sent
        this.firstTimePrivateChats.add(chatId);
        logger.info({ chatId }, 'First private chat, sending welcome message');
        try {
            const text = this.generateWelcomeMessage(chatId, chatType);
            if (!text) {
                this.firstTimePrivateChats.delete(chatId);
                return 'skipped';
            }
            await this.deliver(chatId, text, chatType);
            logger.info({ chatId }, 'Welcome message sent to private chat');
            return 'sent';
        }
        catch (error) {
            logger.error({ err: error, chatId }, 'Failed to send welcome message to private chat');
            // Issue #1357: Remove from tracked set so it can be retried on next interaction
            this.firstTimePrivateChats.delete(chatId);
            return 'failed';
        }
    }
    /**
     * Handle P2P chat entered event.
     * This is called when a user starts a private chat with the bot.
     */
    handleP2PChatEntered(chatId, chatType) {
        return this.handleFirstPrivateChat(chatId, chatType);
    }
    /**
     * Get the count of first-time private chats tracked.
     */
    getFirstTimeChatCount() {
        return this.firstTimePrivateChats.size;
    }
    /**
     * Clear all tracked first-time chats (for testing).
     */
    clearFirstTimeChats() {
        this.firstTimePrivateChats.clear();
    }
}
// Singleton instance
let globalWelcomeService;
/**
 * Initialize the global welcome service.
 */
export function initWelcomeService(config) {
    globalWelcomeService = new WelcomeService(config);
    return globalWelcomeService;
}
/**
 * Get the global welcome service.
 */
export function getWelcomeService() {
    return globalWelcomeService;
}
/**
 * Reset the global welcome service (for testing).
 */
export function resetWelcomeService() {
    globalWelcomeService = undefined;
}
