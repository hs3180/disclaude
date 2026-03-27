/**
 * AgentFactory - Factory for creating Agent instances with unified configuration.
 *
 * Implements AgentFactoryInterface from #282 Phase 3 for unified agent creation.
 * All agent creation goes through the type-specific methods:
 * - createChatAgent: Create chat agents (pilot) - long-lived, stored in AgentPool
 * - createScheduleAgent: Create schedule agents - short-lived, max 24h lifetime
 * - createTaskAgent: Create task agents - short-lived, disposed after task
 *
 * Issue #711: Agent Lifecycle Management Strategy
 * Issue #1501: Simplified to ChatAgent-only (Pilot). SkillAgent and Subagent removed.
 *
 * | Agent Type     | chatId Binding | Max Lifetime | Storage Location |
 * |----------------|----------------|--------------|------------------|
 * | ChatAgent      | ✅ Yes         | Unlimited    | AgentPool        |
 * | ScheduleAgent  | ❌ No          | 24 hours     | None (temporary) |
 * | TaskAgent      | ❌ No          | Task finish  | None (temporary) |
 *
 * Uses unified configuration types from Issue #327.
 *
 * @example
 * ```typescript
 * // Create a Pilot (ChatAgent) - long-lived, store in AgentPool
 * const pilot = AgentFactory.createChatAgent('pilot', 'chat-123', callbacks);
 *
 * // Create a ScheduleAgent - short-lived, dispose after execution
 * const scheduleAgent = AgentFactory.createScheduleAgent('chat-123', callbacks);
 * try {
 *   await scheduleAgent.executeOnce(chatId, prompt);
 * } finally {
 *   scheduleAgent.dispose();
 * }
 * ```
 *
 * @module agents/factory
 */

import { Config, type ChatAgent, type BaseAgentConfig, type AgentProvider, type SchedulerCallbacks, type MessageBuilderOptions } from '@disclaude/core';
import { Pilot, type PilotConfig, type PilotCallbacks } from './pilot/index.js';

// ============================================================================
// Issue #1412: Helper function for converting SchedulerCallbacks to PilotCallbacks
// ============================================================================

/**
 * Convert SchedulerCallbacks to PilotCallbacks with no-op implementations.
 *
 * Scheduled tasks typically only need sendMessage capability. This helper
 * provides no-op implementations for sendCard, sendFile, and onDone to
 * satisfy the PilotCallbacks interface.
 *
 * ⚠️ Scheduled task scenarios only require sendMessage capability.
 * sendCard, sendFile, and onDone are all no-op implementations.
 * If scheduled tasks need to send cards/files in the future,
 * the SchedulerCallbacks interface needs to be extended.
 *
 * Issue #1412: Removes duplicate empty implementations from Primary Node.
 * Issue #1446: Documents limitation of callback conversion.
 *
 * @param callbacks - SchedulerCallbacks with sendMessage method
 * @returns PilotCallbacks with functional sendMessage and no-op other methods
 *
 * @example
 * ```typescript
 * const schedulerCallbacks: SchedulerCallbacks = {
 *   sendMessage: async (chatId, msg) => { ... }
 * };
 * const pilotCallbacks = toPilotCallbacks(schedulerCallbacks);
 * const agent = AgentFactory.createScheduleAgent(chatId, pilotCallbacks);
 * ```
 */
export function toPilotCallbacks(callbacks: SchedulerCallbacks): PilotCallbacks {
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
   * System prompt append content for SOUL.md personality injection.
   * Issue #1315: When provided, appended to the system prompt.
   */
  systemPromptAppend?: string;
}

