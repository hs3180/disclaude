/**
 * AgentFactory - Factory for creating ChatAgent instances with unified configuration.
 *
 * Issue #2941: All agents are ChatAgent — the single agent type. Factory methods:
 * - createChatAgent: Create long-lived ChatAgent for AgentPool (by name)
 * - createAgent: Create short-lived ChatAgent for task execution (by chatId)
 *
 * Uses unified configuration types from Issue #327.
 *
 * @example
 * ```typescript
 * // Create a ChatAgent - long-lived, store in AgentPool
 * const pilot = AgentFactory.createChatAgent('pilot', 'chat-123', callbacks);
 *
 * // Create a short-lived ChatAgent - dispose after execution
 * const agent = AgentFactory.createAgent('chat-123', callbacks);
 * try {
 *   await agent.processMessage(chatId, prompt, messageId);
 *   await agent.taskComplete;
 * } finally {
 *   agent.dispose();
 * }
 * ```
 *
 * Issue #2717: Migrated from @disclaude/worker-node to @disclaude/primary-node.
 *
 * @module agents/factory
 */

import { Config, type BaseAgentConfig, type AgentProvider, type SchedulerCallbacks, type MessageBuilderOptions, type ModelTier, type CwdProvider } from '@disclaude/core';
import { ChatAgent } from './chat-agent.js';
import type { ChatAgentConfig, ChatAgentCallbacks } from './types.js';

// ============================================================================
// Issue #1412: Helper function for converting SchedulerCallbacks to ChatAgentCallbacks
// ============================================================================

/**
 * Convert SchedulerCallbacks to ChatAgentCallbacks with no-op implementations.
 *
 * Scheduled tasks typically only need sendMessage capability. This helper
 * provides no-op implementations for sendCard, sendFile, and onDone to
 * satisfy the ChatAgentCallbacks interface.
 *
 * Issue #1412: Removes duplicate empty implementations from Primary Node.
 * Issue #1446: Documents limitation of callback conversion.
 *
 * @param callbacks - SchedulerCallbacks with sendMessage method
 * @returns ChatAgentCallbacks with functional sendMessage and no-op other methods
 *
 * @example
 * ```typescript
 * const schedulerCallbacks: SchedulerCallbacks = {
 *   sendMessage: async (chatId, msg) => { ... }
 * };
 * const pilotCallbacks = toChatAgentCallbacks(schedulerCallbacks);
 * const agent = AgentFactory.createAgent(chatId, pilotCallbacks);
 * ```
 */
export function toChatAgentCallbacks(callbacks: SchedulerCallbacks): ChatAgentCallbacks {
  return {
    sendMessage: callbacks.sendMessage,
    // No-op: Card sending not typically needed for scheduled tasks
    sendCard: async () => {},
    // No-op: File sending not typically needed for scheduled tasks
    sendFile: async () => {},
    // No-op: Completion handled by scheduler
    onDone: async () => {},
  };
}

/**
 * Options for creating agents with custom configuration.
 * Uses unified configuration structure (Issue #327).
 */
export interface AgentCreateOptions {
  /** Override API key */
  apiKey?: string;
  /** Override model */
  model?: string;
  /**
   * Model tier for tier-based model resolution (Issue #3059).
   * Resolved to a model name via Config.getModelForTier().
   * Ignored when `model` is explicitly set.
   */
  modelTier?: ModelTier;
  /** Override API provider */
  provider?: AgentProvider;
  /** Override API base URL */
  apiBaseUrl?: string;
  /** Override permission mode */
  permissionMode?: 'default' | 'bypassPermissions';
  /**
   * Channel-specific MessageBuilder options.
   * Issue #1499: Decouple Feishu-specific logic from worker-node.
   */
  messageBuilderOptions?: MessageBuilderOptions;
  /**
   * Dynamic cwd resolution provider for project-scoped agents.
   * Issue #3332: Project-scoped ChatAgent with chatId binding.
   */
  cwdProvider?: CwdProvider;
}

/**
 * Factory for creating ChatAgent instances with unified configuration.
 *
 * Issue #2941: There is only one agent type (ChatAgent).
 * All factory methods create ChatAgent instances with different lifetimes:
 * - createChatAgent: long-lived (stored in AgentPool)
 * - createAgent: short-lived (disposed after task execution)
 *
 * Each method fetches default configuration from Config.getAgentConfig()
 * and allows optional overrides.
 */
