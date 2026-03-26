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
 * Issue #1228: Integrated with ChatSoulRegistry for per-chat soul injection.
 * When a chat is created with a soul profile, the soul content is stored
 * and injected into the Pilot's system prompt.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

import { type MessageBuilderOptions } from '@disclaude/core';
import { AgentFactory, type PilotCallbacks, type ChatAgent } from '@disclaude/worker-node';
import { ChatSoulRegistry } from './chat-soul-registry.js';

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
   * Directory containing built-in soul profiles.
   * Issue #1228: Used by ChatSoulRegistry to resolve built-in soul names.
   */
  builtinSoulsDir?: string;
}

/**
 * PrimaryAgentPool - Manages ChatAgent instances for Primary Node.
 *
 * Each chatId gets its own Pilot instance with full MessageBuilder
 * support for enhanced prompts with context.
 *
 * Issue #1228: When a chat has a registered soul profile, the soul content
 * is injected into the Pilot's system prompt via systemPromptAppend.
 */
export class PrimaryAgentPool {
  private readonly agents = new Map<string, ChatAgent>();
  private readonly options: PrimaryAgentPoolOptions;
  private readonly soulRegistry: ChatSoulRegistry;

  constructor(options: PrimaryAgentPoolOptions = {}) {
    this.options = options;
    this.soulRegistry = new ChatSoulRegistry(options.builtinSoulsDir);
  }

  /**
   * Get or create a ChatAgent instance for the given chatId.
   *
   * Issue #1228: If a soul profile is registered for this chatId,
   * the soul content is injected into the agent via systemPromptAppend.
   *
   * @param chatId - Chat ID to get/create agent for
   * @param callbacks - Callbacks for sending messages (required for new agents)
   * @returns ChatAgent instance
   */
  getOrCreateChatAgent(chatId: string, callbacks: PilotCallbacks): ChatAgent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      const soulContent = this.soulRegistry.getSoulContent(chatId);
      agent = AgentFactory.createChatAgent('pilot', chatId, callbacks, {
        messageBuilderOptions: this.options.messageBuilderOptions,
        systemPromptAppend: soulContent,
      });
      this.agents.set(chatId, agent);
    }
    return agent;
  }

  /**
   * Register a soul profile for a chatId.
   *
   * Issue #1228: This should be called when create_chat is invoked
   * with a `soul` parameter. The soul content is loaded and stored,
   * and will be injected into the Pilot when it's created for this chatId.
   *
   * @param chatId - Chat ID to associate soul with
   * @param soul - Soul parameter (built-in name or file path)
   * @param workspaceDir - Workspace directory for resolving relative paths
   */
  async registerSoul(chatId: string, soul: string, workspaceDir?: string): Promise<void> {
    await this.soulRegistry.registerSoul(chatId, soul, workspaceDir);
  }

  /**
   * Check if a chatId has a registered soul profile.
   *
   * @param chatId - Chat ID
   * @returns true if soul is registered
   */
  hasSoul(chatId: string): boolean {
    return this.soulRegistry.hasSoul(chatId);
  }

  /**
   * Unregister soul for a chatId (e.g., when chat is dissolved).
   *
   * @param chatId - Chat ID
   */
  unregisterSoul(chatId: string): void {
    this.soulRegistry.unregisterSoul(chatId);
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
    this.soulRegistry.clear();
  }
}
