/**
 * push_to_agent tool implementation.
 *
 * Pushes an instruction to a chat agent, triggering agent creation if needed.
 * This allows skills to send instructions to agents handling a specific chat.
 *
 * Issue #631: Non-blocking interaction — Agent-to-human messaging without blocking.
 *
 * @module channel-cli/tools/push-to-agent
 */
import { createLogger, pushToAgent } from "../../../core/dist/index.js";
import { isChannelApiAvailable, getChannelApiErrorMessage, getChannelApiClient } from './channel-api-utils.js';
const logger = createLogger('PushToAgent');
/**
 * Push an instruction to a chat agent via REST API.
 *
 * @param params.chatId - Target chat ID
 * @param params.message - The instruction text to push
 */
export async function push_to_agent(params) {
    const { chatId, message } = params;
    logger.info({
        chatId,
        messagePreview: message.substring(0, 100),
    }, 'push_to_agent called');
    try {
        if (!message) {
            throw new Error('message is required');
        }
        if (!chatId) {
            throw new Error('chatId is required');
        }
        // Check REST API availability
        if (!(await isChannelApiAvailable())) {
            const errorMsg = 'REST API service unavailable. Please ensure Primary Node is running.';
            logger.error({ chatId }, errorMsg);
            return {
                success: false,
                error: errorMsg,
                message: '❌ REST API 服务不可用。请检查 Primary Node 服务是否正在运行。',
            };
        }
        logger.debug({ chatId }, 'Using REST API for push_to_agent');
        // Issue #4280 (Phase 3, part 3): REST-only — direct ChannelApiClient.
        const apiClient = getChannelApiClient();
        const result = await pushToAgent(apiClient, chatId, message);
        if (!result.success) {
            const errorMsg = getChannelApiErrorMessage(result.errorType, result.error);
            logger.error({ chatId, errorType: result.errorType, error: result.error }, 'REST API push_to_agent failed');
            return {
                success: false,
                error: result.error ?? 'Failed to push to agent via REST API',
                message: errorMsg,
            };
        }
        logger.debug({ chatId }, 'push_to_agent succeeded');
        return { success: true, message: '✅ Instruction pushed to agent successfully' };
    }
    catch (error) {
        logger.error({ err: error, chatId }, 'push_to_agent FAILED');
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage, message: `❌ Failed to push to agent: ${errorMessage}` };
    }
}
