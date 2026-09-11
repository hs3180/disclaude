/**
 * ConversationSessionManager - Manages conversation session lifecycle.
 *
 * This is an agent-agnostic session manager that handles:
 * - Session state tracking (per chatId)
 * - Thread root management
 * - Session creation, retrieval, and cleanup
 *
 * Unlike the the agents/ SessionManager which is tightly coupled to Query/Channel,
 * this version focuses on pure conversation state management.
 */
import { isSyntheticMessageId } from '../utils/message-id.js';
/**
 * ConversationSessionManager - Agent-agnostic session lifecycle management.
 *
 * Each chatId gets its own session containing conversation state.
 * This class provides:
 * - Session creation with default state
 * - Thread root tracking
 * - Session statistics
 * - Lifecycle management (get, has, delete, closeAll)
 */
export class ConversationSessionManager {
    logger;
    sessions = new Map();
    constructor(config) {
        this.logger = config.logger;
    }
    /**
     * Check if a session exists for the given chatId.
     */
    has(chatId) {
        return this.sessions.has(chatId);
    }
    /**
     * Get an existing session for the chatId.
     * Returns undefined if no session exists.
     */
    get(chatId) {
        return this.sessions.get(chatId);
    }
    /**
     * Get or create a session for the chatId.
     * If the session doesn't exist, creates one with default state.
     *
     * @param chatId - The chat identifier
     * @returns The session state
     */
    getOrCreate(chatId) {
        let session = this.sessions.get(chatId);
        if (!session) {
            session = this.createDefaultSession();
            this.sessions.set(chatId, session);
            this.logger.debug({ chatId }, 'Session created');
        }
        return session;
    }
    /**
     * Create a new session with default state.
     */
    createDefaultSession() {
        const now = Date.now();
        return {
            messageQueue: [],
            closed: false,
            lastActivity: now,
            started: false,
            createdAt: now,
        };
    }
    /**
     * Update the thread root for a session.
     *
     * @param chatId - The chat identifier
     * @param threadRootId - The message ID to use as thread root
     */
    setThreadRoot(chatId, threadRootId) {
        const session = this.getOrCreate(chatId);
        session.lastActivity = Date.now();
        // 合成消息 ID(定时任务 sched-*、push_* 等)非平台真实消息 ID,
        // 不可作为线程根——否则后续回复会把它当 Feishu open_message_id 触发 400(99992354)。
        // 跳过写入:既不覆盖已有真实线程根,也不建立无效锚点。
        if (isSyntheticMessageId(threadRootId)) {
            this.logger.debug({ chatId, threadRootId }, 'Skipping threadRoot for synthetic message ID');
            return;
        }
        session.currentThreadRootId = threadRootId;
        this.logger.debug({ chatId, threadRootId }, 'Thread root set');
    }
    /**
     * Get the thread root for a session.
     *
     * @param chatId - The chat identifier
     * @returns The thread root message ID, or undefined if not set
     */
    getThreadRoot(chatId) {
        return this.sessions.get(chatId)?.currentThreadRootId;
    }
    /**
     * Delete the thread root for a session.
     * Used during session reset to clear thread tracking.
     *
     * @param chatId - The chat identifier
     * @returns true if thread root was deleted, false if not set
     */
    deleteThreadRoot(chatId) {
        const session = this.sessions.get(chatId);
        if (session && session.currentThreadRootId) {
            session.currentThreadRootId = undefined;
            this.logger.debug({ chatId }, 'Thread root deleted');
            return true;
        }
        return false;
    }
    /**
     * Queue a message for a session.
     *
     * @param chatId - The chat identifier
     * @param message - The message to queue
     * @returns true if message was queued, false if session is closed
     */
    queueMessage(chatId, message) {
        const session = this.getOrCreate(chatId);
        if (session.closed) {
            return false;
        }
        session.messageQueue.push(message);
        session.lastActivity = Date.now();
        if (session.messageResolver) {
            session.messageResolver();
            session.messageResolver = undefined;
        }
        this.logger.debug({ chatId, messageId: message.messageId }, 'Message queued');
        return true;
    }
    /**
     * Mark a session as started.
     */
    markStarted(chatId) {
        const session = this.sessions.get(chatId);
        if (session) {
            session.started = true;
            session.lastActivity = Date.now();
        }
    }
    /**
     * Delete a session for the chatId.
     *
     * @param chatId - The chat identifier
     * @returns true if session was deleted, false if it didn't exist
     */
    delete(chatId) {
        const session = this.sessions.get(chatId);
        if (!session) {
            return false;
        }
        // Mark as closed first
        session.closed = true;
        // Resolve any pending resolver
        if (session.messageResolver) {
            session.messageResolver();
        }
        // Remove from map
        this.sessions.delete(chatId);
        this.logger.debug({ chatId }, 'Session deleted');
        return true;
    }
    /**
     * Get statistics for a session.
     *
     * @param chatId - The chat identifier
     * @returns Session statistics, or undefined if no session
     */
    getStats(chatId) {
        const session = this.sessions.get(chatId);
        if (!session) {
            return undefined;
        }
        return {
            chatId,
            queueLength: session.messageQueue.length,
            isClosed: session.closed,
            createdAt: session.createdAt,
            lastActivity: session.lastActivity,
            started: session.started,
            threadRootId: session.currentThreadRootId,
        };
    }
    /**
     * Get the number of active sessions.
     */
    size() {
        return this.sessions.size;
    }
    /**
     * Get all chatIds with active sessions.
     */
    getActiveChatIds() {
        return Array.from(this.sessions.keys());
    }
    /**
     * Close all sessions and clear tracking.
     * Used during shutdown.
     */
    closeAll() {
        // Mark all as closed and resolve any pending resolvers
        for (const [_chatId, session] of this.sessions) {
            session.closed = true;
            if (session.messageResolver) {
                session.messageResolver();
            }
        }
        // Clear the map
        this.sessions.clear();
        this.logger.info('All sessions closed');
    }
}
