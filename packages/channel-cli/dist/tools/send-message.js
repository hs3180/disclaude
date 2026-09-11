/**
 * send_text tool implementation.
 *
 * This tool sends plain text messages to Feishu chats.
 * For cards, use send_card or send_interactive instead.
 *
 * @module channel-cli/tools/send-message
 */
import { createLogger, sendMessage } from "../../../core/dist/index.js";
import { isChannelApiAvailable, getChannelApiErrorMessage, getChannelApiClient, buildChannelApiFallbackHint } from './channel-api-utils.js';
import { invokeMessageSentCallback, setMessageSentCallback, getMessageSentCallback } from './callback-manager.js';
const logger = createLogger('SendText');
// Re-export callback functions for backward compatibility
export { setMessageSentCallback, getMessageSentCallback };
/**
 * Send text message via REST API to PrimaryNode's LarkClientService.
 * Issue #1035: Routes Feishu API calls through unified client.
 * Issue #1088: Improved error handling with detailed error information.
 */
async function sendMessageViaChannelApi(chatId, text, threadId, mentions) {
    const apiClient = getChannelApiClient();
    return await sendMessage(apiClient, chatId, text, threadId, mentions);
}
/**
 * Send a plain text message to a Feishu chat.
 *
 * @param params.text - The text content to send
 * @param params.chatId - Target chat ID
 * @param params.parentMessageId - Optional parent message ID for thread reply
 */
export async function send_text(params) {
    const { text, chatId, parentMessageId, mentions } = params;
    logger.info({
        chatId,
        textPreview: text.substring(0, 100),
        hasParent: !!parentMessageId,
    }, 'send_text called');
    try {
        if (!text) {
            throw new Error('text is required');
        }
        if (!chatId) {
            throw new Error('chatId is required');
        }
        // Check REST API availability (Issue #1355: async connection probe)
        if (!(await isChannelApiAvailable())) {
            const errorMsg = 'REST API service unavailable. Please ensure Primary Node is running.';
            logger.error({ chatId }, errorMsg);
            return {
                success: false,
                error: errorMsg,
                // Issue #4576: actionable fallback — +messages-send loses thread
                // attribution in topic groups; +messages-reply preserves it.
                message: `❌ REST API 服务不可用。请检查 Primary Node 服务是否正在运行。${buildChannelApiFallbackHint(parentMessageId)}`,
            };
        }
        logger.debug({ chatId, parentMessageId }, 'Using REST API for text message');
        const result = await sendMessageViaChannelApi(chatId, text, parentMessageId, mentions);
        if (!result.success) {
            const errorMsg = getChannelApiErrorMessage(result.errorType, result.error);
            logger.error({ chatId, errorType: result.errorType, error: result.error }, 'REST API text message failed');
            return {
                success: false,
                error: result.error ?? 'Failed to send message via REST API',
                message: errorMsg,
            };
        }
        invokeMessageSentCallback(chatId);
        logger.debug({ chatId, parentMessageId }, 'Text message sent');
        return { success: true, message: '✅ Text message sent' };
    }
    catch (error) {
        logger.error({ err: error, chatId }, 'send_text FAILED');
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage, message: `❌ Failed to send text: ${errorMessage}` };
    }
}