export class AgentFactory {
  /**
   * Get base agent configuration from Config with optional overrides.
   *
   * @param options - Optional configuration overrides
   * @returns BaseAgentConfig with merged configuration
   */
  private static getBaseConfig(options: AgentCreateOptions = {}): BaseAgentConfig {
    const defaultConfig = Config.getAgentConfig();

    // Issue #3059: Model resolution priority:
    // 1. Explicit model override (options.model) — highest priority
    // 2. Tier-specific model (resolved from options.modelTier via Config.getModelForTier())
    // 3. Default model (from Config.getAgentConfig())
    let resolvedModel: string;
    if (options.model) {
      resolvedModel = options.model;
    } else if (options.modelTier) {
      const tierModel = Config.getModelForTier(options.modelTier);
      resolvedModel = tierModel ?? defaultConfig.model;
    } else {
      resolvedModel = defaultConfig.model;
    }

    return {
      apiKey: options.apiKey ?? defaultConfig.apiKey,
      model: resolvedModel,
      provider: options.provider ?? defaultConfig.provider,
      apiBaseUrl: options.apiBaseUrl ?? defaultConfig.apiBaseUrl,
      permissionMode: options.permissionMode ?? 'bypassPermissions',
    };
  }

  // ============================================================================
  // Long-lived ChatAgent Creation (stored in AgentPool)
  // ============================================================================

  /**
   * Create a ChatAgent instance by name.
   *
   * Issue #644: ChatAgent now requires chatId binding at creation time.
   * ChatAgents created here are long-lived and should be stored in AgentPool.
   *
   * @param name - Agent name ('pilot')
   * @param args - Additional arguments:
   *   - args[0]: chatId | ChatAgentCallbacks - ChatId string OR callbacks object (legacy)
   *   - args[1]: ChatAgentCallbacks | AgentCreateOptions - Callbacks OR options
   *   - args[2]: AgentCreateOptions - Optional configuration overrides (when chatId provided)
   * @returns ChatAgent instance
   *
   * @example
   * ```typescript
   * const pilot = AgentFactory.createChatAgent('pilot', 'chat-123', {
   *   sendMessage: async (chatId, text) => { ... },
   *   sendCard: async (chatId, card) => { ... },
   *   sendFile: async (chatId, filePath) => { ... },
   * });
   * ```
   */
  static createChatAgent(name: string, ...args: unknown[]): ChatAgent {
    if (name === 'pilot') {
      // Issue #644: Support both new (chatId, callbacks, options) and legacy (callbacks, options) patterns
      let chatId: string;
      let callbacks: ChatAgentCallbacks;
      let options: AgentCreateOptions;

      if (typeof args[0] === 'string') {
        // New pattern: createChatAgent('pilot', chatId, callbacks, options)
        const [id, cb, opt] = args as [string, ChatAgentCallbacks, AgentCreateOptions?];
        chatId = id;
        callbacks = cb;
        options = opt || {};
      } else {
        // Legacy pattern: createChatAgent('pilot', callbacks, options)
        // This is deprecated but kept for backward compatibility
        const [cb, opt] = args as [ChatAgentCallbacks, AgentCreateOptions?];
        chatId = 'default';
        callbacks = cb;
        options = opt || {};
      }

      const baseConfig = this.getBaseConfig(options);
      const config: ChatAgentConfig = {
        ...baseConfig,
        chatId,
        callbacks,
        messageBuilderOptions: options.messageBuilderOptions,
        cwdProvider: options.cwdProvider,
      };

      return new ChatAgent(config);
    }
    throw new Error(`Unknown ChatAgent: ${name}`);
  }

  // ============================================================================
  // Short-lived ChatAgent Creation (for scheduled/one-shot tasks)
  // ============================================================================

  /**
   * Create a short-lived ChatAgent instance for task execution.
   *
   * Issue #2941: Creates a short-lived ChatAgent that the caller must
   * dispose after execution.
   *
   * @param chatId - Chat ID for message delivery
   * @param callbacks - Callbacks for sending messages
   * @param options - Optional configuration overrides
   * @returns ChatAgent instance (caller must dispose)
   *
   * @example
   * ```typescript
   * const agent = AgentFactory.createAgent('chat-123', callbacks);
   * try {
   *   await agent.processMessage(chatId, prompt, messageId);
   *   await agent.taskComplete;
   * } finally {
   *   agent.dispose();
   * }
   * ```
   */
  static createAgent(
    chatId: string,
    callbacks: ChatAgentCallbacks,
    options: AgentCreateOptions = {}
  ): ChatAgent {
    const baseConfig = this.getBaseConfig(options);
    const config: ChatAgentConfig = {
      ...baseConfig,
      chatId,
      callbacks,
      messageBuilderOptions: options.messageBuilderOptions,
      cwdProvider: options.cwdProvider,
    };

    return new ChatAgent(config);
  }
}
