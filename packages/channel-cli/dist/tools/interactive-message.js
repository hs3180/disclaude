/**
 * Interactive message tool implementation.
 *
 * This tool sends interactive cards with pre-defined prompt templates
 * that are automatically converted to user messages when interactions occur.
 *
 * Issue #1571 (Phase 2): the channel client passes raw parameters (question, options)
 * via sendInteractive REST API. Primary Node owns the full card building lifecycle.
 * Issue #1572: Interactive context management has been moved to Primary Node's
 * InteractiveContextStore. The channel client is now a pure forwarding client.
 *
 * @module channel-cli/tools/interactive-message
 */
import { createLogger, sendInteractive, } from "../../../core/dist/index.js";
import { isChannelApiAvailable, getChannelApiErrorMessage, getChannelApiClient, buildChannelApiFallbackHint } from './channel-api-utils.js';
import { getMessageSentCallback } from './callback-manager.js';
const logger = createLogger('InteractiveMessage');
/**
 * Send an interactive message by forwarding raw parameters to Primary Node.
 *
 * Issue #1571: MCP Server no longer builds cards. It passes raw parameters
 * (question, options) via sendInteractive REST API. Primary Node builds the card,
 * sends it, and registers action prompts.
 *
 * Issue #1572: Action prompt management is handled by Primary Node's
 * InteractiveContextStore. MCP Server is a pure forwarding client.
 *
 * @example
 * ```typescript
 * await send_interactive_message({
 *   question: "Which option do you prefer?",
 *   options: [
 *     { text: "✅ Approve", value: "approve", type: "primary" },
 *     { text: "❌ Reject", value: "reject", type: "danger" },
 *   ],
 *   title: "Code Review",
 *   chatId: "oc_xxx"
 * });
 * ```
 */
export async function send_interactive_message(params) {
    const { question, options, chatId, parentMessageId } = params;
    logger.info({
        chatId,
        optionCount: options?.length ?? 0,
        hasParent: !!parentMessageId,
    }, 'send_interactive_message called');
    try {
        // Validate required parameters
        if (!question || typeof question !== 'string' || question.trim().length === 0) {
            return {
                success: false,
                error: 'question is required and must be a non-empty string',
                message: '❌ question 参数不能为空',
            };
        }
        if (!Array.isArray(options) || options.length === 0) {
            return {
                success: false,
                error: 'options is required and must be a non-empty array',
                message: '❌ options 参数必须为非空数组',
            };
        }
        if (!chatId || typeof chatId !== 'string') {
            return {
                success: false,
                error: 'chatId is required',
                message: '❌ chatId 参数不能为空',
            };
        }
        // Validate options structure
        for (let i = 0; i < options.length; i++) {
            const opt = options[i];
            if (typeof opt.text !== 'string' || opt.text.trim().length === 0) {
                return {
                    success: false,
                    error: `options[${i}].text must be a non-empty string`,
                    message: `❌ options[${i}].text 不能为空`,
                };
            }
            if (typeof opt.value !== 'string' || opt.value.trim().length === 0) {
                return {
                    success: false,
                    error: `options[${i}].value must be a non-empty string`,
                    message: `❌ options[${i}].value 不能为空`,
                };
            }
            if (opt.type !== undefined && !['primary', 'default', 'danger'].includes(opt.type)) {
                return {
                    success: false,
                    error: `options[${i}].type must be one of: primary, default, danger`,
                    message: `❌ options[${i}].type 必须为 primary, default, danger 之一`,
                };
            }
        }
        // Check REST API availability - REST API is required for sending messages (Issue #1355: async connection probe)
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
        // Issue #1571: Forward raw params via sendInteractive REST API.
        // Primary Node builds the card, sends it, and registers action prompts.
        logger.debug({ chatId, parentMessageId }, 'Forwarding raw params via sendInteractive REST API');
        // Issue #4280 (Phase 3, part 3): REST-only — direct ChannelApiClient.
        const apiClient = getChannelApiClient();
        const result = await sendInteractive(apiClient, chatId, {
            question,
            options,
            title: params.title,
            context: params.context,
            threadId: parentMessageId,
            actionPrompts: params.actionPrompts,
        });
        if (!result.success) {
            const errorMsg = getChannelApiErrorMessage(result.errorType, result.error);
            logger.error({ chatId, errorType: result.errorType, error: result.error }, 'sendInteractive REST API failed');
            return {
                success: false,
                error: result.error ?? 'Failed to send interactive message via REST API',
                message: errorMsg,
            };
        }
        // Invoke message sent callback
        const callback = getMessageSentCallback();
        if (callback) {
            try {
                callback(chatId);
            }
            catch (error) {
                logger.error({ err: error }, 'Failed to invoke message sent callback');
            }
        }
        return {
            success: true,
            message: `✅ Interactive message sent with ${options.length} action(s)`,
        };
    }
    catch (error) {
        logger.error({ err: error, chatId }, 'send_interactive_message FAILED');
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return { success: false, error: errorMessage, message: `❌ Failed to send interactive message: ${errorMessage}` };
    }
}
/**
 * Alias for send_interactive_message for consistency with other tool names.
 * Sends an interactive card with clickable buttons to a Feishu chat.
 */
export const send_interactive = send_interactive_message;
