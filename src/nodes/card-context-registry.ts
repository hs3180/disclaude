/**
 * CardContextRegistry - Stores card contexts for Worker Node routing.
 *
 * Issue #935: Enables Worker Node to receive card action callbacks through Primary Node.
 *
 * Architecture:
 * ```
 * Worker Node → CardContextMessage → Primary Node → CardContextRegistry
 *                                                              ↓
 * Feishu Card Action → Primary Node → CardContextRegistry → Forward to Worker Node
 * ```
 *
 * @module nodes/card-context-registry
 */

import { createLogger } from '../utils/logger.js';
import type { ActionPromptMap } from '../types/websocket-messages.js';

const logger = createLogger('CardContextRegistry');

/**
 * Stored card context for routing callbacks to Worker Nodes.
 */
export interface CardContext {
  /** The card message ID (assigned by Feishu) */
  messageId: string;
  /** Chat ID where the card was sent */
  chatId: string;
  /** Worker Node ID that sent the card */
  nodeId: string;
  /** Map of action values to prompt templates */
  actionPrompts: ActionPromptMap;
  /** When the context was registered */
  createdAt: number;
}

/**
 * Configuration for CardContextRegistry.
 */
export interface CardContextRegistryConfig {
  /** Maximum age of contexts in milliseconds (default: 24 hours) */
  maxAge?: number;
  /** Interval for cleanup in milliseconds (default: 1 hour) */
  cleanupInterval?: number;
}

/**
 * CardContextRegistry - Stores and manages card contexts for Worker Node routing.
 *
 * When a Worker Node sends an interactive card, it registers the card's action prompts
 * with the Primary Node. When a user interacts with the card, Primary Node looks up
 * the context and forwards the action to the appropriate Worker Node.
 */
export class CardContextRegistry {
  private readonly contexts = new Map<string, CardContext>();
  private readonly maxAge: number;
  private readonly cleanupInterval: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: CardContextRegistryConfig = {}) {
    this.maxAge = config.maxAge ?? 24 * 60 * 60 * 1000; // 24 hours
    this.cleanupInterval = config.cleanupInterval ?? 60 * 60 * 1000; // 1 hour
  }

  /**
   * Start the cleanup timer.
   */
  start(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupInterval);
    logger.info('CardContextRegistry started');
  }

  /**
   * Stop the cleanup timer.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.contexts.clear();
    logger.info('CardContextRegistry stopped');
  }

  /**
   * Register a card context from a Worker Node.
   *
   * @param messageId - The card message ID
   * @param chatId - The chat ID where the card was sent
   * @param nodeId - The Worker Node ID that sent the card
   * @param actionPrompts - Map of action values to prompt templates
   */
  register(
    messageId: string,
    chatId: string,
    nodeId: string,
    actionPrompts: ActionPromptMap
  ): void {
    const context: CardContext = {
      messageId,
      chatId,
      nodeId,
      actionPrompts,
      createdAt: Date.now(),
    };

    this.contexts.set(messageId, context);
    logger.debug(
      { messageId, chatId, nodeId, actionCount: Object.keys(actionPrompts).length },
      'Card context registered'
    );
  }

  /**
   * Get the card context for a message ID.
   *
   * @param messageId - The card message ID
   * @returns The card context or undefined if not found
   */
  get(messageId: string): CardContext | undefined {
    return this.contexts.get(messageId);
  }

  /**
   * Get action prompts for a message ID.
   *
   * @param messageId - The card message ID
   * @returns The action prompts or undefined if not found
   */
  getActionPrompts(messageId: string): ActionPromptMap | undefined {
    const context = this.contexts.get(messageId);
    return context?.actionPrompts;
  }

  /**
   * Get the Worker Node ID for a message ID.
   *
   * @param messageId - The card message ID
   * @returns The Worker Node ID or undefined if not found
   */
  getNodeId(messageId: string): string | undefined {
    const context = this.contexts.get(messageId);
    return context?.nodeId;
  }

  /**
   * Remove a card context.
   *
   * @param messageId - The card message ID
   * @returns true if the context was removed
   */
  unregister(messageId: string): boolean {
    const removed = this.contexts.delete(messageId);
    if (removed) {
      logger.debug({ messageId }, 'Card context unregistered');
    }
    return removed;
  }

  /**
   * Check if a message ID has a registered context.
   *
   * @param messageId - The card message ID
   * @returns true if the context exists
   */
  has(messageId: string): boolean {
    return this.contexts.has(messageId);
  }

  /**
   * Get the number of registered contexts.
   */
  size(): number {
    return this.contexts.size;
  }

  /**
   * Remove all contexts for a specific Worker Node.
   * Called when a Worker Node disconnects.
   *
   * @param nodeId - The Worker Node ID
   * @returns Number of contexts removed
   */
  removeByNodeId(nodeId: string): number {
    let removed = 0;
    for (const [messageId, context] of this.contexts) {
      if (context.nodeId === nodeId) {
        this.contexts.delete(messageId);
        removed++;
      }
    }
    if (removed > 0) {
      logger.debug({ nodeId, count: removed }, 'Removed card contexts for Worker Node');
    }
    return removed;
  }

  /**
   * Cleanup expired contexts.
   *
   * @returns Number of contexts cleaned up
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [messageId, context] of this.contexts) {
      if (now - context.createdAt > this.maxAge) {
        this.contexts.delete(messageId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ count: cleaned }, 'Cleaned up expired card contexts');
    }

    return cleaned;
  }
}
