/**
 * Callback manager for MCP tools.
 *
 * Centralized management of message sent callbacks.
 * This allows multiple tools to share the same callback mechanism.
 *
 * @module channel-cli/tools/callback-manager
 */
import { createLogger } from "../../../core/dist/index.js";
const logger = createLogger('CallbackManager');
let messageSentCallback = null;
/**
 * Set the message sent callback.
 * Pass null to clear the callback.
 */
export function setMessageSentCallback(callback) {
    messageSentCallback = callback;
}
/**
 * Get the current message sent callback.
 */
export function getMessageSentCallback() {
    return messageSentCallback;
}
/**
 * Invoke the message sent callback if one is registered.
 * Logs errors but does not throw.
 */
export function invokeMessageSentCallback(chatId) {
    if (messageSentCallback) {
        try {
            messageSentCallback(chatId);
        }
        catch (error) {
            logger.error({ err: error }, 'Failed to invoke message sent callback');
        }
    }
}
