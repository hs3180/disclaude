/**
 * PrimaryAgentPool - Agent pool for Primary Node.
 *
 * Manages ChatAgent instances for each chatId, using AgentFactory
 * from @disclaude/worker-node to create Pilot instances.
 *
 * Issue #1499: Accepts ChannelAdapter for platform-specific message building.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

import type { ChannelAdapter } from '@disclaude/core';
import { AgentFactory, type PilotCallbacks, type ChatAgent } from '@disclaude/worker-node';

/**
 * Options for PrimaryAgentPool.
 *
 * Issue #1499: Added channelAdapter for platform-agnostic channel configuration.
 */
export interface PrimaryAgentPoolOptions {
  /**
   * Channel adapter for platform-specific message building.
   *
   * Issue #1499: When provided, all Pilot instances created by this pool
   * will use the adapter's MessageBuilderOptions. This allows the pool
   * to be configured for any platform (Feishu, WeChat, etc.) without
   * the worker-node package needing to know about specific platforms.
   */
  channelAdapter?: ChannelAdapter;
}

/**
 * PrimaryAgentPool - Manages ChatAgent instances for Primary Node.
 *
 * Each chatId gets its own Pilot instance with full MessageBuilder
 * support for enhanced prompts with context.
 *
 * Issue #1499: Supports optional ChannelAdapter for platform-specific
 * message building configuration.
 */
export class PrimaryAgentPool {
  private readonly agents = new Map<string, ChatAgent>();
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
  getOrCreateChatAgent(chatId: string, callbacks: PilotCallbacks): ChatAgent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      agent = AgentFactory.createChatAgent('pilot', chatId, callbacks, {
        channelAdapter: this.options.channelAdapter,
      });
      this.agents.set(chatId, agent);
    }
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
  }
}
