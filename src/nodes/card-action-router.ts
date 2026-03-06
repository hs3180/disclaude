/**
 * CardActionRouter - Routes card action callbacks to Worker Nodes.
 *
 * When a Worker Node sends a card, Primary Node records the chatId -> nodeId mapping.
 * When a card action callback is received, Primary Node looks up the mapping
 * and forwards the action to the appropriate Worker Node.
 *
 * Issue #935: WebSocket bidirectional communication for card actions.
 *
 * @module nodes/card-action-router
 */

import { createLogger } from '../utils/logger.js';
import type { CardActionMessage } from '../types/websocket-messages.js';

const logger = createLogger('CardActionRouter');

/**
 * Entry for tracking which node handles cards for a chat.
 */
interface CardContextEntry {
  /** Node ID that sent the card */
  nodeId: string;
  /** Timestamp when the entry was created */
  createdAt: number;
  /** Whether the node is a remote Worker Node (not local) */
  isRemote: boolean;
}

/**
 * Configuration for CardActionRouter.
 */
export interface CardActionRouterConfig {
  /** Maximum age of context entries in milliseconds (default: 24 hours) */
  maxAge?: number;
  /** Callback to send card action to a remote node */
  sendToRemoteNode: (nodeId: string, message: CardActionMessage) => Promise<boolean>;
  /** Callback to check if a node is connected */
  isNodeConnected: (nodeId: string) => boolean;
}

/**
 * CardActionRouter - Routes card action callbacks to the appropriate node.
 *
 * This class manages the mapping between chatId and the node that handles
 * card interactions for that chat. When a Worker Node sends a card, it
 * registers the chat context. When a card action is received, the router
 * forwards it to the appropriate node.
 *
 * @example
 * ```typescript
 * const router = new CardActionRouter({
 *   sendToRemoteNode: async (nodeId, message) => {
 *     // Send via WebSocket
 *     return true;
 *   },
 *   isNodeConnected: (nodeId) => {
 *     // Check if node is connected
 *     return true;
 *   },
 * });
 *
 * // When Worker Node sends a card
 * router.registerChatContext(chatId, nodeId, true);
 *
 * // When card action is received
 * const handled = await router.routeCardAction({
 *   type: 'card_action',
 *   chatId,
 *   cardMessageId,
 *   actionType: 'button',
 *   actionValue: 'confirm',
 * });
 * ```
 */
export class CardActionRouter {
  private readonly maxAge: number;
  private readonly sendToRemoteNode: (nodeId: string, message: CardActionMessage) => Promise<boolean>;
  private readonly isNodeConnected: (nodeId: string) => boolean;
  private readonly contextMap = new Map<string, CardContextEntry>();

  // Cleanup interval (1 hour)
  private readonly cleanupInterval = 60 * 60 * 1000;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: CardActionRouterConfig) {
    this.maxAge = config.maxAge ?? 24 * 60 * 60 * 1000; // Default: 24 hours
    this.sendToRemoteNode = config.sendToRemoteNode;
    this.isNodeConnected = config.isNodeConnected;

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
   * @param isRemote - Whether the node is a remote Worker Node
   */
  registerChatContext(chatId: string, nodeId: string, isRemote: boolean): void {
    this.contextMap.set(chatId, {
      nodeId,
      createdAt: Date.now(),
      isRemote,
    });

    logger.debug({ chatId, nodeId, isRemote }, 'Chat context registered for card routing');
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
   * @param chatId - Chat ID to look up
   * @returns Node ID and whether it's remote, or undefined if not registered
   */
  getChatContext(chatId: string): { nodeId: string; isRemote: boolean } | undefined {
    const entry = this.contextMap.get(chatId);
    if (!entry) {
      return undefined;
    }

    // Check if entry is expired
    if (Date.now() - entry.createdAt > this.maxAge) {
      this.contextMap.delete(chatId);
      logger.debug({ chatId }, 'Chat context expired');
      return undefined;
    }

    return { nodeId: entry.nodeId, isRemote: entry.isRemote };
  }

  /**
   * Route a card action to the appropriate node.
   *
   * @param message - Card action message to route
   * @returns True if the action was handled (routed to remote or no routing needed)
   */
  async routeCardAction(message: CardActionMessage): Promise<boolean> {
    const { chatId } = message;
    const context = this.getChatContext(chatId);

    if (!context) {
      // No registered context, let local handler process it
      logger.debug({ chatId }, 'No card context registered, using local handler');
      return false;
    }

    const { nodeId, isRemote } = context;

    if (!isRemote) {
      // Local node, no routing needed
      logger.debug({ chatId, nodeId }, 'Card context is local, no routing needed');
      return false;
    }

    // Check if remote node is still connected
    if (!this.isNodeConnected(nodeId)) {
      logger.warn({ chatId, nodeId }, 'Remote node not connected, falling back to local handler');
      this.contextMap.delete(chatId);
      return false;
    }

    // Route to remote node
    logger.info({ chatId, nodeId, actionType: message.actionType }, 'Routing card action to remote node');

    try {
      const sent = await this.sendToRemoteNode(nodeId, message);
      if (sent) {
        logger.debug({ chatId, nodeId }, 'Card action routed successfully');
        return true;
      } else {
        logger.warn({ chatId, nodeId }, 'Failed to route card action');
        return false;
      }
    } catch (error) {
      logger.error({ err: error, chatId, nodeId }, 'Error routing card action');
      return false;
    }
  }

  /**
   * Clear all registered contexts.
   */
  clear(): void {
    this.contextMap.clear();
    logger.info('All card contexts cleared');
  }

  /**
   * Stop the router and cleanup resources.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.clear();
    logger.info('CardActionRouter stopped');
  }

  /**
   * Start the cleanup timer.
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, this.cleanupInterval);
  }

  /**
   * Cleanup expired entries.
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
      logger.debug({ count: cleaned }, 'Cleaned up expired card contexts');
    }
  }

  /**
   * Get statistics about the router.
   */
  getStats(): { totalContexts: number; oldestEntryAge: number | null } {
    let oldestAge: number | null = null;
    const now = Date.now();

    for (const entry of this.contextMap.values()) {
      const age = now - entry.createdAt;
      if (oldestAge === null || age > oldestAge) {
        oldestAge = age;
      }
    }

    return {
      totalContexts: this.contextMap.size,
      oldestEntryAge: oldestAge,
    };
  }
}
