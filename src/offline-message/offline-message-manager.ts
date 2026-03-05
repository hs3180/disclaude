/**
 * Offline Message Manager - Manages non-blocking messages and reply callbacks.
 *
 * Issue #631: 离线提问 - Agent 不阻塞工作的留言机制
 *
 * This manager tracks offline messages sent by agents and handles
 * user replies by triggering new tasks.
 *
 * Features:
 * - Register offline messages with context and callbacks
 * - Match incoming replies to pending offline messages
 * - Trigger follow-up tasks when users reply
 * - Automatic cleanup of expired entries
 */

import { createLogger } from '../utils/logger.js';
import type { AgentPool } from '../agents/agent-pool.js';
import type {
  OfflineMessageEntry,
  OfflineMessageContext,
  OfflineMessageCallback,
  OfflineMessageManagerOptions,
  ReplyHandleResult,
} from './types.js';
import { randomUUID } from 'crypto';

const logger = createLogger('OfflineMessageManager');

/**
 * Default timeout for offline messages (24 hours).
 */
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * Default cleanup interval (1 hour).
 */
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Default maximum pending messages per chat.
 */
const DEFAULT_MAX_PER_CHAT = 10;

/**
 * Global instance of OfflineMessageManager.
 * Set during application initialization.
 */
let globalInstance: OfflineMessageManager | null = null;

/**
 * Get the global OfflineMessageManager instance.
 * Throws if not initialized.
 */
export function getOfflineMessageManager(): OfflineMessageManager {
  if (!globalInstance) {
    throw new Error('OfflineMessageManager not initialized. Call setOfflineMessageManager first.');
  }
  return globalInstance;
}

/**
 * Set the global OfflineMessageManager instance.
 */
export function setOfflineMessageManager(manager: OfflineMessageManager | null): void {
  globalInstance = manager;
  logger.debug({ hasInstance: !!manager }, 'Global OfflineMessageManager updated');
}

/**
 * OfflineMessageManager - Manages offline messages and reply handling.
 *
 * Usage:
 * ```typescript
 * const manager = new OfflineMessageManager({
 *   agentPool,
 *   defaultTimeoutMs: 24 * 60 * 60 * 1000, // 24 hours
 * });
 *
 * // Register an offline message
 * const entry = manager.register({
 *   messageId: 'om_xxx',
 *   chatId: 'oc_xxx',
 *   context: {
 *     topic: 'Daily review',
 *     question: 'Should we automate this task?',
 *     sourceChatId: 'oc_xxx',
 *     createdAt: Date.now(),
 *   },
 *   callback: {
 *     type: 'new_task',
 *     promptTemplate: 'User replied: {{reply}}. Context: {{context.question}}',
 *   },
 * });
 *
 * // Handle incoming reply
 * const result = await manager.handleReply({
 *   chatId: 'oc_xxx',
 *   parentMessageId: 'om_xxx',
 *   replyContent: 'Yes, please automate it',
 * });
 * ```
 */
