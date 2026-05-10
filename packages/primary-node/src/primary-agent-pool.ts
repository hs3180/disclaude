/**
 * PrimaryAgentPool - Agent pool for Primary Node.
 *
 * Manages ChatAgent instances for each chatId, using AgentFactory
 * from @disclaude/primary-node to create ChatAgent instances.
 *
 * Issue #1499: Accepts optional MessageBuilderOptions for channel-specific
 * message building (e.g., Feishu sections). This decouples Feishu-specific
 * logic from the core agent runtime.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

import { type MessageBuilderOptions } from '@disclaude/core';
import { AgentFactory } from './agents/factory.js';
import type { ChatAgentCallbacks } from './agents/types.js';
import type { ChatAgent } from './agents/chat-agent.js';

/**
 * Options for PrimaryAgentPool initialization.
 *
 * Issue #1499: Allows injecting channel-specific MessageBuilderOptions
 * at pool creation time.
 */
export interface PrimaryAgentPoolOptions {
  /**
   * Channel-specific MessageBuilderOptions.
   *
   * When provided, all ChatAgent instances created by this pool will use
   * these options for building enhanced message content (e.g., platform
   * headers, tool sections, attachment extras).
   *
   * Example: createFeishuMessageBuilderOptions() for Feishu channels.
   */
  messageBuilderOptions?: MessageBuilderOptions;
}

/**
 * PrimaryAgentPool - Manages ChatAgent instances for Primary Node.
 *
 * Each chatId gets its own ChatAgent instance with full MessageBuilder
 * support for enhanced prompts with context.
 */
export class PrimaryAgentPool {
  private readonly agents = new Map<string, ChatAgent>();
  /** Issue #3378: Track last activity time per chatId for idle eviction. */
  private readonly activityTimestamps = new Map<string, number>();
  private readonly options: PrimaryAgentPoolOptions;

  constructor(options: PrimaryAgentPoolOptions = {}) {
    this.options = options;
  }

  /**
   * Get or create a ChatAgent instance for the given chatId.
   *
   * @param chatId - Chat ID to get/create agent for
   * @param callbacks - Callbacks for sending messages (required for new agents)
   * @returns ChatAgent instance
   */
  getOrCreateChatAgent(chatId: string, callbacks: ChatAgentCallbacks): ChatAgent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      agent = AgentFactory.createChatAgent('pilot', chatId, callbacks, {
        messageBuilderOptions: this.options.messageBuilderOptions,
      });
      this.agents.set(chatId, agent);
    }
    // Issue #3378: Track activity for idle eviction
    this.activityTimestamps.set(chatId, Date.now());
    return agent;
  }

  /**
   * Reset the ChatAgent for a chatId.
   *
   * @param chatId - Chat ID to reset
   * @param keepContext - Whether to keep context after reset
   */
  reset(chatId: string, keepContext?: boolean): void {
    const agent = this.agents.get(chatId);
    if (agent) {
      agent.reset(chatId, keepContext);
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
    const agent = this.agents.get(chatId);
    if (agent) {
      return agent.stop(chatId);
    }
    return false;
  }

  /**
   * Dispose all agents and clear the pool.
   */
  disposeAll(): void {
    for (const agent of this.agents.values()) {
      agent.dispose();
    }
    this.agents.clear();
    this.activityTimestamps.clear();
  }

  /**
   * Dispose ChatAgents that have been idle for longer than the specified timeout.
   * Issue #3378: Releases SDK exit listeners from idle agents, preventing
   * MaxListenersExceededWarning when many agents accumulate.
   *
   * @param idleTimeoutMs - Idle threshold in milliseconds
   * @returns Number of disposed agents
   */
  disposeIdle(idleTimeoutMs: number): number {
    const now = Date.now();
    let disposedCount = 0;

    for (const [chatId, lastActivity] of this.activityTimestamps) {
      if (now - lastActivity > idleTimeoutMs) {
        const agent = this.agents.get(chatId);
        if (agent) {
          agent.dispose();
          this.agents.delete(chatId);
        }
        this.activityTimestamps.delete(chatId);
        disposedCount++;
      }
    }

    return disposedCount;
  }
}
