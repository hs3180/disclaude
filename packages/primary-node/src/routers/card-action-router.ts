/**
 * CardActionRouter - Tracks card action context for expiry detection.
 *
 * When a card is sent, Primary Node records the chatId -> nodeId mapping.
 * When a card action callback is received, Primary Node checks if the context
 * is still active, expired, or not found, allowing callers to provide
 * appropriate user feedback.
 *
 * Issue #935: WebSocket bidirectional communication for card actions.
 * Issue #1040: Migrated to @disclaude/primary-node
 * Issue #2939: Removed remote node stubs (sendToRemoteNode, isRemote).
 *
 * @module routers/card-action-router
 */

import { createLogger } from '@disclaude/core';

const logger = createLogger('CardActionRouter');

/**
 * Entry for tracking which node handles cards for a chat.
 */
interface CardContextEntry {
  /** Node ID that sent the card */
  nodeId: string;
  /** Timestamp when the entry was created */
  createdAt: number;
}

/**
 * Result of chat context lookup, distinguishing between states.
 * Allows callers to provide appropriate user feedback (#2247).
 */
export interface ChatContextResult {
  /** The lookup status */
  status: 'active' | 'expired' | 'not_found';
  /** Context data, only present when status is 'active' */
  context?: { nodeId: string };
}

/**
 * Result of routing a card action, distinguishing between outcomes.
 * Allows callers to provide appropriate user feedback when the context
 * has expired (#2247 Problem 7).
 */
export interface RouteCardActionResult {
  /**
   * Whether the card context was found and is still active.
   * Always false in single-node mode — no remote routing.
   */
  routed: boolean;
  /**
   * Whether the card context has expired.
   * When true, the caller should notify the user that their operation
   * has timed out.
   */
  expired?: boolean;
}

/**
 * Configuration for CardActionRouter.
 */
export interface CardActionRouterConfig {
  /** Maximum age of context entries in milliseconds (default: 24 hours) */
  maxAge?: number;
}

/**
 * CardActionRouter - Tracks card action context for expiry detection.
 *
 * This class manages the mapping between chatId and the node that handles
 * card interactions for that chat. When a node sends a card, it registers
 * the chat context. When a card action is received, the router checks
 * whether the context is still active, expired, or not found.
 *
 * @example
 * ```typescript
 * const router = new CardActionRouter();
 *
 * // When node sends a card
 * router.registerChatContext(chatId, nodeId);
 *
 * // When card action is received
 * const result = await router.routeCardAction({
 *   type: 'card_action',
 *   chatId,
 *   cardMessageId,
 *   actionType: 'button',
 *   actionValue: 'confirm',
 * });
 * // result.routed: boolean — always false in single-node mode
 * // result.expired: boolean | undefined — whether the card context has expired (#2247)
 * ```
 */
export class CardActionRouter {
  private readonly maxAge: number;
  private readonly contextMap = new Map<string, CardContextEntry>();

  // Cleanup interval (1 hour)
  private readonly cleanupInterval = 60 * 60 * 1000;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: CardActionRouterConfig = {}) {
    this.maxAge = config.maxAge ?? 24 * 60 * 60 * 1000; // Default: 24 hours

    // Start periodic cleanup
    this.startCleanupTimer();

    logger.info({ maxAge: this.maxAge }, 'CardActionRouter created');
  }

  /**
   * Register a chat context for card routing.
   * Called when a node sends a card to a chat.
   *
   * @param chatId - Chat ID where the card was sent
   * @param nodeId - Node ID that sent the card
   */
  registerChatContext(chatId: string, nodeId: string): void {
    this.contextMap.set(chatId, {
      nodeId,
      createdAt: Date.now(),
    });

    logger.debug({ chatId, nodeId }, 'Chat context registered for card routing');
  }

  /**
   * Unregister a chat context.
   *
   * @param chatId - Chat ID to unregister
   */
  unregisterChatContext(chatId: string): void {
    const removed = this.contextMap.delete(chatId);
    if (removed) {
      logger.debug({ chatId }, 'Chat context unregistered from card routing');
    }
  }

  /**
   * Get the node ID handling cards for a chat.
   *
   * Returns a ChatContextResult that distinguishes between 'active',
   * 'expired', and 'not_found' states, allowing callers to provide
   * appropriate user feedback (#2247).
   *
   * @param chatId - Chat ID to look up
   * @returns ChatContextResult with status and optional context data
   */
  getChatContext(chatId: string): ChatContextResult {
    const entry = this.contextMap.get(chatId);
    if (!entry) {
      return { status: 'not_found' };
    }

    // Check if entry is expired
    if (Date.now() - entry.createdAt > this.maxAge) {
      this.contextMap.delete(chatId);
      logger.debug({ chatId }, 'Chat context expired');
      return { status: 'expired' };
    }

    return { status: 'active', context: { nodeId: entry.nodeId } };
  }

  /**
   * Check if a chat context is registered and active.
   * Convenience method for callers that only need a boolean check.
   *
   * @param chatId - Chat ID to look up
   * @returns Node ID if active, or undefined if not active
   */
  getActiveChatContext(chatId: string): string | undefined {
    const result = this.getChatContext(chatId);
    return result.status === 'active' ? result.context?.nodeId : undefined;
  }

  /**
   * Check card action context status.
   *
   * Returns a result object that distinguishes between routing outcomes,
   * allowing callers to provide appropriate user feedback (#2247).
   *
   * Note: Kept as async for API backward compatibility. Previously this method
   * performed remote node routing via `sendToRemoteNode`; now it only checks
   * context status in single-node mode (#2939).
   *
   * @param message - Card action message to check
   * @returns RouteCardActionResult with routed status and optional expired flag
   */
  // eslint-disable-next-line require-await
  async routeCardAction(message: { chatId: string }): Promise<RouteCardActionResult> {
    const { chatId } = message;
    const contextResult = this.getChatContext(chatId);

    if (contextResult.status === 'expired') {
      // Context expired — log prominently and return with expired flag.
      // Caller should notify user that their operation has timed out (#2247).
      logger.info({ chatId }, 'Chat context expired, card action cannot be routed');
      return { routed: false, expired: true };
    }

    if (contextResult.status === 'not_found') {
      // No registered context, let local handler process it
      logger.debug({ chatId }, 'No card context registered, using local handler');
      return { routed: false };
    }

    // status is 'active' — in single-node mode, no remote routing needed
    logger.debug({ chatId, nodeId: contextResult.context?.nodeId }, 'Card context is active, local-only mode');
    return { routed: false };
  }

  /**
   * Start periodic cleanup of expired entries.
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, this.cleanupInterval);
  }

  /**
   * Clean up expired entries.
   */
  private cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [chatId, entry] of this.contextMap) {
      if (now - entry.createdAt > this.maxAge) {
        this.contextMap.delete(chatId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ count: cleaned }, 'Cleaned up expired card context entries');
    }
  }

  /**
   * Dispose the router.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.contextMap.clear();
    logger.debug('CardActionRouter disposed');
  }
}
