/**
 * Per-chat last-failure registry (Issue #5400, PR A).
 *
 * ChatAgent records every user-visible failure context here so the `/issue`
 * feedback entry can offer "report the most recent failure of this chat"
 * without reading logs or replaying the conversation. The registry keeps only
 * the LAST record per chat — a new failure supersedes the old one — and is
 * bounded so a long-running service cannot grow it without limit.
 *
 * Records are already sanitized by the producer (createFailureContext runs
 * sanitizeDiagnosticText on every free-text field); no raw secrets enter here.
 */
/** Default cap on tracked chats; the least recently updated chat is dropped. */
const DEFAULT_MAX_CHATS = 256;
export class ChatFailureRegistry {
    records = new Map();
    maxChats;
    constructor(maxChats = DEFAULT_MAX_CHATS) {
        this.maxChats = maxChats;
    }
    /** Record `failure` as the last failure of its chat (insertion order = recency). */
    record(failure) {
        if (!failure.chatId || !failure.diagnosticId) {
            return;
        }
        this.records.delete(failure.chatId);
        this.records.set(failure.chatId, failure);
        while (this.records.size > this.maxChats) {
            const oldest = this.records.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.records.delete(oldest);
        }
    }
    /** Last recorded failure of the chat, if any. */
    get(chatId) {
        return this.records.get(chatId);
    }
    /** Drop a chat's record (used after a successful report or explicit dismiss). */
    clear(chatId) {
        this.records.delete(chatId);
    }
}
