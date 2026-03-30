/**
 * PrimaryAgentPool - Agent pool for Primary Node.
 *
 * Manages ChatAgent instances for each chatId, using AgentFactory
 * from @disclaude/worker-node to create Pilot instances.
 *
 * Issue #1499: Accepts optional MessageBuilderOptions for channel-specific
 * message building (e.g., Feishu sections). This decouples Feishu-specific
 * logic from worker-node.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

import { type MessageBuilderOptions } from '@disclaude/core';
import { AgentFactory, type PilotCallbacks, type ChatAgent } from '@disclaude/worker-node';

/**
 * Options for PrimaryAgentPool initialization.
 *
 * Issue #1499: Allows injecting channel-specific MessageBuilderOptions
 * at pool creation time.
 * Issue #1709: Allows injecting per-chat cwd resolver for research mode.
 */
export interface PrimaryAgentPoolOptions {
  /**
   * Channel-specific MessageBuilderOptions.
   *
   * When provided, all Pilot instances created by this pool will use
   * these options for building enhanced message content (e.g., platform
   * headers, tool sections, attachment extras).
   *
   * Example: createFeishuMessageBuilderOptions() for Feishu channels.
   */
  messageBuilderOptions?: MessageBuilderOptions;

  /**
   * Optional per-chat cwd resolver.
   *
   * When provided, called for each chatId when creating a new agent.
   * Returns the cwd override for that chat, or undefined to use default.
   *
   * Issue #1709: Used by ResearchModeManager to provide research workspace cwd.
   *
   * @param chatId - Chat ID to resolve cwd for
   * @returns Absolute path to use as cwd, or undefined for default workspace
   */
  cwdResolver?: (chatId: string) => string | undefined;
}

/**
 * PrimaryAgentPool - Manages ChatAgent instances for Primary Node.
 *
 * Each chatId gets its own Pilot instance with full MessageBuilder
 * support for enhanced prompts with context.
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
   * Issue #1709: Resolves per-chat cwd override via cwdResolver option.
   *
   * @param chatId - Chat ID to get/create agent for
   * @param callbacks - Callbacks for sending messages (required for new agents)
   * @returns ChatAgent instance
   */
  getOrCreateChatAgent(chatId: string, callbacks: PilotCallbacks): ChatAgent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      // Issue #1709: Resolve per-chat cwd override (e.g., research mode)
      const cwd = this.options.cwdResolver?.(chatId);
      agent = AgentFactory.createChatAgent('pilot', chatId, callbacks, {
        messageBuilderOptions: this.options.messageBuilderOptions,
        ...(cwd && { cwd }),
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
   * Dispose and remove the ChatAgent for a chatId.
   *
   * Unlike reset(), this completely removes the agent from the pool.
   * The next message will create a new agent via getOrCreateChatAgent().
   *
   * Issue #1709: Used when toggling research mode to ensure the new
   * agent is created with the correct cwd.
   *
   * @param chatId - Chat ID to dispose and remove
   */
  disposeAgent(chatId: string): void {
    const agent = this.agents.get(chatId);
    if (agent) {
      agent.dispose();
      this.agents.delete(chatId);
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
