/**
 * Pre-processing message filters for the Feishu channel (Issue #4126).
 *
 * Extracted from MessageHandler.handleMessageReceive(). These are pure
 * verdict functions for the three early guard clauses — deduplication,
 * bot-message filtering (with bot-to-bot @mention carve-out, #1742), and
 * message-age checking. Side effects (logging, forwardFilteredMessage)
 * stay in the handler; this module only decides pass/filter + the reason.
 *
 * @module primary-node/channels/feishu/message-filters
 */
/**
 * Evaluate dedup → bot → age filters in order.
 *
 * Returns the first rejection, or `{ passed: true }` if all filters pass.
 * Performs no I/O; the only external operations are the injected dedup claim
 * and wall-clock reader (which defaults to `Date.now`).
 */
export function evaluateMessageFilters(input, deps) {
    // 1. Deduplication
    const claimed = deps.claim ? deps.claim(input.messageId) : !deps.isProcessed(input.messageId);
    if (!claimed) {
        return { passed: false, reason: 'duplicate' };
    }
    // 2. Bot messages are ignored unless the sender bot @mentions our bot (#1742).
    if (input.senderType === 'app' && !input.botMentionsUs) {
        return { passed: false, reason: 'bot' };
    }
    // 3. Message age
    if (input.createTime !== undefined) {
        const age = (deps.now ?? Date.now)() - input.createTime;
        if (age > deps.maxMessageAge) {
            return { passed: false, reason: 'old', age };
        }
    }
    return { passed: true };
}
