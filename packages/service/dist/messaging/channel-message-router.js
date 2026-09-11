/**
 * Channel Message Router - Routes messages to appropriate channels based on chatId.
 *
 * This module provides channel-type detection and message routing for MCP tools,
 * allowing them to work seamlessly across Feishu, CLI, and REST channels.
 *
 * Issue #513: Multi-channel message routing layer (Phase 1)
 */
import { createLogger } from "../../../core/dist/index.js";
const logger = createLogger('ChannelMessageRouter');
/**
 * Channel type enumeration.
 */
export var ChannelType;
(function (ChannelType) {
    ChannelType["FEISHU"] = "feishu";
    ChannelType["CLI"] = "cli";
    ChannelType["REST"] = "rest";
    ChannelType["UNKNOWN"] = "unknown";
})(ChannelType || (ChannelType = {}));
/**
 * Channel detection patterns.
 */
const CHANNEL_PATTERNS = {
    // Feishu chat IDs: oc_xxx (group), ou_xxx (user), on_xxx (bot)
    FEISHU: /^(oc_|ou_|on_)/,
    // CLI chat IDs: cli-xxx
    CLI: /^cli-/,
    // REST chat IDs: UUID format
    REST: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
};
/**
 * Channel Message Router - Routes messages based on chatId format.
 *
 * Detects the channel type from chatId format and routes messages accordingly:
 * - `oc_*`, `ou_*`, `on_*` → Feishu
 * - `cli-*` → CLI (console)
 * - UUID format → REST
 *
 * Example usage:
 * ```typescript
 * const router = new ChannelMessageRouter({
 *   sendToFeishu: async (chatId, msg) => { ... },
 *   sendToCli: async (chatId, msg) => { ... },
 * });
 *
 * // Detect channel type
 * const type = router.detectChannel('oc_abc123'); // ChannelType.FEISHU
 *
 * // Route message
 * await router.route('oc_abc123', { type: 'text', text: 'Hello' });
 * ```
 */
export class ChannelMessageRouter {
    sendToFeishu;
    sendToCli;
    sendToRest;
    channels;
    constructor(options) {
        this.sendToFeishu = options.sendToFeishu;
        this.sendToCli = options.sendToCli ?? this.defaultCliSender;
        this.sendToRest = options.sendToRest;
        this.channels = options.channels;
    }
    /**
     * Default CLI sender - logs to console.
     */
    defaultCliSender(chatId, message) {
        const content = message.text ?? JSON.stringify(message.card, null, 2);
        logger.info({ chatId, type: message.type }, 'CLI message');
        console.log(`\n[${chatId}] ${content}\n`);
        return Promise.resolve();
    }
    /**
     * Detect channel type from chatId format.
     *
     * @param chatId - Chat ID to detect
     * @returns Detected channel type
     */
    detectChannel(chatId) {
        if (!chatId || typeof chatId !== 'string') {
            return ChannelType.UNKNOWN;
        }
        if (CHANNEL_PATTERNS.FEISHU.test(chatId)) {
            return ChannelType.FEISHU;
        }
        if (CHANNEL_PATTERNS.CLI.test(chatId)) {
            return ChannelType.CLI;
        }
        if (CHANNEL_PATTERNS.REST.test(chatId)) {
            return ChannelType.REST;
        }
        return ChannelType.UNKNOWN;
    }
    /**
     * Route a message to the appropriate channel based on chatId.
     *
     * @param chatId - Target chat ID
     * @param message - Message to send
     * @returns Routing result
     */
    async route(chatId, message) {
        const channelType = this.detectChannel(chatId);
        logger.debug({ chatId, channelType, messageType: message.type }, 'Routing message');
        try {
            switch (channelType) {
                case ChannelType.FEISHU:
                    await this.sendToFeishu(chatId, message);
                    return { success: true, channelType };
                case ChannelType.CLI:
                    await this.sendToCli(chatId, message);
                    return { success: true, channelType };
                case ChannelType.REST:
                    if (this.sendToRest) {
                        await this.sendToRest(chatId, message);
                        return { success: true, channelType };
                    }
                    return {
                        success: false,
                        channelType,
                        error: 'REST channel sender not configured',
                    };
                case ChannelType.UNKNOWN:
                default:
                    return {
                        success: false,
                        channelType,
                        error: `Unknown chatId format: ${chatId}`,
                    };
            }
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ chatId, channelType, error: errorMessage }, 'Routing failed');
            return {
                success: false,
                channelType,
                error: errorMessage,
            };
        }
    }
    /**
     * Route a text message.
     *
     * @param chatId - Target chat ID
     * @param text - Text content
     * @param threadId - Optional thread ID for replies
     * @returns Routing result
     */
    routeText(chatId, text, threadId) {
        return this.route(chatId, { chatId, type: 'text', text, threadId });
    }
    /**
     * Route a card message.
     *
     * @param chatId - Target chat ID
     * @param card - Card content
     * @param threadId - Optional thread ID for replies
     * @returns Routing result
     */
    routeCard(chatId, card, threadId) {
        return this.route(chatId, { chatId, type: 'card', card, threadId });
    }
    /**
     * Broadcast a message to all registered channels.
     *
     * @param message - Message to broadcast
     */
    async broadcast(message) {
        if (!this.channels || this.channels.size === 0) {
            logger.warn({ chatId: message.chatId }, 'No channels registered for broadcast');
            return;
        }
        const results = await Promise.allSettled(Array.from(this.channels.values()).map(async (channel) => {
            try {
                await channel.sendMessage(message);
            }
            catch (error) {
                logger.warn({ channelId: channel.id, chatId: message.chatId, error }, 'Channel failed to broadcast message');
                throw error;
            }
        }));
        // Log any failures
        const channelArray = Array.from(this.channels.values());
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                logger.warn({ channelId: channelArray[index].id, chatId: message.chatId }, 'Broadcast failed for channel');
            }
        });
    }
    /**
     * Check if a chatId is a valid Feishu chat.
     */
    isFeishuChat(chatId) {
        return this.detectChannel(chatId) === ChannelType.FEISHU;
    }
    /**
     * Check if a chatId is a CLI chat.
     */
    isCliChat(chatId) {
        return this.detectChannel(chatId) === ChannelType.CLI;
    }
    /**
     * Check if a chatId is a REST chat.
     */
    isRestChat(chatId) {
        return this.detectChannel(chatId) === ChannelType.REST;
    }
    /**
     * Get human-readable channel type name.
     */
    getChannelTypeName(chatId) {
        const type = this.detectChannel(chatId);
        return type.charAt(0).toUpperCase() + type.slice(1);
    }
}
// Global singleton instance
let globalRouter;
/**
 * Initialize the global channel message router.
 */
export function initChannelMessageRouter(options) {
    globalRouter = new ChannelMessageRouter(options);
    logger.info('Global channel message router initialized');
    return globalRouter;
}
/**
 * Get the global channel message router.
 * Throws if not initialized.
 */
export function getChannelMessageRouter() {
    if (!globalRouter) {
        throw new Error('ChannelMessageRouter not initialized. Call initChannelMessageRouter first.');
    }
    return globalRouter;
}
/**
 * Reset the global router (for testing).
 */
export function resetChannelMessageRouter() {
    globalRouter = undefined;
}
