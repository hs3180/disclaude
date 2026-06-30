/**
 * HistoryManager - Manages chat history loading for ChatAgent.
 *
 * Owns the loading lifecycle and cached state for two distinct concerns that
 * were previously inlined in ChatAgent:
 *  - Persisted (session-restore) history + chat log file paths (Issue #955, #3996)
 *  - First-message chat history context (Issue #1230)
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

import type { Logger } from 'pino';
import { Config } from '@disclaude/core';
import type { ChatAgentCallbacks } from './types.js';

/**
 * Configuration injected into HistoryManager (mirrors the config-object pattern
 * used by RestartManager / ConversationOrchestrator).
 */
export interface HistoryManagerConfig {
  /** The chatId this manager is bound to. */
  chatId: string;
  /** Logger instance. */
  logger: Logger;
  /** Channel callbacks (getChatHistory, getChatLogFilePaths, sendMessage). */
  callbacks: ChatAgentCallbacks;
}

/**
 * Manages loading and caching of chat history context for a ChatAgent instance.
 *
 * Loading is idempotent and concurrency-safe: concurrent callers of either
 * load method share the same in-flight promise. Once loaded, the result is
 * cached until reset().
 */
export class HistoryManager {
  // --- Load-state flags (Issue #955, #1230) ---
  /** Whether persisted (session-restore) history has finished loading. */
  historyLoaded = false;
  /** Whether first-message history has finished loading. */
  firstMessageHistoryLoaded = false;

  // --- Loaded context (read-only from the outside; see getters) ---
  /** Truncated persisted history attached to every message (session restore). */
  private _persistedHistoryContext?: string;
  /** Absolute paths to chat log files for access beyond the context window. */
  private _chatLogFilePaths?: string[];
  /** History attached only to the first message of a session (consume-once). */
  private _firstMessageHistoryContext?: string;

  // --- Internal plumbing (not part of the public surface) ---
  private historyLoadPromise?: Promise<void>;
  private firstMessageHistoryLoadPromise?: Promise<void>;

  constructor(private readonly config: HistoryManagerConfig) {}

  /** Truncated persisted history attached to every message (session restore). */
  get persistedHistoryContext(): string | undefined {
    return this._persistedHistoryContext;
  }

  /** Absolute paths to chat log files for access beyond the context window. */
  get chatLogFilePaths(): string[] | undefined {
    return this._chatLogFilePaths;
  }

  /** History attached only to the first message of a session (peek only). */
  get firstMessageHistoryContext(): string | undefined {
    return this._firstMessageHistoryContext;
  }

  /**
   * Return the first-message history context and clear it, so it is attached to
   * exactly one message (consume-once, Issue #1230). Subsequent calls return
   * undefined.
   */
  consumeFirstMessageContext(): string | undefined {
    const ctx = this._firstMessageHistoryContext;
    this._firstMessageHistoryContext = undefined;
    return ctx;
  }

  /**
   * Mark both history types as already-loaded without fetching. Used when the
   * agent is created with --no-context (Issue #3696).
   */
  markSkipped(): void {
    this.historyLoaded = true;
    this.firstMessageHistoryLoaded = true;
  }

  /**
   * Load persisted chat history for session restoration (Issue #955).
   *
   * Idempotent: concurrent callers share the same in-flight promise, and a
   * completed load is a no-op until reset().
   *
   * @returns Promise that resolves when history is loaded
   */
  async loadPersistedHistory(): Promise<void> {
    // If already loading, wait for the existing promise
    if (this.historyLoadPromise) {
      return this.historyLoadPromise;
    }

    // If already loaded, return immediately
    if (this.historyLoaded) {
      return;
    }

    // Start loading history
    this.historyLoadPromise = this.doLoadPersistedHistory();
    try {
      await this.historyLoadPromise;
    } finally {
      this.historyLoadPromise = undefined;
    }
  }

