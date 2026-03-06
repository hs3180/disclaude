/**
 * Offline Message Store - Manages offline message contexts.
 *
 * This module stores context for messages sent via the `leave_message` tool,
 * enabling callback triggers when users reply to these messages.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * Architecture:
 * ```
 * Agent calls leave_message
 *     ↓
 * OfflineMessageStore.save(messageId, context)
 *     ↓
 * User replies to message
 *     ↓
 * MessageHandler checks store
 *     ↓
 * If found: trigger callback (create Task/skill)
 * ```
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';

const logger = createLogger('OfflineMessageStore');

/**
 * Context for an offline message.
 */
export interface OfflineMessageContext {
  /** Unique identifier (messageId) */
  id: string;
  /** Chat ID where the message was sent */
  chatId: string;
  /** The question/topic left for the user */
  question: string;
  /** Optional options that were presented */
  options?: string[];
  /** Context from the agent when leaving the message */
  agentContext?: string;
  /** Callback action to trigger when user replies */
  callbackAction: 'create_task' | 'trigger_skill' | 'record_knowledge';
  /** Callback parameters */
  callbackParams?: Record<string, unknown>;
  /** Creation timestamp */
  createdAt: number;
  /** Expiration timestamp */
  expiresAt: number;
  /** Whether this message has been handled */
  handled: boolean;
}

/**
 * Configuration for OfflineMessageStore.
 */
export interface OfflineMessageStoreConfig {
  /** File path for persistence */
  filePath?: string;
  /** Default TTL in milliseconds (7 days) */
  defaultTtl?: number;
  /** Cleanup interval in milliseconds */
  cleanupInterval?: number;
}

const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

/**
 * Store for offline message contexts.
 *
 * Features:
 * - Persist message contexts to file
 * - Find context by message ID
 * - Auto-cleanup expired messages
 * - Mark messages as handled
 *
 * @example
 * ```typescript
 * const store = new OfflineMessageStore();
 *
 * // Save a message context
 * await store.save({
 *   id: 'om_xxx',
 *   chatId: 'oc_xxx',
 *   question: 'How should we proceed?',
 *   callbackAction: 'create_task',
 * });
 *
 * // Find by message ID
 * const context = store.findByMessageId('om_xxx');
 * ```
 */
export class OfflineMessageStore {
  private messages: Map<string, OfflineMessageContext> = new Map();
  private filePath: string;
  private defaultTtl: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private initialized = false;

  constructor(config: OfflineMessageStoreConfig = {}) {
    const workspaceDir = Config.getWorkspaceDir();
    this.filePath = config.filePath ?? path.join(workspaceDir, '.offline-messages.json');
    this.defaultTtl = config.defaultTtl ?? DEFAULT_TTL;

    // Start cleanup timer
    const cleanupInterval = config.cleanupInterval ?? CLEANUP_INTERVAL;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), cleanupInterval);

    logger.debug({ filePath: this.filePath }, 'OfflineMessageStore created');
  }

  /**
   * Initialize the store by loading persisted messages.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const data = await fs.readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(data) as OfflineMessageContext[];
      for (const context of parsed) {
        // Skip expired messages
        if (context.expiresAt > Date.now() && !context.handled) {
          this.messages.set(context.id, context);
        }
      }
      logger.info({ count: this.messages.size }, 'Loaded offline messages from file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.error({ err: error }, 'Failed to load offline messages');
      }
      // File doesn't exist yet, that's fine
    }

    this.initialized = true;
  }

  /**
   * Save a new offline message context.
   *
   * @param context - Context to save (without id, createdAt, expiresAt, handled)
   * @returns The saved context with generated fields
   */
  async save(context: Omit<OfflineMessageContext, 'createdAt' | 'expiresAt' | 'handled'>): Promise<OfflineMessageContext> {
    await this.ensureInitialized();

    const now = Date.now();
    const fullContext: OfflineMessageContext = {
      ...context,
      createdAt: now,
      expiresAt: now + this.defaultTtl,
      handled: false,
    };

    this.messages.set(context.id, fullContext);
    await this.persist();

    logger.info({
      id: context.id,
      chatId: context.chatId,
      callbackAction: context.callbackAction,
    }, 'Offline message saved');

    return fullContext;
  }

  /**
   * Find a message context by message ID.
   *
   * @param messageId - The message ID to search for
   * @returns The context or undefined
   */
  async findByMessageId(messageId: string): Promise<OfflineMessageContext | undefined> {
    await this.ensureInitialized();
    return this.messages.get(messageId);
  }

  /**
   * Find all messages for a chat.
   *
   * @param chatId - Chat ID to filter by
   * @returns Array of matching contexts
   */
  async findByChatId(chatId: string): Promise<OfflineMessageContext[]> {
    await this.ensureInitialized();
    return Array.from(this.messages.values()).filter(m => m.chatId === chatId);
  }

  /**
   * Mark a message as handled.
   *
   * @param messageId - Message ID to mark
   */
  async markHandled(messageId: string): Promise<void> {
    await this.ensureInitialized();

    const context = this.messages.get(messageId);
    if (context) {
      context.handled = true;
      await this.persist();
      logger.info({ id: messageId }, 'Offline message marked as handled');
    }
  }

  /**
   * Remove a message from the store.
   *
   * @param messageId - Message ID to remove
   */
  async remove(messageId: string): Promise<void> {
    await this.ensureInitialized();

    const removed = this.messages.delete(messageId);
    if (removed) {
      await this.persist();
      logger.debug({ id: messageId }, 'Offline message removed');
    }
  }

  /**
   * Get all active (unhandled, unexpired) messages.
   *
   * @returns Array of active contexts
   */
  async getActive(): Promise<OfflineMessageContext[]> {
    await this.ensureInitialized();
    const now = Date.now();
    return Array.from(this.messages.values()).filter(
      m => !m.handled && m.expiresAt > now
    );
  }

  /**
   * Get count of active messages.
   */
  get count(): number {
    return this.messages.size;
  }

  /**
   * Cleanup expired messages.
   */
  async cleanupExpired(): Promise<void> {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, context] of this.messages) {
      if (context.expiresAt < now || context.handled) {
        this.messages.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      await this.persist();
      logger.info({ count: cleaned }, 'Cleaned up expired offline messages');
    }
  }

  /**
   * Dispose the store and cleanup resources.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    logger.debug('OfflineMessageStore disposed');
  }

  /**
   * Ensure the store is initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Persist messages to file.
   */
  private async persist(): Promise<void> {
    try {
      const data = JSON.stringify(Array.from(this.messages.values()), null, 2);
      await fs.writeFile(this.filePath, data, 'utf-8');
      logger.debug({ count: this.messages.size }, 'Persisted offline messages');
    } catch (error) {
      logger.error({ err: error }, 'Failed to persist offline messages');
    }
  }
}

// Singleton instance
let storeInstance: OfflineMessageStore | null = null;

/**
 * Get the singleton OfflineMessageStore instance.
 */
export function getOfflineMessageStore(): OfflineMessageStore {
  if (!storeInstance) {
    storeInstance = new OfflineMessageStore();
  }
  return storeInstance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetOfflineMessageStore(): void {
  if (storeInstance) {
    storeInstance.dispose();
    storeInstance = null;
  }
}