export class OfflineMessageManager {
  private entries: Map<string, OfflineMessageEntry> = new Map();
  private byMessageId: Map<string, string> = new Map(); // messageId -> entryId
  private agentPool?: AgentPool;
  private defaultTimeoutMs: number;
  private cleanupIntervalMs: number;
  private maxPerChat: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(options: OfflineMessageManagerOptions & { agentPool?: AgentPool } = {}) {
    this.agentPool = options.agentPool;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
    this.maxPerChat = options.maxPerChat ?? DEFAULT_MAX_PER_CHAT;

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), this.cleanupIntervalMs);

    logger.info({
      defaultTimeoutMs: this.defaultTimeoutMs,
      cleanupIntervalMs: this.cleanupIntervalMs,
      maxPerChat: this.maxPerChat,
    }, 'OfflineMessageManager created');
  }

  /**
   * Set the AgentPool for triggering follow-up tasks.
   */
  setAgentPool(agentPool: AgentPool): void {
    this.agentPool = agentPool;
    logger.debug('AgentPool set');
  }

  /**
   * Register a new offline message.
   *
   * @param params - Registration parameters
   * @returns The created entry
   */
  register(params: {
    messageId: string;
    chatId: string;
    context: OfflineMessageContext;
    callback: OfflineMessageCallback;
    timeoutMs?: number;
  }): OfflineMessageEntry {
    const { messageId, chatId, context, callback, timeoutMs } = params;
    const now = Date.now();
    const entryId = randomUUID();
    const timeout = timeoutMs ?? callback.timeoutMs ?? this.defaultTimeoutMs;

    // Check max per chat limit
    const chatEntries = this.findByChatId(chatId);
    if (chatEntries.length >= this.maxPerChat) {
      // Remove oldest entry for this chat
      const oldest = chatEntries.sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        this.unregister(oldest.id);
        logger.info({ chatId, removedId: oldest.id }, 'Removed oldest entry to make room');
      }
    }

    const entry: OfflineMessageEntry = {
      id: entryId,
      messageId,
      chatId,
      context,
      callback,
      createdAt: now,
      expiresAt: now + timeout,
    };

    this.entries.set(entryId, entry);
    this.byMessageId.set(messageId, entryId);

    logger.info({
      entryId,
      messageId,
      chatId,
      callbackType: callback.type,
      expiresAt: new Date(entry.expiresAt).toISOString(),
    }, 'Offline message registered');

    return entry;
  }

  /**
   * Unregister an offline message.
   *
   * @param entryId - Entry ID to unregister
   * @returns Whether the entry was found and removed
   */
  unregister(entryId: string): boolean {
    const entry = this.entries.get(entryId);
    if (entry) {
      this.entries.delete(entryId);
      this.byMessageId.delete(entry.messageId);
      logger.debug({ entryId }, 'Offline message unregistered');
      return true;
    }
    return false;
  }

  /**
   * Find an entry by message ID.
   *
   * @param messageId - Feishu message ID
   * @returns The entry or undefined
   */
  findByMessageId(messageId: string): OfflineMessageEntry | undefined {
    const entryId = this.byMessageId.get(messageId);
    if (entryId) {
      return this.entries.get(entryId);
    }
    return undefined;
  }

  /**
   * Find all entries for a chat.
   *
   * @param chatId - Chat ID
   * @returns Array of matching entries
   */
  findByChatId(chatId: string): OfflineMessageEntry[] {
    const results: OfflineMessageEntry[] = [];
    for (const entry of this.entries.values()) {
      if (entry.chatId === chatId) {
        results.push(entry);
      }
    }
    return results;
  }

  /**
   * Handle an incoming reply message.
   *
   * This method checks if the reply is for a registered offline message
   * and triggers the appropriate callback if found.
   *
   * @param params - Reply parameters
   * @returns Result of handling the reply
   */
  async handleReply(params: {
    chatId: string;
    parentMessageId: string;
    replyContent: string;
    userId?: string;
  }): Promise<ReplyHandleResult> {
    const { chatId, parentMessageId, replyContent, userId } = params;

    logger.info({
      chatId,
      parentMessageId,
      replyLength: replyContent.length,
      userId,
    }, 'Handling reply for offline message');

    // Find the entry by parent message ID
    const entry = this.findByMessageId(parentMessageId);

    if (!entry) {
      logger.debug({ parentMessageId }, 'No matching offline message found');
      return { success: true, matched: false };
    }

    // Check if entry has expired
    if (entry.expiresAt < Date.now()) {
      logger.info({ entryId: entry.id }, 'Offline message has expired');
      this.unregister(entry.id);
      return { success: true, matched: false };
    }

    // Check chat ID match
    if (entry.chatId !== chatId) {
      logger.warn(
        { entryChatId: entry.chatId, replyChatId: chatId },
        'Chat ID mismatch for reply'
      );
      return { success: true, matched: false };
    }

    // Build the follow-up prompt
    const followUpPrompt = this.buildFollowUpPrompt(entry, replyContent, userId);

    logger.info({
      entryId: entry.id,
      callbackType: entry.callback.type,
      promptLength: followUpPrompt.length,
    }, 'Triggering follow-up task');

    // Trigger the follow-up task
    try {
      await this.triggerFollowUpTask(entry, followUpPrompt);

      // Remove the entry after successful handling
      this.unregister(entry.id);

      return {
        success: true,
        matched: true,
        triggeredTaskId: entry.id,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, entryId: entry.id }, 'Failed to trigger follow-up task');
      return {
        success: false,
        matched: true,
        error: errorMessage,
      };
    }
  }

  /**
   * Build the follow-up prompt from template and context.
   */
  private buildFollowUpPrompt(
    entry: OfflineMessageEntry,
    replyContent: string,
    userId?: string
  ): string {
    let prompt = entry.callback.promptTemplate;

    // Replace placeholders
    prompt = prompt.replace(/\{\{reply\}\}/g, replyContent);
    prompt = prompt.replace(/\{\{context\.topic\}\}/g, entry.context.topic);
    prompt = prompt.replace(/\{\{context\.question\}\}/g, entry.context.question);
    prompt = prompt.replace(/\{\{userId\}\}/g, userId ?? 'unknown');

    // Replace metadata placeholders
    if (entry.context.metadata) {
      for (const [key, value] of Object.entries(entry.context.metadata)) {
        prompt = prompt.replace(
          new RegExp(`\\{\\{context\\.metadata\\.${key}\\}\\}`, 'g'),
          String(value)
        );
      }
    }

    return prompt;
  }

  /**
   * Trigger the follow-up task.
   */
  private async triggerFollowUpTask(
    entry: OfflineMessageEntry,
    prompt: string
  ): Promise<void> {
    if (!this.agentPool) {
      logger.warn('No AgentPool available, cannot trigger follow-up task');
      return;
    }

    // Get or create a Pilot for this chat
    const pilot = this.agentPool.getOrCreate(entry.chatId);

    // Execute the follow-up task
    await pilot.executeOnce(
      entry.chatId,
      prompt,
      undefined // messageId - new message, not a reply
    );

    logger.info({ chatId: entry.chatId }, 'Follow-up task triggered');
  }

  /**
   * Cleanup expired entries.
   */
  cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, entry] of this.entries) {
      if (entry.expiresAt < now) {
        this.entries.delete(id);
        this.byMessageId.delete(entry.messageId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.info({ count: cleaned }, 'Cleaned up expired offline messages');
    }
  }

  /**
   * Get all active entries.
   */
  getAll(): OfflineMessageEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * Get count of active entries.
   */
  get count(): number {
    return this.entries.size;
  }

  /**
   * Dispose the manager and cleanup resources.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.entries.clear();
    this.byMessageId.clear();
    logger.info('OfflineMessageManager disposed');
  }
}

// Re-export types
export type {
  OfflineMessageEntry,
  OfflineMessageContext,
  OfflineMessageCallback,
  OfflineMessageManagerOptions,
  ReplyHandleResult,
  SendOfflineMessageResult,
} from './types.js';
