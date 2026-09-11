/**
 * Debug Group Service - Manages the debug group setting.
 *
 * This service provides a simple in-memory storage for the debug group chat ID.
 * The debug group is where debug-level messages are sent.
 *
 * Features:
 * - Single instance pattern - only one debug group per bot instance
 * - Memory-only storage - resets on restart
 * - Automatic transfer - setting a new group overwrites the previous one
 *
 * Issue #487: Debug group management
 * Issue #1040: Migrated to @disclaude/primary-node
 */
import { createLogger } from "../../../core/dist/index.js";
const logger = createLogger('DebugGroupService');
/**
 * Debug Group Service - manages the debug group setting.
 */
export class DebugGroupService {
    debugGroup = null;
    /**
     * Set the debug group.
     * @param chatId - The chat ID of the debug group
     * @param name - Optional name of the group
     * @returns The previous debug group info if there was one, null otherwise
     */
    setDebugGroup(chatId, name) {
        const previous = this.debugGroup;
        this.debugGroup = {
            chatId,
            name,
            setAt: Date.now(),
        };
        logger.info({ chatId, name, previousChatId: previous?.chatId }, 'Debug group set');
        return previous;
    }
    /**
     * Get the current debug group info.
     * @returns The current debug group info, or null if not set
     */
    getDebugGroup() {
        return this.debugGroup;
    }
    /**
     * Clear the debug group setting.
     * @returns The previous debug group info if there was one, null otherwise
     */
    clearDebugGroup() {
        const previous = this.debugGroup;
        this.debugGroup = null;
        logger.info({ previousChatId: previous?.chatId }, 'Debug group cleared');
        return previous;
    }
    /**
     * Check if a chat ID is the debug group.
     * @param chatId - The chat ID to check
     * @returns True if the chat ID is the debug group
     */
    isDebugGroup(chatId) {
        return this.debugGroup?.chatId === chatId;
    }
}
// Singleton instance
let debugGroupService = null;
/**
 * Get the singleton DebugGroupService instance.
 */
export function getDebugGroupService() {
    if (!debugGroupService) {
        debugGroupService = new DebugGroupService();
    }
    return debugGroupService;
}
/**
 * Reset the singleton instance (for testing).
 */
export function resetDebugGroupService() {
    debugGroupService = null;
}
