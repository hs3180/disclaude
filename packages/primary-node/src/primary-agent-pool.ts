/**
 * PrimaryAgentPool - Agent pool for Primary Node.
 *
 * Manages ChatAgent instances for each chatId, using AgentFactory
 * from @disclaude/worker-node to create Pilot instances.
 *
 * Issue #1499: Accepts optional MessageBuilderOptions for channel-specific
 * message building (e.g., Feishu sections). This decouples Feishu-specific
 * logic from worker-node.
 * Issue #1228: Supports per-chat SOUL.md loading via GroupService.
 * When a chat has a soulPath set in GroupService, the SOUL content is
 * loaded and injected as systemPromptAppend for the Pilot instance.
 *
 * @see Issue #1040 - Separate Primary Node code to @disclaude/primary-node
 */

import {
  type MessageBuilderOptions,
  SoulLoader,
  createLogger,
} from '@disclaude/core';
import { AgentFactory, type PilotCallbacks, type ChatAgent } from '@disclaude/worker-node';

const logger = createLogger('PrimaryAgentPool');

/**
 * Interface for resolving a soul path for a given chatId.
 *
 * This abstraction allows PrimaryAgentPool to check for per-chat
 * soul profiles without being tightly coupled to GroupService.
 *
 * @see Issue #1228
 */
export interface SoulPathResolver {
  /**
   * Get the SOUL.md path for a chat.
   * @param chatId - Chat ID to look up
   * @returns Absolute path to SOUL.md file, or undefined if none is set
   */
  getSoulPath(chatId: string): string | undefined;
}

/**
 * Options for PrimaryAgentPool initialization.
 *
 * Issue #1499: Allows injecting channel-specific MessageBuilderOptions
 * at pool creation time.
 * Issue #1228: Allows injecting a SoulPathResolver for per-chat soul loading.
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
   * Resolver for per-chat SOUL.md paths.
   *
   * When provided, PrimaryAgentPool checks if a chat has an associated
   * SOUL profile before creating the Pilot. If found, the SOUL content
   * is loaded and injected as systemPromptAppend.
   *
   * GroupService implements this interface (via getSoulPath method).
   *
   * @see Issue #1228
   */
  soulPathResolver?: SoulPathResolver;
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
  /** Cache of loaded soul content keyed by soulPath. */
  private readonly soulCache = new Map<string, string>();

  constructor(options: PrimaryAgentPoolOptions = {}) {
    this.options = options;
  }

  /**
   * Get or create a ChatAgent instance for the given chatId.
   *
   * Issue #1228: If a soulPath is configured for this chatId (via
   * soulPathResolver), the SOUL content is loaded and injected as
   * systemPromptAppend for the Pilot instance.
   *
   * @param chatId - Chat ID to get/create agent for
   * @param callbacks - Callbacks for sending messages (required for new agents)
   * @returns ChatAgent instance
   */
  getOrCreateChatAgent(chatId: string, callbacks: PilotCallbacks): ChatAgent {
    let agent = this.agents.get(chatId);
    if (!agent) {
      const systemPromptAppend = this.resolveSoulContent(chatId);
      agent = AgentFactory.createChatAgent('pilot', chatId, callbacks, {
        messageBuilderOptions: this.options.messageBuilderOptions,
        ...(systemPromptAppend ? { systemPromptAppend } : {}),
      });
      this.agents.set(chatId, agent);
    }
    return agent;
  }

  /**
   * Resolve and load SOUL content for a given chatId.
   *
   * Uses the soulPathResolver to find the soul path, then loads
   * the content via SoulLoader. Results are cached to avoid
   * re-reading the file for every message.
   *
   * @param chatId - Chat ID to resolve soul for
   * @returns SOUL content string, or undefined if no soul is configured
   */
  private resolveSoulContent(chatId: string): string | undefined {
    const soulPath = this.options.soulPathResolver?.getSoulPath(chatId);
    if (!soulPath) {
      return undefined;
    }

    // Check cache first
    const cached = this.soulCache.get(soulPath);
    if (cached) {
      return cached;
    }

    // Load synchronously is not possible (SoulLoader.load is async).
    // Instead, we preload souls eagerly via loadSoulForChat() or
    // fall back to returning the path for deferred loading.
    // For the initial implementation, we use a synchronous cache
    // that must be populated before agent creation.
    logger.warn(
      { chatId, soulPath },
      'Soul content not preloaded. Call loadSoulForChat() before getOrCreateChatAgent().',
    );
    return undefined;
  }

  /**
   * Preload SOUL content for a chat.
   *
   * Should be called before getOrCreateChatAgent() for chats that
   * have a soulPath configured. The loaded content is cached and
   * will be used when the Pilot is created.
   *
   * @param chatId - Chat ID to preload soul for
   * @returns The loaded SOUL content, or undefined if no soul is configured
   *
   * @example
   * ```typescript
   * await pool.loadSoulForChat(chatId);
   * const agent = pool.getOrCreateChatAgent(chatId, callbacks);
   * // Agent will have soul content injected as systemPromptAppend
   * ```
   */
  async loadSoulForChat(chatId: string): Promise<string | undefined> {
    const soulPath = this.options.soulPathResolver?.getSoulPath(chatId);
    if (!soulPath) {
      return undefined;
    }

    // Check cache
    const cached = this.soulCache.get(soulPath);
    if (cached) {
      return cached;
    }

    try {
      const loader = new SoulLoader(soulPath);
      const result = await loader.load();
      if (result) {
        this.soulCache.set(soulPath, result.content);
        logger.info(
          { chatId, soulPath: result.path, size: result.size },
          'Soul content loaded for chat',
        );
        return result.content;
      }
      logger.warn({ chatId, soulPath }, 'Soul file not found');
      return undefined;
    } catch (error) {
      logger.error({ chatId, soulPath, err: error }, 'Failed to load soul for chat');
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
    this.soulCache.clear();
  }
}
