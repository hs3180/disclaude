/**
 * ThreadManager - Manages multiple conversation threads per chatId.
 *
 * Issue #1072: Thread Management - 支持多对话切换
 *
 * This class provides:
 * - Thread creation and deletion
 * - Thread switching
 * - Thread persistence (JSON file storage)
 * - Thread listing and statistics
 */

import type pino from 'pino';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Represents a conversation thread.
 */
export interface Thread {
  /** Unique thread identifier */
  id: string;
  /** User-defined thread name */
  name: string;
  /** Platform-specific chat identifier */
  chatId: string;
  /** Creation timestamp (ms since epoch) */
  createdAt: number;
  /** Last update timestamp (ms since epoch) */
  updatedAt: number;
  /** Number of messages in this thread */
  messageCount: number;
  /** Thread root message ID for replies */
  threadRootId: string;
  /** Optional AI-generated summary of the thread */
  summary?: string;
}

/**
 * Thread state for a chatId (manages multiple threads).
 */
export interface ChatThreadState {
  /** All threads for this chat */
  threads: Map<string, Thread>;
  /** Currently active thread ID */
  currentThreadId: string | null;
  /** Thread counter for generating IDs */
  threadCounter: number;
}

/**
 * Configuration for ThreadManager.
 */
export interface ThreadManagerConfig {
  /** Logger instance */
  logger: pino.Logger;
  /** Optional storage directory for persistence (defaults to OS temp dir) */
  storageDir?: string;
}

/**
 * ThreadManager - Manages conversation threads.
 *
 * Each chatId can have multiple named threads, with one active at a time.
 * Threads are persisted to JSON files for recovery after restart.
 */
export class ThreadManager {
  private readonly logger: pino.Logger;
  private readonly storageDir: string;
  /** Map of chatId → ChatThreadState */
  private readonly chatStates = new Map<string, ChatThreadState>();

  constructor(config: ThreadManagerConfig) {
    this.logger = config.logger;
    this.storageDir = config.storageDir || path.join(process.cwd(), '.threads');
    this.ensureStorageDir();
  }

  /**
   * Ensure the storage directory exists.
   */
  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  /**
   * Get or create thread state for a chatId.
   */
  private getOrCreateState(chatId: string): ChatThreadState {
    let state = this.chatStates.get(chatId);
    if (!state) {
      state = {
        threads: new Map(),
        currentThreadId: null,
        threadCounter: 0,
      };
      this.chatStates.set(chatId, state);
      // Try to load persisted state
      this.loadState(chatId);
    }
    return state;
  }

