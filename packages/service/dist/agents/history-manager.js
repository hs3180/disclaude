/**
 * HistoryManager - Manages chat history loading for ChatAgent.
 *
 * Loads one session-restore snapshot for the first message only (#4795).
 * Legacy persisted/first-message accessors share the same fetch. Log paths are
 * cached separately and remain available after the snapshot is consumed.
 *
 * The manager is bound to a single chatId (mirroring ChatAgent's chatId binding)
 * and caches loaded history for the lifetime of the agent instance. State can be
 * cleared via reset() to force a reload (e.g. after /reset).
 *
 * Loaded context is exposed read-only via getters; the consume-once first-message
 * context is taken atomically via consumeFirstMessageContext(), so ChatAgent never
 * mutates this manager's internals directly.
 *
 * Extracted from ChatAgent as part of Issue #4125 (part 2): splitting
 * ChatAgent into focused modules.
 *
 * @module agents/history-manager
 */
import { Config } from "../../../core/dist/index.js";
/**
 * Manages loading and caching of chat history context for a ChatAgent instance.
 *
 * Loading is idempotent and concurrency-safe: concurrent callers of either
 * load method share the same in-flight promise. Once loaded, the result is
 * cached until reset().
 */
export class HistoryManager {
    config;
    // --- Load-state flags (Issue #955, #1230) ---
    /** Whether persisted (session-restore) history has finished loading. */
    historyLoaded = false;
    /** Whether first-message history has finished loading. */
    firstMessageHistoryLoaded = false;
    // --- Loaded context (read-only from the outside; see getters) ---
    /** Loaded snapshot; cleared when the instance's first message consumes it. */
    _persistedHistoryContext;
    /** Absolute paths to chat log files for access beyond the context window. */
    _chatLogFilePaths;
    /** History attached only to the first message of a session (consume-once). */
    _firstMessageHistoryContext;
    // --- Internal plumbing (not part of the public surface) ---
    historyLoadPromise;
    firstMessageHistoryLoadPromise;
    /** Issue #3696 (--no-context): history loading explicitly disabled for this agent. */
    skipHistory = false;
    contextConsumed = false;
    generation = 0;
    constructor(config) {
        this.config = config;
    }
    /** Legacy read-only view of the snapshot before first-message consumption. */
    get persistedHistoryContext() {
        return this._persistedHistoryContext;
    }
    /** Absolute paths to chat log files for access beyond the context window. */
    get chatLogFilePaths() {
        return this._chatLogFilePaths;
    }
    /** History attached only to the first message of a session (peek only). */
    get firstMessageHistoryContext() {
        return this._firstMessageHistoryContext;
    }
    /**
     * Select one bounded snapshot and clear both legacy views. Explicit input
     * wins on the first message only; later messages cannot reattach a snapshot.
     * Cheap log-file hints remain available independently.
     */
    consumeFirstMessageContext(explicitContext) {
        if (this.skipHistory || this.contextConsumed) {
            return undefined;
        }
        this.contextConsumed = true;
        const ctx = explicitContext ?? this._firstMessageHistoryContext ?? this._persistedHistoryContext;
        this._firstMessageHistoryContext = undefined;
        this._persistedHistoryContext = undefined;
        if (!ctx) {
            return undefined;
        }
        // getChatHistory owns recency selection (newest day first). Bound the
        // selected snapshot's rendered length, including any truncation notice;
        // never take its tail, which would select older days (#4171).
        const configured = Config.getSessionRestoreConfig().maxContextLength;
        const budget = Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 4000;
        const bounded = ctx.slice(0, budget);
        this.config.logger.info({ chatId: this.config.chatId, historyLength: bounded.length, budget }, 'Consumed first-message history snapshot');
        return bounded || undefined;
    }
    /**
     * Mark both history types as already-loaded without fetching. Used when the
     * agent is created with --no-context (Issue #3696).
     */
    markSkipped() {
        this.generation++;
        this._persistedHistoryContext = undefined;
        this._firstMessageHistoryContext = undefined;
        this._chatLogFilePaths = undefined;
        this.historyLoaded = true;
        this.firstMessageHistoryLoaded = true;
        this.skipHistory = true;
    }
    /**
     * Force-reload the first-message chat history so the NEXT message consumes it.
     *
     * Issue #4391 (design doc §6 follow-up — history re-injection): the empty-turn
     * reset+replay tears down the SDK session and replays the original input into
     * a FRESH session. v1's replay still carried `persistedHistoryContext` (the
     * session-start snapshot attached to every message), but NOT the recent
     * first-message history — the fresh session's first message lost the turns
     * logged after that snapshot, exactly while recovering from a stale-session
     * empty turn. This re-fetches the recent chat history (same source as the
     * first-message load: `getChatHistory`) and re-stashes it, so the replayed
     * message — the fresh session's first message — carries a FRESH snapshot via
     * the existing consume-once path (`consumeFirstMessageContext`).
     *
     * Distinct from `loadFirstMessageHistory()`: that method is a load-once cache
     * fill (no-op once `firstMessageHistoryLoaded`); by the time an empty turn
     * fires, the original turn already consumed that context. This method always
     * re-fetches. Recency selection stays owned by `getChatHistory` (Issue #1863);
     * consumeFirstMessageContext bounds the rendered snapshot before injection.
     *
     * Failure is non-fatal: the replay proceeds without context (v1 behavior) —
     * history re-injection is a best-effort enrichment, never a recovery blocker.
     *
     * @returns Promise resolving to true when context was re-stashed (a
     *   subsequent consume will see it), false when unavailable/failed.
     */
    async reloadFirstMessageHistory() {
        const { chatId, logger, callbacks } = this.config;
        const { generation } = this;
        try {
            if (this.skipHistory) {
                // --no-context (Issue #3696): the agent was created with history
                // loading explicitly disabled; re-injection must not quietly reverse
                // that operator choice on the recovery path.
                logger.debug({ chatId }, 'skipHistory set, skipping empty-turn history re-injection');
                return false;
            }
            if (!callbacks.getChatHistory) {
                logger.debug({ chatId }, 'getChatHistory callback unavailable, skipping history re-injection');
                return false;
            }
            const history = await callbacks.getChatHistory(chatId);
            if (generation !== this.generation || this.skipHistory) {
                return false;
            }
            if (!history || !history.trim()) {
                logger.debug({ chatId }, 'No chat history to re-inject before empty-turn replay');
                return false;
            }
            this._firstMessageHistoryContext = history;
            this._persistedHistoryContext = undefined;
            this.contextConsumed = false;
            // Keep the loaded flag true so loadFirstMessageHistory() stays a no-op —
            // the stash below is consumed by the replay's processMessage, not by an
            // unrelated first-message load.
            this.firstMessageHistoryLoaded = true;
            logger.info({ chatId, historyLength: history.length }, 'Chat history re-stashed for empty-turn replay (Issue #4391 history re-injection)');
            return true;
        }
        catch (error) {
            logger.warn({ err: error, chatId }, 'Failed to reload chat history for empty-turn replay; replaying without context');
            return false;
        }
    }
    /**
     * Load persisted chat history for session restoration (Issue #955).
     *
     * Idempotent: concurrent callers share the same in-flight promise, and a
     * completed load is a no-op until reset().
     *
     * @returns Promise that resolves when history is loaded
     */
    async loadPersistedHistory() {
        // If already loading, wait for the existing promise
        if (this.historyLoadPromise) {
            return this.historyLoadPromise;
        }
        // If already loaded, return immediately
        if (this.historyLoaded) {
            return;
        }
        // Start loading history
        const pending = this.doLoadPersistedHistory();
        this.historyLoadPromise = pending;
        try {
            await pending;
        }
        finally {
            if (this.historyLoadPromise === pending) {
                this.historyLoadPromise = undefined;
            }
        }
    }
    /**
     * Internal method to perform the actual history loading.
     * Uses configurable parameters from Config.getSessionRestoreConfig().
     *
     * TODO(Issue #1041): This method should use a callback instead of direct messageLogger access.
     * For now, it uses the getChatHistory callback if available.
     */
    async doLoadPersistedHistory() {
        const { chatId, logger, callbacks } = this.config;
        const { generation } = this;
        // Check if callback is available
        if (!callbacks.getChatHistory) {
            logger.debug({ chatId }, 'getChatHistory callback not available, skipping persisted history load');
            this.historyLoaded = true;
            return;
        }
        try {
            const sessionConfig = Config.getSessionRestoreConfig();
            logger.info({ chatId, days: sessionConfig.historyDays }, 'Loading persisted chat history for session restoration');
            // Use callback instead of direct messageLogger access
            const history = await callbacks.getChatHistory(chatId);
            if (generation !== this.generation || this.skipHistory) {
                return;
            }
            if (history && history.trim()) {
                // Cache the recency-selected source verbatim. The single consumption
                // boundary limits rendered length without selecting older-day tails.
                this._persistedHistoryContext = this.contextConsumed ? undefined : history;
                logger.info({ chatId, historyLength: history.length }, 'Persisted chat history loaded successfully');
            }
            else {
                logger.debug({ chatId }, 'No persisted chat history found');
            }
            // Issue #3996: Load chat log file paths so the agent knows where to find
            // full conversation history beyond the context window
            if (callbacks.getChatLogFilePaths) {
                const paths = await callbacks.getChatLogFilePaths(chatId);
                if (generation !== this.generation || this.skipHistory) {
                    return;
                }
                this._chatLogFilePaths = paths;
                if (this._chatLogFilePaths.length > 0) {
                    logger.info({ chatId, pathCount: this._chatLogFilePaths.length }, 'Chat log file paths loaded');
                }
            }
            this.historyLoaded = true;
        }
        catch (error) {
            if (generation !== this.generation || this.skipHistory) {
                return;
            }
            logger.error({ err: error, chatId }, 'Failed to load persisted chat history');
            // Mark as loaded even on error to prevent retry loops
            this.historyLoaded = true;
            // Issue #1357: Notify user that history restoration failed
            callbacks
                .sendMessage(chatId, '⚠️ 加载历史记录失败，将以全新会话开始。如果需要历史上下文，请发送 /reset 重置会话。')
                .catch(() => { });
        }
    }
    /**
     * Load chat history for first message context (Issue #1230).
     *
     * This method loads recent chat history to be attached to the first message
     * in a new agent session, providing context for the agent.
     *
     * Issue #1863: Added promise caching to prevent duplicate loads and
     * enable awaiting from processMessage() to fix race condition.
     *
     * @returns Promise that resolves when history is loaded
     */
    async loadFirstMessageHistory() {
        // If already loading, wait for the existing promise
        if (this.firstMessageHistoryLoadPromise) {
            return this.firstMessageHistoryLoadPromise;
        }
        // If already loaded, return immediately
        if (this.firstMessageHistoryLoaded) {
            return;
        }
        // Start loading history
        const pending = this.doLoadFirstMessageHistory();
        this.firstMessageHistoryLoadPromise = pending;
        try {
            await pending;
        }
        finally {
            if (this.firstMessageHistoryLoadPromise === pending) {
                this.firstMessageHistoryLoadPromise = undefined;
            }
        }
    }
    /**
     * Internal method to perform the actual first message history loading.
     */
    async doLoadFirstMessageHistory() {
        const { generation } = this;
        await this.loadPersistedHistory();
        if (generation !== this.generation || this.skipHistory) {
            return;
        }
        this._firstMessageHistoryContext = this.contextConsumed ? undefined : this._persistedHistoryContext;
        this.firstMessageHistoryLoaded = true;
    }
    /**
     * Clear all loaded history state so it can be reloaded.
     *
     * Called during /reset to drop the cached context (Issue #955, #1230).
     */
    reset() {
        this.generation++;
        this.contextConsumed = false;
        this._chatLogFilePaths = undefined;
        this.historyLoadPromise = undefined;
        this.firstMessageHistoryLoadPromise = undefined;
        // Clear persisted history context (Issue #955)
        this._persistedHistoryContext = undefined;
        this.historyLoaded = this.skipHistory;
        // Clear first message history context (Issue #1230)
        this._firstMessageHistoryContext = undefined;
        this.firstMessageHistoryLoaded = this.skipHistory;
    }
}