/**
 * Factory for creating Agent instances with unified configuration.
 *
 * This class implements AgentFactoryInterface with type-specific factory methods.
 * Issue #1501: Simplified to only create ChatAgent (Pilot) instances.
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

    return {
      apiKey: options.apiKey ?? defaultConfig.apiKey,
      model: options.model ?? defaultConfig.model,
      provider: options.provider ?? defaultConfig.provider,
      apiBaseUrl: options.apiBaseUrl ?? defaultConfig.apiBaseUrl,
      permissionMode: options.permissionMode ?? 'bypassPermissions',
    };
  }

  // ============================================================================
  // AgentFactoryInterface Implementation
  // ============================================================================

  /**
   * Create a ChatAgent instance by name.
   *
   * Issue #644: Pilot now requires chatId binding at creation time.
   * Issue #711: ChatAgents are long-lived and should be stored in AgentPool.
   *
   * @param name - Agent name ('pilot')
   * @param args - Additional arguments:
   *   - args[0]: chatId | PilotCallbacks - ChatId string OR callbacks object (legacy)
   *   - args[1]: PilotCallbacks | AgentCreateOptions - Callbacks OR options
   *   - args[2]: AgentCreateOptions - Optional configuration overrides (when chatId provided)
   * @returns ChatAgent instance
   *
   * @example
   * ```typescript
   * // Issue #644: New pattern with chatId binding
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
      let callbacks: PilotCallbacks;
      let options: AgentCreateOptions;

      if (typeof args[0] === 'string') {
        // New pattern: createChatAgent('pilot', chatId, callbacks, options)
        const [id, cb, opt] = args as [string, PilotCallbacks, AgentCreateOptions?];
        chatId = id;
        callbacks = cb;
        options = opt || {};
      } else {
        // Legacy pattern: createChatAgent('pilot', callbacks, options)
        // This is deprecated but kept for backward compatibility
        const [cb, opt] = args as [PilotCallbacks, AgentCreateOptions?];
        chatId = 'default';
        callbacks = cb;
        options = opt || {};
      }

      const baseConfig = this.getBaseConfig(options);
      const config: PilotConfig = {
        ...baseConfig,
        chatId,
        callbacks,
        messageBuilderOptions: options.messageBuilderOptions,
        systemPromptAppend: options.systemPromptAppend,
      };

      return new Pilot(config);
    }
    throw new Error(`Unknown ChatAgent: ${name}`);
  }

  // ============================================================================
  // Issue #711: Short-lived Agent Creation Methods
  // ============================================================================

  /**
   * Create a ScheduleAgent for executing scheduled tasks.
   *
   * Issue #711: ScheduleAgents are short-lived and should NOT be stored in AgentPool.
   * - Maximum lifetime: 24 hours
   * - Caller is responsible for disposing after execution
   *
   * @param chatId - Chat ID for message delivery
   * @param callbacks - Callbacks for sending messages
   * @param options - Optional configuration overrides
   * @returns ChatAgent instance (caller must dispose)
   *
   * @example
   * ```typescript
   * const agent = AgentFactory.createScheduleAgent('chat-123', callbacks);
   * try {
   *   await agent.executeOnce(chatId, prompt);
   * } finally {
   *   agent.dispose();
   * }
   * ```
   */
  static createScheduleAgent(
    chatId: string,
    callbacks: PilotCallbacks,
    options: AgentCreateOptions = {}
  ): ChatAgent {
    const baseConfig = this.getBaseConfig(options);
    const config: PilotConfig = {
      ...baseConfig,
      chatId,
      callbacks,
      messageBuilderOptions: options.messageBuilderOptions,
      systemPromptAppend: options.systemPromptAppend,
    };

    return new Pilot(config);
  }

  /**
   * Create a TaskAgent for executing one-time tasks.
   *
   * Issue #711: TaskAgents are short-lived and should NOT be stored in AgentPool.
   * - Maximum lifetime: Until task completion
   * - Caller is responsible for disposing after execution
   *
   * @param chatId - Chat ID for message delivery
   * @param callbacks - Callbacks for sending messages
   * @param options - Optional configuration overrides
   * @returns ChatAgent instance (caller must dispose)
   *
   * @example
   * ```typescript
   * const agent = AgentFactory.createTaskAgent('chat-123', callbacks);
   * try {
   *   await agent.executeOnce(chatId, prompt);
   * } finally {
   *   agent.dispose();
   * }
   * ```
   */
  static createTaskAgent(
    chatId: string,
    callbacks: PilotCallbacks,
    options: AgentCreateOptions = {}
  ): ChatAgent {
    const baseConfig = this.getBaseConfig(options);
    const config: PilotConfig = {
      ...baseConfig,
      chatId,
      callbacks,
      messageBuilderOptions: options.messageBuilderOptions,
      systemPromptAppend: options.systemPromptAppend,
    };

    return new Pilot(config);
  }
}
