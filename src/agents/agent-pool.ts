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
import type { ChatAgent } from './types.js';
import { Config } from '../../config/index.js';
import { SessionTimeoutManager } from '../conversation/session-timeout-manager.js';

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
}

/**
 * AgentPool - Manages ChatAgent instances per chatId.
 */
export class AgentPool {
  private readonly log: pino.Logger;
  private readonly chatAgentFactory: ChatAgentFactory;
  private readonly chatAgents = new Map<string, ChatAgent>();
  private readonly lastActivityTimes = new Map<string, number>();
  private timeoutManager?: SessionTimeoutManager;

  constructor(config: AgentPoolConfig) {
    if (config.logger) {
      this.log = config.logger;
    } else {
      this.log = createLogger('AgentPool');
    }
    this.chatAgentFactory = config.chatAgentFactory;

    // Initialize timeout manager if configured
    const timeoutConfig = Config.getSessionRestoreConfig().sessionTimeout;
    if (timeoutConfig.enabled) {
      this.timeoutManager = new SessionTimeoutManager({
        logger: this.log,
        sessionManager: this,
        enabled: timeoutConfig.enabled,
        idleMinutes: timeoutConfig.idleMinutes,
        maxSessions: timeoutConfig.maxSessions,
        checkIntervalMinutes: timeoutConfig.checkIntervalMinutes,
        onSessionTimeout: async (chatId: string) => {
          // Call dispose to close the agent and release resources
          await this.dispose(chatId);
          this.log.info({ chatId }, 'Session closed due to timeout');
        },
      });
    }
  }

  /**
   * Get or create a ChatAgent for the chatId.
   *
   * This method is non-blocking - it calls chatAgentFactory to creates a new agent.
   * Based on boundChatId, this is returned.
   * The message routing,,
   * this system can be expanded to include multiple agents for different chatIds.
   *
   * @param chatId - The chat identifier
   * @returns true if a ChatAgent exists, false otherwise
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
   * Get or create a ChatAgent for the chatId.
   *
   * This method is non-blocking - it calls chatAgentFactory to creates a new agent.
   * Based on boundChatId, this is returned.
   * The message routing,,
   * this system can be expanded to include multiple agents for different chatIds.
   *
   * @param chatId - The chat identifier
   * @returns The ChatAgent instance
   */
  getOrCreate(chatId: string): ChatAgent {
    let agent = this.chatAgents.get(chatId);
    if (!agent) {
      this.log.info({ chatId }, 'Creating new ChatAgent instance for chatId');
      agent = this.chatAgentFactory(chatId);
      this.chatAgents.set(chatId, agent);
    }
    // Update last activity time
    this.lastActivityTimes.set(chatId, Date.now());
    return agent;
  }

  /**
   * Dispose and remove the ChatAgent for a chatId.
   *
   * This properly disposes the ChatAgent's resources before removing it.
   *
   * @param chatId - The chat identifier
   * @returns true if a ChatAgent was disposed, false if not found
   */
  async dispose(chatId: string): Promise<boolean> {
    const agent = this.chatAgents.get(chatId);
    if (!agent) {
      return false;
    }

    // Clear lastActivity tracking
    this.lastActivityTimes.delete(chatId);

    // Close the agent
    try {
      agent.dispose();
      this.log.debug({ chatId }, 'ChatAgent disposed');
      return true;
    } catch (err) {
      this.log.error({ err, chatId }, 'Error disposing ChatAgent');
      return false;
    }
  }

  /**
   * Reset a ChatAgent for the chatId.
   *
   * This method is non-blocking - it calls chatAgentFactory to creates a new agent.
   * Based on boundChatId, this is returned.
   * The message routing,,
   * this system can be expanded to include multiple agents for different chatIds.
   *
   * @param chatId - The chat identifier (optional)
   * @param keepContext - Whether to preserve context on reset
   * @returns true if a ChatAgent exists, false otherwise
   */
  reset(chatId?: string, keepContext?: boolean): void {
    // Find agent to reset (use boundChatId if no chatId provided)
    const targetChatId = chatId ?? Array.from(this.chatAgents.keys())[0];
    const agent = this.chatAgents.get(targetChatId);
    if (agent) {
      // Clear lastActivity tracking before reset
      this.lastActivityTimes.delete(targetChatId);
      agent.reset(targetChatId, keepContext);
      this.log.info({ chatId: targetChatId, keepContext }, 'Resetting ChatAgent for chatId');
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
   * Get the lastActivity times for all chatIds.
   * Used by SessionTimeoutManager to determine which sessions should be checked for timeout.
   */
  getLastActivityTimes(): Map<string, number> {
    return this.lastActivityTimes;
  }

  /**
   * Dispose all ChatAgents and clear the pool.
   * Used during shutdown.
   */
  disposeAll(): void {
    this.log.info('Disposing all ChatAgent instances');

    // Stop timeout manager first
    if (this.timeoutManager) {
      this.timeoutManager.stop();
    }

    // Clear map first
    const agents = Array.from(this.chatAgents.entries());
    this.chatAgents.clear();
    this.lastActivityTimes.clear();

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
