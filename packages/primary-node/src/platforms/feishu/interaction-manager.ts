/**
 * Interaction Manager for Feishu Card Actions.
 *
 * Manages interactive card contexts and routes actions to handlers.
 * Supports timeout handling and automatic cleanup.
 *
 * Migrated to @disclaude/primary-node (Issue #1040)
 */

import { createLogger } from '@disclaude/core';
import type {
  FeishuCardActionEvent,
  InteractionContext,
  InteractionHandler,
} from '@disclaude/core';

const logger = createLogger('InteractionManager');

/**
 * Default timeout for interactions (5 minutes).
 */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Configuration for InteractionManager.
 */
export interface InteractionManagerConfig {
  /** Default timeout for interactions in ms */
  defaultTimeout?: number;
  /** Cleanup interval for expired interactions in ms */
  cleanupInterval?: number;
}

/**
 * Manager for Feishu card interactions.
 *
 * Features:
 * - Register interaction contexts with expected actions
 * - Route card actions to appropriate handlers
 * - Handle timeouts and cleanup
 * - Support both one-shot and persistent handlers
 *
 * @example
 * ```typescript
 * const manager = new InteractionManager();
 *
 * // Register an interaction
 * manager.register({
 *   id: 'confirm-action',
 *   chatId: 'oc_xxx',
 *   messageId: 'om_xxx',
 *   expectedActions: ['confirm', 'cancel'],
 *   handler: async (action) => {
 *     if (action.action.value === 'confirm') {
 *       // Handle confirmation
 *     }
 *   },
 * });
 *
 * // Handle incoming action
 * manager.handleAction(actionEvent);
 * ```
 */
export class InteractionManager {
  private interactions: Map<string, InteractionContext> = new Map();
  private defaultTimeout: number;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: InteractionManagerConfig = {}) {
    this.defaultTimeout = config.defaultTimeout ?? DEFAULT_TIMEOUT_MS;

    // Start cleanup timer
    const cleanupInterval = config.cleanupInterval ?? 60000;
    this.cleanupTimer = setInterval(() => this.cleanupExpired(), cleanupInterval);

    logger.debug({ defaultTimeout: this.defaultTimeout }, 'InteractionManager created');
  }

  /**
   * Register a new interaction context.
   *
   * @param context - Interaction context to register
   * @returns The registered context
   */
  register(context: Omit<InteractionContext, 'createdAt' | 'expiresAt'> & { expiresAt?: number }): InteractionContext {
    const now = Date.now();
    const fullContext: InteractionContext = {
      ...context,
      createdAt: now,
      expiresAt: context.expiresAt ?? (now + this.defaultTimeout),
    };

    this.interactions.set(context.id, fullContext);
    logger.debug(
      {
        id: context.id,
        chatId: context.chatId,
        expectedActions: context.expectedActions,
        expiresAt: new Date(fullContext.expiresAt).toISOString(),
      },
      'Interaction registered'
    );

    return fullContext;
  }

  /**
   * Unregister an interaction.
   *
   * @param id - Interaction ID to unregister
   * @returns Whether the interaction was found and removed
   */
  unregister(id: string): boolean {
    const removed = this.interactions.delete(id);
    if (removed) {
      logger.debug({ id }, 'Interaction unregistered');
    }
    return removed;
  }

  /**
   * Get an interaction by ID.
   *
   * @param id - Interaction ID
   * @returns The interaction context or undefined
   */
  get(id: string): InteractionContext | undefined {
    return this.interactions.get(id);
  }

  /**
   * Find an interaction by message ID.
   *
   * @param messageId - Card message ID
   * @returns The interaction context or undefined
   */
  findByMessageId(messageId: string): InteractionContext | undefined {
    for (const context of this.interactions.values()) {
      if (context.messageId === messageId) {
        return context;
      }
    }
    return undefined;
  }

  /**
   * Find interactions by chat ID.
   *
   * @param chatId - Chat ID
   * @returns Array of matching interactions
   */
  findByChatId(chatId: string): InteractionContext[] {
    const results: InteractionContext[] = [];
    for (const context of this.interactions.values()) {
      if (context.chatId === chatId) {
        results.push(context);
      }
    }
    return results;
  }

  /**
   * Handle an incoming card action event.
   *
   * @param event - The card action event
   * @param defaultHandler - Optional default handler if no registered handler found
   * @returns Whether the action was handled
   */
  async handleAction(
    event: FeishuCardActionEvent,
    defaultHandler?: InteractionHandler
  ): Promise<boolean> {
    const { message_id, action, chat_id } = event;

    logger.info(
      {
        messageId: message_id,
        chatId: chat_id,
        actionType: action.type,
        actionValue: action.value,
        trigger: action.trigger,
      },
      'Card action received'
    );

    // Find interaction by message ID
    const context = this.findByMessageId(message_id);

    if (!context) {
      logger.debug(
        { messageId: message_id, chatId: chat_id },
        'No registered interaction found for action'
      );

      // Use default handler if provided
      if (defaultHandler) {
        await defaultHandler(event);
        return true;
      }

      return false;
    }

    // Check if action is expected
    const actionKey = action.value;
    if (context.expectedActions.length > 0 && !context.expectedActions.includes(actionKey)) {
      logger.warn(
        { messageId: message_id, actionKey, expectedActions: context.expectedActions },
        'Unexpected action key'
      );
      return false;
    }

    // Check if interaction has expired
    if (context.expiresAt < Date.now()) {
      logger.warn({ id: context.id }, 'Interaction has expired');
      this.unregister(context.id);
      return false;
    }

    // Call the handler
    if (context.handler) {
      await context.handler(event);
      logger.debug({ id: context.id, actionKey }, 'Action handled successfully');
    }
    return true;
  }

  /**
   * Update an existing interaction.
   *
   * @param id - Interaction ID
   * @param updates - Partial updates to apply
   * @returns Updated context or undefined if not found
   */
  update(id: string, updates: Partial<InteractionContext>): InteractionContext | undefined {
    const context = this.interactions.get(id);
    if (!context) {
      return undefined;
    }

    const updated = { ...context, ...updates };
    this.interactions.set(id, updated);
    logger.debug({ id }, 'Interaction updated');
    return updated;
  }

  /**
   * Get all active interactions.
   *
   * @returns Array of all active interactions
   */
  getAll(): InteractionContext[] {
    return Array.from(this.interactions.values());
  }

  /**
   * Get count of active interactions.
   *
   * @returns Number of active interactions
   */
  get count(): number {
    return this.interactions.size;
  }

  /**
   * Cleanup expired interactions.
   */
  cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, context] of this.interactions) {
      if (context.expiresAt < now) {
        this.interactions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ count: cleaned }, 'Cleaned up expired interactions');
    }
  }

  /**
   * Dispose the manager and cleanup resources.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.interactions.clear();
    logger.debug('InteractionManager disposed');
  }
}