  /**
   * Get the storage file path for a chatId.
   */
  private getStoragePath(chatId: string): string {
    // Sanitize chatId for filesystem
    const safeId = chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.storageDir, `threads_${safeId}.json`);
  }

  /**
   * Persist thread state to disk.
   */
  private saveState(chatId: string): void {
    const state = this.chatStates.get(chatId);
    if (!state) {
      return;
    }

    const data = {
      threads: Array.from(state.threads.values()),
      currentThreadId: state.currentThreadId,
      threadCounter: state.threadCounter,
    };

    try {
      fs.writeFileSync(this.getStoragePath(chatId), JSON.stringify(data, null, 2));
    } catch (error) {
      this.logger.error({ chatId, error }, 'Failed to save thread state');
    }
  }

  /**
   * Load persisted thread state from disk.
   */
  private loadState(chatId: string): void {
    const state = this.chatStates.get(chatId);
    if (!state) {
      return;
    }

    const filePath = this.getStoragePath(chatId);
    if (!fs.existsSync(filePath)) {
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      state.threads = new Map(data.threads.map((t: Thread) => [t.id, t]));
      state.currentThreadId = data.currentThreadId;
      state.threadCounter = data.threadCounter;
      this.logger.debug({ chatId, threadCount: state.threads.size }, 'Thread state loaded');
    } catch (error) {
      this.logger.error({ chatId, error }, 'Failed to load thread state');
    }
  }

  /**
   * Generate a unique thread ID.
   */
  private generateThreadId(chatId: string): string {
    const state = this.getOrCreateState(chatId);
    state.threadCounter++;
    return `thread_${state.threadCounter}`;
  }

  /**
   * Create a new thread.
   *
   * @param chatId - The chat identifier
   * @param name - Thread name
   * @param threadRootId - Initial thread root message ID
   * @returns The created thread
   */
  createThread(chatId: string, name: string, threadRootId: string): Thread {
    const state = this.getOrCreateState(chatId);
    const now = Date.now();
    const thread: Thread = {
      id: this.generateThreadId(chatId),
      name,
      chatId,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      threadRootId,
    };

    state.threads.set(thread.id, thread);
    // If this is the first thread, make it current
    if (state.threads.size === 1) {
      state.currentThreadId = thread.id;
    }

    this.saveState(chatId);
    this.logger.debug({ chatId, threadId: thread.id, name }, 'Thread created');
    return thread;
  }

  /**
   * Save current conversation as a new thread.
   * This is the primary method for creating threads from existing conversations.
   *
   * @param chatId - The chat identifier
   * @param name - Thread name
   * @param currentThreadRootId - Current thread root to save
   * @returns The created thread
   */
  saveCurrentAsThread(chatId: string, name: string, currentThreadRootId: string): Thread {
    const state = this.getOrCreateState(chatId);

    // Check if name already exists
    for (const thread of state.threads.values()) {
      if (thread.name === name) {
        throw new Error(`Thread "${name}" already exists`);
      }
    }

    return this.createThread(chatId, name, currentThreadRootId);
  }

  /**
   * Switch to a different thread.
   *
   * @param chatId - The chat identifier
   * @param threadIdOrName - Thread ID or name to switch to
   * @returns The switched-to thread, or undefined if not found
   */
  switchThread(chatId: string, threadIdOrName: string): Thread | undefined {
    const state = this.getOrCreateState(chatId);

    // Find thread by ID or name
    let thread = state.threads.get(threadIdOrName);
    if (!thread) {
      // Try to find by name
      for (const t of state.threads.values()) {
        if (t.name === threadIdOrName) {
          thread = t;
          break;
        }
      }
    }

    if (!thread) {
      return undefined;
    }

    state.currentThreadId = thread.id;
    this.saveState(chatId);
    this.logger.debug({ chatId, threadId: thread.id, name: thread.name }, 'Switched to thread');
    return thread;
  }

  /**
   * Get the current active thread.
   *
   * @param chatId - The chat identifier
   * @returns The current thread, or undefined if none
   */
  getCurrentThread(chatId: string): Thread | undefined {
    const state = this.getOrCreateState(chatId);
    if (!state.currentThreadId) {
      return undefined;
    }
    return state.threads.get(state.currentThreadId);
  }

  /**
   * List all threads for a chatId.
   *
   * @param chatId - The chat identifier
   * @returns Array of threads, sorted by creation time (newest first)
   */
  listThreads(chatId: string): Thread[] {
    const state = this.getOrCreateState(chatId);
    return Array.from(state.threads.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Delete a thread.
   *
   * @param chatId - The chat identifier
   * @param threadIdOrName - Thread ID or name to delete
   * @returns true if deleted, false if not found
   */
  deleteThread(chatId: string, threadIdOrName: string): boolean {
    const state = this.getOrCreateState(chatId);

    // Find thread by ID or name
    let threadId = threadIdOrName;
    if (!state.threads.has(threadId)) {
      // Try to find by name
      for (const [id, t] of state.threads) {
        if (t.name === threadIdOrName) {
          threadId = id;
          break;
        }
      }
    }

    const deleted = state.threads.delete(threadId);
    if (deleted) {
      // If deleted thread was current, clear currentThreadId
      if (state.currentThreadId === threadId) {
        state.currentThreadId = state.threads.size > 0
          ? Array.from(state.threads.keys())[0]
          : null;
      }
      this.saveState(chatId);
      this.logger.debug({ chatId, threadId }, 'Thread deleted');
    }
    return deleted;
  }

  /**
   * Rename a thread.
   *
   * @param chatId - The chat identifier
   * @param oldName - Current thread name
   * @param newName - New thread name
   * @returns The updated thread, or undefined if not found
   */
  renameThread(chatId: string, oldName: string, newName: string): Thread | undefined {
    const state = this.getOrCreateState(chatId);

    // Find thread by old name
    let thread: Thread | undefined;
    for (const t of state.threads.values()) {
      if (t.name === oldName) {
        thread = t;
        break;
      }
    }

    if (!thread) {
      return undefined;
    }

    // Check if new name already exists
    for (const t of state.threads.values()) {
      if (t.id !== thread.id && t.name === newName) {
        throw new Error(`Thread "${newName}" already exists`);
      }
    }

    thread.name = newName;
    thread.updatedAt = Date.now();
    this.saveState(chatId);
    this.logger.debug({ chatId, threadId: thread.id, oldName, newName }, 'Thread renamed');
    return thread;
  }

  /**
   * Update thread message count.
   *
   * @param chatId - The chat identifier
   * @param threadId - Thread ID to update
   */
  incrementMessageCount(chatId: string, threadId: string): void {
    const state = this.chatStates.get(chatId);
    if (!state) {
      return;
    }

    const thread = state.threads.get(threadId);
    if (thread) {
      thread.messageCount++;
      thread.updatedAt = Date.now();
      // Don't save on every message for performance
    }
  }

  /**
   * Set thread summary.
   *
   * @param chatId - The chat identifier
   * @param threadId - Thread ID to update
   * @param summary - AI-generated summary
   */
  setThreadSummary(chatId: string, threadId: string, summary: string): void {
    const state = this.chatStates.get(chatId);
    if (!state) {
      return;
    }

    const thread = state.threads.get(threadId);
    if (thread) {
      thread.summary = summary;
      thread.updatedAt = Date.now();
      this.saveState(chatId);
    }
  }

  /**
   * Get the number of threads for a chatId.
   */
  getThreadCount(chatId: string): number {
    const state = this.chatStates.get(chatId);
    return state?.threads.size ?? 0;
  }

  /**
   * Clear all threads for a chatId.
   */
  clearThreads(chatId: string): void {
    this.chatStates.delete(chatId);
    const filePath = this.getStoragePath(chatId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    this.logger.debug({ chatId }, 'All threads cleared');
  }

  /**
   * Close all threads and clear tracking.
   * Used during shutdown.
   */
  closeAll(): void {
    // Save all states before clearing
    for (const chatId of this.chatStates.keys()) {
      this.saveState(chatId);
    }
    this.chatStates.clear();
    this.logger.info('All thread states closed');
  }
}
