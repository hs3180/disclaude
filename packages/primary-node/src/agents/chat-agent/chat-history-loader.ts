/**
 * ChatHistoryLoader - Manages loading and caching of chat history.
 *
 * Extracted from ChatAgent (Issue #2345 Phase 3) to reduce file size.
 *
 * Handles two types of history loading:
 * - Persisted history: Full chat history for session restoration (Issue #955)
 * - First message history: Chat history attached to the first message of a new session (Issue #1230)
 *
 * Both loaders use promise deduplication to prevent concurrent loads.
 */

import type { Logger } from 'pino';

/**
 * Callbacks needed by ChatHistoryLoader.
 * Extracted from ChatAgentCallbacks to minimize coupling.
 */
export interface HistoryLoaderCallbacks {
  getChatHistory?: (chatId: string) => Promise<string | undefined>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
}

/**
 * Session restore configuration.
 * Mirrors Config.getSessionRestoreConfig() shape.
 */
interface SessionRestoreConfig {
  historyDays: number;
  maxContextLength: number;
}

/**
 * ChatHistoryLoader - Loads and caches chat history for a single chatId.
 *
 * This class is instantiated per-ChatAgent and manages its own state.
 * All methods are safe to call concurrently — promise deduplication
 * ensures only one load operation runs at a time.
 */
export class ChatHistoryLoader {
  private readonly chatId: string;
  private readonly logger: Logger;

  // Persisted history state (Issue #955)
  private persistedHistoryContext?: string;
  private historyLoaded = false;
  private historyLoadPromise?: Promise<void>;

  // First message history state (Issue #1230)
  private firstMessageHistoryContext?: string;
  private firstMessageHistoryLoaded = false;
  private firstMessageHistoryLoadPromise?: Promise<void>;

  constructor(chatId: string, logger: Logger) {
    this.chatId = chatId;
    this.logger = logger;
  }

  /**
   * Load persisted chat history for session restoration (Issue #955).
   * Uses promise deduplication to prevent concurrent loads.
   */
  async loadPersistedHistory(
    callbacks: HistoryLoaderCallbacks,
    sessionConfig: SessionRestoreConfig,
  ): Promise<void> {
    if (this.historyLoadPromise) {
      return this.historyLoadPromise;
    }

    if (this.historyLoaded) {
      return;
    }

    this.historyLoadPromise = this.doLoadPersistedHistory(callbacks, sessionConfig);
    try {
      await this.historyLoadPromise;
    } finally {
      this.historyLoadPromise = undefined;
    }
  }

  /**
   * Load chat history for first message context (Issue #1230).
   * Uses promise deduplication to prevent concurrent loads (Issue #1863).
   */
  async loadFirstMessageHistory(callbacks: HistoryLoaderCallbacks): Promise<void> {
    if (this.firstMessageHistoryLoadPromise) {
      return this.firstMessageHistoryLoadPromise;
    }

    if (this.firstMessageHistoryLoaded) {
      return;
    }

    this.firstMessageHistoryLoadPromise = this.doLoadFirstMessageHistory(callbacks);
    try {
      await this.firstMessageHistoryLoadPromise;
    } finally {
      this.firstMessageHistoryLoadPromise = undefined;
    }
  }

  // --- Accessors ---

  /** Get the persisted history context (for session restoration). */
  getPersistedContext(): string | undefined {
    return this.persistedHistoryContext;
  }

  /** Check if persisted history has been loaded. */
  isHistoryLoaded(): boolean {
    return this.historyLoaded;
  }

  /** Check if first message history has been loaded. */
  isFirstMessageHistoryLoaded(): boolean {
    return this.firstMessageHistoryLoaded;
  }

  /**
   * Consume (get and clear) first message history context.
   * Returns the context and clears it so it's only used once.
   */
  consumeFirstMessageContext(): string | undefined {
    const context = this.firstMessageHistoryContext;
    this.firstMessageHistoryContext = undefined;
    return context;
  }

  /** Clear all history state (used during reset). */
  clearAll(): void {
    this.persistedHistoryContext = undefined;
    this.historyLoaded = false;
    this.firstMessageHistoryContext = undefined;
    this.firstMessageHistoryLoaded = false;
  }

  // --- Private methods ---

  private async doLoadPersistedHistory(
    callbacks: HistoryLoaderCallbacks,
    sessionConfig: SessionRestoreConfig,
  ): Promise<void> {
    if (!callbacks.getChatHistory) {
      this.logger.debug(
        { chatId: this.chatId },
        'getChatHistory callback not available, skipping persisted history load',
      );
      this.historyLoaded = true;
      return;
    }

    try {
      this.logger.info(
        { chatId: this.chatId, days: sessionConfig.historyDays },
        'Loading persisted chat history for session restoration',
      );

      const history = await callbacks.getChatHistory(this.chatId);

      if (history && history.trim()) {
        this.persistedHistoryContext = history.length > sessionConfig.maxContextLength
          ? history.slice(-sessionConfig.maxContextLength)
          : history;

        this.logger.info(
          { chatId: this.chatId, historyLength: this.persistedHistoryContext.length },
          'Persisted chat history loaded successfully',
        );
      } else {
        this.logger.debug(
          { chatId: this.chatId },
          'No persisted chat history found',
        );
      }

      this.historyLoaded = true;
    } catch (error) {
      this.logger.error(
        { err: error, chatId: this.chatId },
        'Failed to load persisted chat history',
      );
      this.historyLoaded = true;
      // Issue #1357: Notify user that history restoration failed
      callbacks.sendMessage(
        this.chatId,
        '⚠️ 加载历史记录失败，将以全新会话开始。如果需要历史上下文，请发送 /reset 重置会话。',
      ).catch(() => {});
    }
  }

  private async doLoadFirstMessageHistory(
    callbacks: HistoryLoaderCallbacks,
  ): Promise<void> {
    try {
      this.logger.info(
        { chatId: this.chatId },
        'Loading chat history for first message context',
      );

      const history = await callbacks.getChatHistory?.(this.chatId);

      if (history && history.trim()) {
        this.firstMessageHistoryContext = history;
        this.logger.info(
          { chatId: this.chatId, historyLength: this.firstMessageHistoryContext.length },
          'Chat history for first message loaded successfully',
        );
      } else {
        this.logger.debug(
          { chatId: this.chatId },
          'No chat history found for first message',
        );
      }

      this.firstMessageHistoryLoaded = true;
    } catch (error) {
      this.logger.error(
        { err: error, chatId: this.chatId },
        'Failed to load chat history for first message',
      );
      this.firstMessageHistoryLoaded = true;
      // Issue #1357: Notify user about history load failure
      callbacks.sendMessage(
        this.chatId,
        '⚠️ 加载聊天记录失败，第一条消息可能缺少上下文。',
      ).catch(() => {});
    }
  }
}
