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
   * Global SOUL.md content to inject into all agents' system prompts.
   * Loaded at startup from the configured soul.path in disclaude.config.yaml.
   *
   * Issue #1315: SOUL.md personality injection.
   */
  systemPromptAppend?: string;
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
   * @param chatId - Chat ID to get/create agent for
   * @param callbacks - Callbacks for sending messages (required for new agents)
   * @returns ChatAgent instance
   */
  getOrCreateChatAgent(chatId: string, callbacks: PilotCallbacks): ChatAgent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      agent = AgentFactory.createChatAgent('pilot', chatId, callbacks, {
        messageBuilderOptions: this.options.messageBuilderOptions,
        systemPromptAppend: this.options.systemPromptAppend,
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
