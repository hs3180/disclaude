/**
 * Message routing types for implementing message level-based routing.
 *
 * This module defines the types for the message routing system that:
 * - Routes execution progress to admin chats
 * - Routes only key interactions to user chats
 *
 * @see Issue #266
 */
import { MessageLevel } from "../../../core/dist/index.js";
// Re-export MessageLevel for backward compatibility
export { MessageLevel, DEFAULT_USER_LEVELS, ALL_LEVELS } from "../../../core/dist/index.js";
/**
 * Map AgentMessageType to MessageLevel.
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
