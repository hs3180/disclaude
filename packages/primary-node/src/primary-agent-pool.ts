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
 * Issue #1228: Loads SOUL.md content for groups with soulId configured.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

import { type MessageBuilderOptions, loadSoul, formatSoulAsSystemPrompt, createLogger } from '@disclaude/core';
import { AgentFactory, type PilotCallbacks, type ChatAgent } from '@disclaude/worker-node';
import { GroupService } from './platforms/feishu/group-service.js';

const logger = createLogger('PrimaryAgentPool');

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
  private readonly groupService: GroupService;

  constructor(options: PrimaryAgentPoolOptions = {}) {
    this.options = options;
    this.groupService = new GroupService();
  }

  /**
   * Get or create a ChatAgent instance for the given chatId.
   *
   * Issue #1228: If the chatId belongs to a group with a soulId configured,
   * loads the corresponding SOUL.md file and passes its content to the Pilot
   * for personality injection via systemPromptAppend.
   *
   * @param chatId - Chat ID to get/create agent for
   * @param callbacks - Callbacks for sending messages (required for new agents)
   * @returns ChatAgent instance
   */
  getOrCreateChatAgent(chatId: string, callbacks: PilotCallbacks): ChatAgent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      // Issue #1228: Load soul content for this chat if configured
      const soulContent = this.loadSoulForChat(chatId);

      agent = AgentFactory.createChatAgent('pilot', chatId, callbacks, {
        messageBuilderOptions: this.options.messageBuilderOptions,
        soulContent: soulContent || undefined,
      });
      this.agents.set(chatId, agent);
    }
    return agent;
  }

  /**
   * Load SOUL.md content for a chat based on its group's soulId.
   *
   * Checks if the chatId belongs to a group with a soulId configured,
   * and if so, loads the corresponding SOUL.md file from the souls/ directory.
   *
   * @param chatId - Chat ID to load soul for
   * @returns Formatted soul content string, or undefined if no soul is configured
   */
  private loadSoulForChat(chatId: string): string | undefined {
    try {
      const groupInfo = this.groupService.getGroup(chatId);
      if (!groupInfo?.soulId) {
        return undefined;
      }

      const soulResult = loadSoul({
        explicitPath: `souls/${groupInfo.soulId}.md`,
        configPath: `~/.disclaude/souls/${groupInfo.soulId}.md`,
      });

      if (soulResult.found && soulResult.content) {
        logger.info(
          { chatId, soulId: groupInfo.soulId, sourcePath: soulResult.sourcePath },
          'Loaded SOUL.md for chat agent'
        );
        return formatSoulAsSystemPrompt(soulResult.content);
      }

      logger.warn(
        { chatId, soulId: groupInfo.soulId },
        'SOUL.md file not found for configured soulId'
      );
      return undefined;
    } catch (error) {
      logger.error(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Failed to load SOUL.md for chat agent'
      );
      return undefined;
    }
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
