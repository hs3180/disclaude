/**
 * TempChatLifecycleService - Orchestrates temporary chat lifecycle.
 *
 * Issue #1703: Phase 3 — Primary Node lifecycle service.
 * Periodically checks for expired temp chats and cleans them up
 * (dissolve group → unregister from GroupService → remove record).
 *
 * This service runs in the Primary Node and coordinates:
 * - ChatStore (core data layer) for record management
 * - dissolveChat (platform API) for group dissolution
 * - GroupService for group registry cleanup
 *
 * @module services/temp-chat-lifecycle-service
 */

import { createLogger, type TempChatRecord, ChatStore } from '@disclaude/core';

const logger = createLogger('TempChatLifecycle');

/**
 * Dependencies required by TempChatLifecycleService.
 * Injected at construction to allow testing and decoupling.
 */
export interface TempChatLifecycleDeps {
  /** ChatStore instance for temp chat record management */
  chatStore: ChatStore;
  /**
   * Dissolve a group chat via platform API.
   * May be undefined if the platform doesn't support group dissolution.
   */
  dissolveChat?: (chatId: string) => Promise<void>;
  /**
   * Unregister a group from the GroupService registry.
   * May be undefined if no GroupService is available.
   */
  unregisterGroup?: (chatId: string) => boolean;
}

/**
 * Configuration for TempChatLifecycleService.
 */
export interface TempChatLifecycleConfig {
  /** Check interval in milliseconds (default: 5 minutes) */
  checkIntervalMs?: number;
}

/**
 * Result of a single cleanup cycle.
 */
export interface CleanupResult {
  /** Number of chats cleaned up */
  cleaned: number;
  /** Details of each cleanup attempt */
  details: Array<{
    chatId: string;
    success: boolean;
    error?: string;
  }>;
}

/**
 * TempChatLifecycleService - Manages automatic cleanup of expired temp chats.
 *
 * Usage:
 * ```typescript
 * const service = new TempChatLifecycleService({
 *   chatStore: new ChatStore({ storeDir: './workspace/schedules/.temp-chats' }),
 *   dissolveChat: (chatId) => feishuChannel.dissolveChat(chatId),
 *   unregisterGroup: (chatId) => groupService.unregisterGroup(chatId),
 * });
 *
 * await service.start();  // Starts periodic cleanup
 * await service.stop();   // Stops periodic cleanup
 * ```
 */
export class TempChatLifecycleService {
  private chatStore: ChatStore;
  private dissolveChatFn?: (chatId: string) => Promise<void>;
  private unregisterGroupFn?: (chatId: string) => boolean;
  private checkIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(deps: TempChatLifecycleDeps, config: TempChatLifecycleConfig = {}) {
    this.chatStore = deps.chatStore;
    this.dissolveChatFn = deps.dissolveChat;
    this.unregisterGroupFn = deps.unregisterGroup;
    this.checkIntervalMs = config.checkIntervalMs ?? 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Start the periodic cleanup timer.
   */
  start(): void {
    if (this.intervalId) {
      logger.warn('TempChatLifecycleService already started');
      return;
    }

    logger.info({ intervalMs: this.checkIntervalMs }, 'TempChatLifecycleService starting');

    // Run an immediate check on start
    void this.checkAndCleanup();

    this.intervalId = setInterval(() => {
      void this.checkAndCleanup();
    }, this.checkIntervalMs);

    // Allow the process to exit even if the timer is active
    if (this.intervalId && 'unref' in this.intervalId) {
      this.intervalId.unref();
    }
  }

  /**
   * Stop the periodic cleanup timer.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('TempChatLifecycleService stopped');
    }
  }

  /**
   * Check for expired temp chats and clean them up.
   *
   * Cleanup flow for each expired chat:
   * 1. dissolveChat(client, chatId) — dissolve the platform group
   * 2. unregisterGroup(chatId) — remove from GroupService registry
   * 3. removeTempChat(chatId) — delete the storage record
   *
   * @returns Cleanup result with counts and details
   */
  async checkAndCleanup(): Promise<CleanupResult> {
    const result: CleanupResult = { cleaned: 0, details: [] };

    try {
      const expiredChats = await this.chatStore.getExpiredTempChats();

      if (expiredChats.length === 0) {
        return result;
      }

      logger.info({ count: expiredChats.length }, 'Found expired temp chats to clean up');

      for (const chat of expiredChats) {
        const detail = await this.cleanupOne(chat);
        result.details.push(detail);
        if (detail.success) {
          result.cleaned++;
        }
      }

      logger.info(
        { total: expiredChats.length, cleaned: result.cleaned },
        'Temp chat cleanup cycle completed'
      );
    } catch (error) {
      logger.error({ err: error }, 'Error during temp chat cleanup cycle');
    }

    return result;
  }

  /**
   * Clean up a single expired temp chat.
   */
  private async cleanupOne(chat: TempChatRecord): Promise<{ chatId: string; success: boolean; error?: string }> {
    const { chatId } = chat;

    try {
      // Step 1: Dissolve the platform group (best-effort)
      if (this.dissolveChatFn) {
        try {
          await this.dissolveChatFn(chatId);
          logger.debug({ chatId }, 'Dissolved expired temp chat group');
        } catch (error) {
          // Log but continue — group may already be dissolved externally
          logger.warn({ err: error, chatId }, 'Failed to dissolve expired temp chat group (continuing cleanup)');
        }
      }

      // Step 2: Unregister from GroupService (best-effort)
      if (this.unregisterGroupFn) {
        try {
          this.unregisterGroupFn(chatId);
          logger.debug({ chatId }, 'Unregistered expired temp chat from GroupService');
        } catch {
          // Ignore — may not be registered
        }
      }

      // Step 3: Remove the storage record
      await this.chatStore.removeTempChat(chatId);
      logger.info({ chatId }, 'Expired temp chat cleaned up');

      return { chatId, success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ err: error, chatId }, 'Failed to clean up expired temp chat');
      return { chatId, success: false, error: errorMessage };
    }
  }

  /**
   * Check if the service is running.
   */
  isRunning(): boolean {
    return this.intervalId !== null;
  }
}
