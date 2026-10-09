/**
 * ConversationOrchestrator - High-level conversation management.
 *
 * This is the main entry point for the conversation layer, combining:
 * - SessionManager for lifecycle management
 * - Message queuing and threading
 * - Event callbacks for consumer integration
 *
 * The orchestrator provides a clean API for:
 * - Processing incoming messages
 * - Managing sessions (reset, shutdown)
 * - Thread tracking
 *
 * Architecture:
 * ```
 * ChatAgent (or other Agent)
 *       ↓
 * ConversationOrchestrator
 *       ↓
 * ConversationSessionManager → Session state
 *       ↓
 * Callbacks → Platform-specific operations
 * ```
 */
import { ConversationSessionManager } from './conversation-session-manager.js';
/**
 * ConversationOrchestrator - Coordinates conversation components.
 *
 * This class provides the high-level API for conversation management,
 * abstracting away the details of session and message handling.
 */
export class ConversationOrchestrator {
    logger;
    sessionManager;
    /** Callbacks for session events - can be used by subclasses */
    callbacks;
    constructor(config) {
        this.logger = config.logger;
        this.callbacks = config.callbacks;
        // Create session manager
        const sessionManagerConfig = {
            logger: this.logger,
        };
        this.sessionManager = new ConversationSessionManager(sessionManagerConfig);
    }
    /**
     * Process an incoming message.
     *
     * This method:
     * 1. Tracks the thread root for the message
     * 2. Queues the message for processing
     * 3. Returns immediately (non-blocking)
     *
     * @param chatId - Platform-specific chat identifier
     * @param message - The message to process
     * @returns Result indicating success/failure
     */
    processMessage(chatId, message) {
        this.logger.debug({ chatId, messageId: message.messageId, textLength: message.text.length }, 'Processing message');
        // Track thread root
        this.sessionManager.setThreadRoot(chatId, message.messageId);
        // Queue the message
        const success = this.sessionManager.queueMessage(chatId, message);
        const stats = this.sessionManager.getStats(chatId);
        return {
            success,
            queueLength: stats?.queueLength ?? 0,
            error: success ? undefined : new Error('Session is closed'),
        };
    }
    /**
     * Check if a session exists for the chatId.
     */
    hasSession(chatId) {
        return this.sessionManager.has(chatId);
    }
    /**
     * Get the thread root for a chatId.
     */
    getThreadRoot(chatId) {
        return this.sessionManager.getThreadRoot(chatId);
    }
    /**
     * Set the thread root for a chatId.
     */
    setThreadRoot(chatId, messageId) {
        this.sessionManager.setThreadRoot(chatId, messageId);
    }
    /**
     * Delete the thread root for a chatId.
     * Used during session reset.
     */
    deleteThreadRoot(chatId) {
        return this.sessionManager.deleteThreadRoot(chatId);
    }
    /**
     * Get session statistics.
     */
    getSessionStats(chatId) {
        return this.sessionManager.getStats(chatId);
    }
    /**
     * Get the number of active sessions.
     */
    getActiveSessionCount() {
        return this.sessionManager.size();
    }
    /**
     * Get the number of active sessions (alias for getActiveSessionCount).
     */
    size() {
        return this.getActiveSessionCount();
    }
    /**
     * Get all active chat IDs.
     */
    getActiveChatIds() {
        return this.sessionManager.getActiveChatIds();
    }
    /**
     * Reset state for a specific chatId.
     *
     * This clears the session, including thread roots and queued messages.
     *
     * @param chatId - Platform-specific chat identifier
     * @returns true if session was reset, false if it didn't exist
     */
    reset(chatId) {
        const deleted = this.sessionManager.delete(chatId);
        if (deleted) {
            this.logger.info({ chatId }, 'Session reset for chatId');
        }
        else {
            this.logger.debug({ chatId }, 'No session to reset for chatId');
        }
        return deleted;
    }
    /**
     * Reset all sessions.
     */
    resetAll() {
        this.sessionManager.closeAll();
        this.logger.info('All sessions reset');
    }
    /**
     * Clear all sessions (alias for resetAll).
     */
    clearAll() {
        this.resetAll();
    }
    /**
     * Cleanup resources on shutdown.
     */
    shutdown() {
        this.logger.info('Shutting down ConversationOrchestrator');
        // Close all sessions
        this.sessionManager.closeAll();
        this.logger.info('ConversationOrchestrator shutdown complete');
    }
    /**
     * Get the underlying session manager for advanced use cases.
     * Use with caution - direct manipulation may bypass orchestrator logic.
     */
    getSessionManager() {
        return this.sessionManager;
    }
}