  /**
   * Internal method to perform the actual history loading.
   * Uses configurable parameters from Config.getSessionRestoreConfig().
   *
   * TODO(Issue #1041): This method should use a callback instead of direct messageLogger access.
   * For now, it uses the getChatHistory callback if available.
   */
  private async doLoadPersistedHistory(): Promise<void> {
    const { chatId, logger, callbacks } = this.config;
    // Check if callback is available
    if (!callbacks.getChatHistory) {
      logger.debug(
        { chatId },
        'getChatHistory callback not available, skipping persisted history load'
      );
      this.historyLoaded = true;
      return;
    }

    try {
      const sessionConfig = Config.getSessionRestoreConfig();

      logger.info(
        { chatId, days: sessionConfig.historyDays },
        'Loading persisted chat history for session restoration'
      );

      // Use callback instead of direct messageLogger access
      const history = await callbacks.getChatHistory(chatId);

      if (history && history.trim()) {
        // Truncation (and the maxContextLength budget) is handled inside
        // getChatHistory(); do NOT re-truncate here — a second slice(-maxLength)
        // would be a latent footgun that reintroduces the #4171 inverted-
        // direction bug if getChatHistory ever stops pre-truncating.
        this._persistedHistoryContext = history;

        logger.info(
          { chatId, historyLength: this._persistedHistoryContext.length },
          'Persisted chat history loaded successfully'
        );
      } else {
        logger.debug({ chatId }, 'No persisted chat history found');
      }

      // Issue #3996: Load chat log file paths so the agent knows where to find
      // full conversation history beyond the context window
      if (callbacks.getChatLogFilePaths) {
        this._chatLogFilePaths = await callbacks.getChatLogFilePaths(chatId);
        if (this._chatLogFilePaths.length > 0) {
          logger.info(
            { chatId, pathCount: this._chatLogFilePaths.length },
            'Chat log file paths loaded'
          );
        }
      }

      this.historyLoaded = true;
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to load persisted chat history');
      // Mark as loaded even on error to prevent retry loops
      this.historyLoaded = true;
      // Issue #1357: Notify user that history restoration failed
      callbacks
        .sendMessage(
          chatId,
          '⚠️ 加载历史记录失败，将以全新会话开始。如果需要历史上下文，请发送 /reset 重置会话。'
        )
        .catch(() => {});
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
  async loadFirstMessageHistory(): Promise<void> {
    // If already loading, wait for the existing promise
    if (this.firstMessageHistoryLoadPromise) {
      return this.firstMessageHistoryLoadPromise;
    }

    // If already loaded, return immediately
    if (this.firstMessageHistoryLoaded) {
      return;
    }

    // Start loading history
    this.firstMessageHistoryLoadPromise = this.doLoadFirstMessageHistory();
    try {
      await this.firstMessageHistoryLoadPromise;
    } finally {
      this.firstMessageHistoryLoadPromise = undefined;
    }
  }

  /**
   * Internal method to perform the actual first message history loading.
   */
  private async doLoadFirstMessageHistory(): Promise<void> {
    const { chatId, logger, callbacks } = this.config;
    try {
      logger.info({ chatId }, 'Loading chat history for first message context');

      const history = await callbacks.getChatHistory?.(chatId);

      if (history && history.trim()) {
        this._firstMessageHistoryContext = history;
        logger.info(
          { chatId, historyLength: this._firstMessageHistoryContext.length },
          'Chat history for first message loaded successfully'
        );
      } else {
        logger.debug({ chatId }, 'No chat history found for first message');
      }

      this.firstMessageHistoryLoaded = true;
    } catch (error) {
      logger.error({ err: error, chatId }, 'Failed to load chat history for first message');
      // Mark as loaded even on error to prevent retry loops
      this.firstMessageHistoryLoaded = true;
      // Issue #1357: Notify user about history load failure
      callbacks
        .sendMessage(chatId, '⚠️ 加载聊天记录失败，第一条消息可能缺少上下文。')
        .catch(() => {});
    }
  }

  /**
   * Clear all loaded history state so it can be reloaded.
   *
   * Called during /reset to drop the cached context (Issue #955, #1230).
   */
  reset(): void {
    // Clear persisted history context (Issue #955)
    this._persistedHistoryContext = undefined;
    this.historyLoaded = false;

    // Clear first message history context (Issue #1230)
    this._firstMessageHistoryContext = undefined;
    this.firstMessageHistoryLoaded = false;
  }
}
