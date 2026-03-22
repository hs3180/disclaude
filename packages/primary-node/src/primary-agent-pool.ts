/**
 * PrimaryAgentPool - Agent pool for Primary Node.
 *
 * Manages ChatAgent instances for each chatId, using AgentFactory
 * from @disclaude/worker-node to create Pilot instances.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 * @see Issue #1313 - Session timeout management
 */

import { AgentFactory, type PilotCallbacks, type ChatAgent } from '@disclaude/worker-node';
import { Config, SessionTimeoutManager, type SessionTimeoutConfig } from '@disclaude/core';
import { createLogger } from '@disclaude/core';

const logger = createLogger('PrimaryAgentPool');

/**
 * PrimaryAgentPool - Manages ChatAgent instances for Primary Node.
 *
 * Each chatId gets its own Pilot instance with full MessageBuilder
 * support for enhanced prompts with context.
 *
 * Issue #1313: Includes session timeout management.
 */
export class PrimaryAgentPool {
  private readonly agents = new Map<string, { agent: ChatAgent; lastActivity: number }>();
  private sessionTimeoutManager?: SessionTimeoutManager;

  /**
   * Get or create a ChatAgent instance for the given chatId.
   *
   * @param chatId - Chat ID to get/create agent for
   * @param callbacks - Callbacks for sending messages (required for new agents)
   * @returns ChatAgent instance
   */
  getOrCreateChatAgent(chatId: string, callbacks: PilotCallbacks): ChatAgent {
    let agentData = this.agents.get(chatId);
    if (!agentData) {
      const agent = AgentFactory.createChatAgent('pilot', chatId, callbacks);
      agentData = { agent, lastActivity: Date.now() };
      this.agents.set(chatId, agentData);
    } else {
      // Update last activity
      agentData.lastActivity = Date.now();
    }
    return agentData.agent;
  }

  /**
   * Reset the ChatAgent for a chatId.
   *
   * @param chatId - Chat ID to reset
   * @param keepContext - Whether to keep context after reset
   */
  reset(chatId: string, keepContext?: boolean): void {
    const agentData = this.agents.get(chatId);
    if (agentData) {
      agentData.agent.reset(chatId, keepContext);
      agentData.lastActivity = Date.now();
    }
  }

  /**
   * Stop the current query for a chatId without resetting the session.
   * Issue #1349: /stop command
   *
   * @param chatId - Chat ID to stop
   * @returns true if a query was stopped, false if no active query
   */
  stop(chatId: string): boolean {
    const agentData = this.agents.get(chatId);
    if (agentData) {
      return agentData.agent.stop(chatId);
    }
    return false;
  }

  /**
   * Get the last activity timestamp for a chatId.
   * Issue #1313: Session timeout management
   *
   * @param chatId - Chat ID to check
   * @returns Last activity timestamp in milliseconds, or undefined
   */
  getLastActivity(chatId: string): number | undefined {
    return this.agents.get(chatId)?.lastActivity;
  }

  /**
   * Check if a session is currently processing.
   * Issue #1313: Session timeout management
   *
   * @param chatId - Chat ID to check
   * @returns true if the session has an active query
   */
  isProcessing(_chatId: string): boolean {
    // For now, we're always allow timeout
    // In the future, this could check if the agent is actively processing
    return false;
  }

  /**
   * Get all active chat IDs.
   * Issue #1313: Session timeout management
   *
   * @returns Array of active chat IDs
   */
  getActiveChatIds(): string[] {
    return Array.from(this.agents.keys());
  }

  /**
   * Get the current session count.
   * Issue #1313: Session timeout management
   *
   * @returns Number of active sessions
   */
  getSessionCount(): number {
    return this.agents.size;
  }

  /**
   * Close a session.
   * Issue #1313: Session timeout management
   *
   * @param chatId - Chat ID to close
   * @param reason - Reason for closing
   */
  closeSession(chatId: string, reason: string): void {
    const agentData = this.agents.get(chatId);
    if (agentData) {
      logger.info({ chatId, reason }, 'Closing session');
      this.agents.delete(chatId);
      agentData.agent.dispose();
    }
  }

  /**
   * Start session timeout management.
   * Issue #1313: Session timeout management
   */
  startSessionTimeoutManager(): void {
    const config = this.getSessionTimeoutConfig();
    if (!config.enabled) {
      logger.debug('Session timeout management is disabled');
      return;
    }

    this.sessionTimeoutManager = new SessionTimeoutManager({
      logger,
      config,
      callbacks: {
        getLastActivity: (chatId: string) => this.getLastActivity(chatId),
        isProcessing: (chatId: string) => this.isProcessing(chatId),
        getActiveChatIds: () => this.getActiveChatIds(),
        getSessionCount: () => this.getSessionCount(),
        closeSession: (chatId: string, reason: string) => this.closeSession(chatId, reason),
      },
    });

    this.sessionTimeoutManager.start();
    logger.info(
      { idleMinutes: config.idleMinutes, maxSessions: config.maxSessions },
      'Session timeout manager started'
    );
  }

  /**
   * Stop session timeout management.
   * Issue #1313: Session timeout management
   */
  stopSessionTimeoutManager(): void {
    this.sessionTimeoutManager?.stop();
    this.sessionTimeoutManager = undefined;
  }

  /**
   * Get the session timeout configuration.
   *
   * @returns Session timeout configuration
   */
  private getSessionTimeoutConfig(): SessionTimeoutConfig {
    return Config.getSessionRestoreConfig().sessionTimeout;
  }

  /**
   * Dispose all agents and clear the pool.
   */
  disposeAll(): void {
    this.stopSessionTimeoutManager();
    for (const agentData of this.agents.values()) {
      agentData.agent.dispose();
    }
    this.agents.clear();
  }
}
