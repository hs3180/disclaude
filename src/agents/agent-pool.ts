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
 * - ScheduleAgent/TaskAgent/SkillAgent: Short-lived, not stored here
 */

import type pino from 'pino';
import { createLogger } from '../utils/logger.js';
import { Config } from '../config/index.js';
import type { ChatAgent } from './types.js';
import type { SessionTimeoutConfig } from '../config/types.js';

const logger = createLogger('AgentPool');

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
  logger?: pino.Logger;
  /** Optional session timeout configuration (Issue #1313) */
  sessionTimeoutConfig?: SessionTimeoutConfig;
}

/**
 * AgentPool - Manages ChatAgent instances per chatId.
 *
 * Ensures complete isolation between different chat sessions by
 * giving each chatId its own ChatAgent instance.
 *
 * Lifecycle: ChatAgents are long-lived and persist across sessions.
 * Other agent types (ScheduleAgent, TaskAgent, SkillAgent) are not
 * managed here - they should be created and disposed as needed.
 */
export class AgentPool {
  private readonly chatAgentFactory: ChatAgentFactory;
  private readonly chatAgents = new Map<string, ChatAgent>();
  private readonly log: pino.Logger;
  private readonly sessionTimeoutConfig: SessionTimeoutConfig;
  private timeoutCheckTimer?: ReturnType<typeof setInterval>;

  constructor(config: AgentPoolConfig) {
    this.chatAgentFactory = config.chatAgentFactory;
    this.log = config.logger ?? logger;
    this.sessionTimeoutConfig = config.sessionTimeoutConfig ?? Config.getSessionTimeoutConfig();

    // Start timeout check if enabled
    if (this.sessionTimeoutConfig.enabled) {
      this.startTimeoutCheck();
    }
  }

  /**
   * Start the session timeout check timer (Issue #1313).
   */
  private startTimeoutCheck(): void {
    const intervalMs = (this.sessionTimeoutConfig.checkIntervalMinutes ?? 5) * 60 * 1000;

    this.timeoutCheckTimer = setInterval(() => {
      this.checkAndCleanupIdleSessions();
    }, intervalMs);

    this.log.info(
      {
        idleMinutes: this.sessionTimeoutConfig.idleMinutes,
        maxSessions: this.sessionTimeoutConfig.maxSessions,
        checkIntervalMinutes: this.sessionTimeoutConfig.checkIntervalMinutes,
      },
      'Session timeout check started'
    );
  }

  /**
   * Check and cleanup idle sessions (Issue #1313).
   */
  private checkAndCleanupIdleSessions(): void {
    const maxSessions = this.sessionTimeoutConfig.maxSessions ?? 100;

    // Check if over max sessions
    if (this.chatAgents.size > maxSessions) {
      this.log.warn(
        { sessionCount: this.chatAgents.size, maxSessions },
        'Session count exceeds max limit, forcing cleanup'
      );
    }

    // Collect all chat IDs for potential cleanup
    const chatIds = Array.from(this.chatAgents.keys());

    // Only cleanup if over max sessions
    if (this.chatAgents.size > maxSessions && chatIds.length > 0) {
      // Dispose excess sessions (FIFO - oldest first)
      const toDispose = chatIds.slice(0, this.chatAgents.size - maxSessions);

      for (const chatId of toDispose) {
        this.dispose(chatId);
        this.log.info({ chatId }, 'Session disposed due to max sessions limit');
      }
    }
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
   * Reset the ChatAgent for a chatId (clear conversation context).
   *
   * If the ChatAgent exists, calls its reset method.
   *
   * @param chatId - The chat identifier
   * @param keepContext - If true, reloads history context after reset (default: false)
   */
  reset(chatId: string, keepContext?: boolean): void {
    const agent = this.chatAgents.get(chatId);
    if (agent) {
      this.log.debug({ chatId, keepContext }, 'Resetting ChatAgent for chatId');
      agent.reset(chatId, keepContext);
    }
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
    // Stop timeout check timer
    if (this.timeoutCheckTimer) {
      clearInterval(this.timeoutCheckTimer);
      this.timeoutCheckTimer = undefined;
    }

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
