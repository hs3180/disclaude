/**
 * Message level enum for routing decisions.
 *
 * Message levels control which messages are visible to users vs admins:
 * - DEBUG: Debug information → Admin only
 * - PROGRESS: Execution progress → Admin only
 * - INFO: General information → Admin only
 * - NOTICE: Notification → User + Admin
 * - IMPORTANT: Important information → User + Admin (strong alert)
 * - ERROR: Error information → User + Admin
 * - RESULT: Final result → User + Admin
 *
 * @see Issue #266
 */
export var MessageLevel;
(function (MessageLevel) {
    MessageLevel["DEBUG"] = "debug";
    MessageLevel["PROGRESS"] = "progress";
    MessageLevel["INFO"] = "info";
    MessageLevel["NOTICE"] = "notice";
    MessageLevel["IMPORTANT"] = "important";
    MessageLevel["ERROR"] = "error";
    MessageLevel["RESULT"] = "result";
})(MessageLevel || (MessageLevel = {}));
/**
 * Default message levels visible to users.
 */
export const DEFAULT_USER_LEVELS = [
    MessageLevel.NOTICE,
    MessageLevel.IMPORTANT,
    MessageLevel.ERROR,
    MessageLevel.RESULT,
];
/**
 * All message levels (admin receives all).
 */
export const ALL_LEVELS = [
    MessageLevel.DEBUG,
    MessageLevel.PROGRESS,
    MessageLevel.INFO,
    MessageLevel.NOTICE,
    MessageLevel.IMPORTANT,
    MessageLevel.ERROR,
    MessageLevel.RESULT,
];
/**
 * Map AgentMessageType to MessageLevel.
 * @param messageType - Agent message type
 * @param content - Optional content for context-aware mapping
 * @returns Message level
 */
export function mapAgentMessageTypeToLevel(messageType, content) {
    switch (messageType) {
        case 'tool_progress':
            return MessageLevel.PROGRESS;
        case 'tool_use':
        case 'tool_result':
            return MessageLevel.DEBUG;
        case 'error':
            return MessageLevel.ERROR;
        case 'result':
            // Check if it's a completion message (internal, not user-facing)
            if (content?.startsWith('✅ Complete')) {
                return MessageLevel.DEBUG;
            }
            return MessageLevel.RESULT;
        case 'notification':
            return MessageLevel.NOTICE;
        case 'task_completion':
            return MessageLevel.RESULT;
        case 'max_iterations_warning':
            return MessageLevel.IMPORTANT;
        case 'status':
            return MessageLevel.INFO;
        case 'text':
        default:
            return MessageLevel.INFO;
    }
}
