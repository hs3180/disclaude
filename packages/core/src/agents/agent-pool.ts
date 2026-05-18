/**
 * AgentPool - Manages ChatAgent instances per chatId.
 *
 * This class solves the concurrency issue (Issue #644) where messages
 * were being routed to the wrong agent instance.
 *
 * Key Design:
 * - Each chatId gets its own ChatAgent instance
 * - ChatAgent instances are created with chatId bound at construction time
 * - No session management needed inside ChatAgent (each ChatAgent = one chatId)
 *
 * Architecture:
 * ```
 * PrimaryNode
 *     └── AgentPool
 *             └── Map<chatId, ChatAgent>
 *                     └── Each ChatAgent handles ONE chatId only
 * ```
 *
 * Lifecycle Strategy (Issue #711):
 * - ChatAgent: Long-lived, bound to chatId, stored in AgentPool
 * - Short-lived ChatAgents (for scheduled/one-shot tasks): Not stored here, created and disposed as needed
 */

import { createLogger, type Logger } from '../utils/logger.js';
import type { ChatAgent } from './types.js';

const defaultLogger = createLogger('AgentPool');

/**
 * Factory function type for creating ChatAgent instances.
 */
export type ChatAgentFactory = (chatId: string) => ChatAgent;

/**
 * Configuration for AgentPool.
 */
export interface AgentPoolConfig {
  /** Factory function to create ChatAgent instances */
  chatAgentFactory: ChatAgentFactory;
  /** Optional logger */
  logger?: Logger;
}

/**
 * AgentPool - Manages ChatAgent instances per chatId.
 *
 * Ensures complete isolation between different chat sessions by
 * giving each chatId its own ChatAgent instance.
 *
 * Lifecycle: ChatAgents are long-lived and persist across sessions.
 * Short-lived ChatAgents (for scheduled/one-shot tasks) are not
 * managed here - they are created and disposed as needed.
 */
export class AgentPool {
  private readonly chatAgentFactory: ChatAgentFactory;
  private readonly chatAgents = new Map<string, ChatAgent>();
  private readonly log: Logger;
  /** Issue #3696: chatIds that should skip history loading on next agent creation */
  private readonly skipHistoryChatIds = new Set<string>();

  constructor(config: AgentPoolConfig) {
    this.chatAgentFactory = config.chatAgentFactory;
    this.log = config.logger ?? defaultLogger;
  }

  /**
   * Get or create a ChatAgent instance for the given chatId.
   *
   * If a ChatAgent already exists for this chatId, returns it.
   * Otherwise, creates a new ChatAgent using the factory.
   *
   * @param chatId - The chat identifier
   * @returns The ChatAgent instance for this chatId
   */
  getOrCreateChatAgent(chatId: string): ChatAgent {
    let agent = this.chatAgents.get(chatId);
    if (!agent) {
      this.log.info({ chatId }, 'Creating new ChatAgent instance for chatId');
      agent = this.chatAgentFactory(chatId);
      this.chatAgents.set(chatId, agent);
      // Issue #3696: clear skip-history flag after agent creation
      this.skipHistoryChatIds.delete(chatId);
    }
    return agent;
  }

  /**
   * Check if a ChatAgent exists for the given chatId.
   *
   * @param chatId - The chat identifier
   * @returns true if a ChatAgent exists
   */
  has(chatId: string): boolean {
    return this.chatAgents.has(chatId);
  }

  /**
   * Get an existing ChatAgent without creating one.
   *
   * @param chatId - The chat identifier
   * @returns The ChatAgent instance or undefined
   */
  get(chatId: string): ChatAgent | undefined {
    return this.chatAgents.get(chatId);
  }

  /**
   * Dispose and remove the ChatAgent for a chatId.
   *
   * This properly disposes the ChatAgent's resources before removing it.
   *
   * @param chatId - The chat identifier
   * @returns true if a ChatAgent was disposed, false if not found
   */
  dispose(chatId: string): boolean {
    const agent = this.chatAgents.get(chatId);
    if (!agent) {
      return false;
    }

    this.log.info({ chatId }, 'Disposing ChatAgent instance for chatId');
    this.chatAgents.delete(chatId);
    agent.dispose();
    return true;
  }

  /**
   * Reset the ChatAgent for a chatId by disposing the old instance.
   *
   * Issue #3570: Instead of just clearing conversation context on the existing
   * agent, we dispose it completely and remove it from the pool. The next
   * getOrCreateChatAgent() call will create a fresh agent instance.
   *
   * This ensures all resources (MCP connections, event listeners, transports,
   * AbortControllers) are properly released rather than accumulated across
   * multiple /reset operations.
   *
   * Issue #3696: skipContext flag is stored so the next getOrCreateChatAgent()
   * can pass it to the factory. Note: the core AgentPool uses a simple factory
   * that doesn't support options, so PrimaryAgentPool handles the actual logic.
   *
   * @param chatId - The chat identifier
   * @param skipContext - If true, the next agent creation should skip history loading
   */
  reset(chatId: string, skipContext?: boolean): void {
    this.log.info({ chatId, skipContext }, 'Resetting ChatAgent: disposing old instance for chatId');
    if (skipContext) {
      this.skipHistoryChatIds.add(chatId);
    }
    this.dispose(chatId);
  }

  /**
   * Stop the current query for a chatId without resetting the session.
   * Issue #1349: /stop command
   *
   * @param chatId - The chat identifier
   * @returns true if a query was stopped, false if no active query
   */
  stop(chatId: string): boolean {
    const agent = this.chatAgents.get(chatId);
    if (agent) {
      this.log.debug({ chatId }, 'Stopping ChatAgent query for chatId');
      return agent.stop(chatId);
    }
    return false;
  }

  /**
   * Get the number of active ChatAgent instances.
   *
   * @returns Number of chat agents
   */
  size(): number {
    return this.chatAgents.size;
  }

  /**
   * Get all chatIds with active ChatAgents.
   *
   * @returns Array of chatIds
   */
  getActiveChatIds(): string[] {
    return Array.from(this.chatAgents.keys());
  }

  /**
   * Dispose all ChatAgents and clear the pool.
   * Used during shutdown.
   */
  disposeAll(): void {
    this.log.info('Disposing all ChatAgent instances');

    // Clear map first
    const agents = Array.from(this.chatAgents.entries());
    this.chatAgents.clear();

    // Then dispose all agents
    for (const [chatId, agent] of agents) {
      try {
        agent.dispose();
        this.log.debug({ chatId }, 'ChatAgent disposed');
      } catch (err) {
        this.log.error({ err, chatId }, 'Error disposing ChatAgent');
      }
    }

    this.log.info('All ChatAgents disposed');
  }
}
