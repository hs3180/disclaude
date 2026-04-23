/**
 * PrimaryAgentPool - Agent pool for Primary Node.
 *
 * Manages ChatAgent instances for each chatId, using AgentFactory
 * from @disclaude/worker-node to create ChatAgent instances.
 *
 * Issue #1499: Accepts optional MessageBuilderOptions for channel-specific
 * message building (e.g., Feishu sections). This decouples Feishu-specific
 * logic from worker-node.
 *
 * Issue #1916: Accepts optional CwdProvider for per-chatId project context
 * switching. Injected into ChatAgent at creation time.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

import { type MessageBuilderOptions, type CwdProvider } from '@disclaude/core';
import { AgentFactory, type ChatAgentCallbacks, type ChatAgentInterface } from '@disclaude/worker-node';

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

  /**
   * Optional CwdProvider for per-chatId project context switching.
   *
   * When provided, all ChatAgent instances created by this pool will
   * use this provider to dynamically resolve the working directory
   * at session start time (Issue #1916).
   *
   * Set via `setCwdProvider()` after construction, or pass in options.
   */
  cwdProvider?: CwdProvider;
}

/**
 * PrimaryAgentPool - Manages ChatAgent instances for Primary Node.
 *
 * Each chatId gets its own ChatAgent instance with full MessageBuilder
 * support for enhanced prompts with context.
 */
export class PrimaryAgentPool {
  private readonly agents = new Map<string, ChatAgentInterface>();
  private readonly options: PrimaryAgentPoolOptions;
  private cwdProvider?: CwdProvider;

  constructor(options: PrimaryAgentPoolOptions = {}) {
    this.options = options;
    this.cwdProvider = options.cwdProvider;
  }

  /**
   * Set the CwdProvider for project context switching (Issue #1916).
   *
   * Can be called after construction to inject the provider once
   * ProjectManager is initialized.
   *
   * @param provider - CwdProvider callback
   */
  setCwdProvider(provider: CwdProvider): void {
    this.cwdProvider = provider;
  }

  /**
   * Get or create a ChatAgent instance for the given chatId.
   *
   * @param chatId - Chat ID to get/create agent for
   * @param callbacks - Callbacks for sending messages (required for new agents)
   * @returns ChatAgent instance
   */
  getOrCreateChatAgent(chatId: string, callbacks: ChatAgentCallbacks): ChatAgentInterface {
    let agent = this.agents.get(chatId);
    if (!agent) {
      agent = AgentFactory.createAgent(chatId, callbacks, {
        messageBuilderOptions: this.options.messageBuilderOptions,
        cwdProvider: this.cwdProvider,
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
