/**
 * AgentFactory - Factory for creating ChatAgent instances with unified configuration.
 *
 * Issue #2345 Phase 5: Simplified to a single createAgent() method.
 * Issue #2717 Phase 1: Migrated from @disclaude/worker-node to @disclaude/core.
 *
 * The previous createScheduleAgent / createTaskAgent / createChatAgent methods
 * all had identical implementations. Now there is just one method.
 *
 * Uses unified configuration types from Issue #327.
 *
 * @example
 * ```typescript
 * // Create a ChatAgent for any purpose (chat, schedule, task)
 * const agent = AgentFactory.createAgent('chat-123', callbacks);
 * try {
 *   await agent.executeOnce(chatId, prompt);
 * } finally {
 *   agent.dispose();
 * }
 * ```
 *
 * @module agents/agent-factory
 */

import { Config } from '../config/index.js';
import type { ChatAgent as ChatAgentInterface, BaseAgentConfig, AgentProvider } from './types.js';
import type { SchedulerCallbacks } from '../scheduling/index.js';
import type { MessageBuilderOptions } from './message-builder/types.js';
import { ChatAgent } from './chat-agent/chat-agent.js';
import type { ChatAgentConfig, ChatAgentCallbacks } from './chat-agent/types.js';

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
 * ⚠️ Scheduled task scenarios only require sendMessage capability.
 * sendCard, sendFile, and onDone are all no-op implementations.
 * If scheduled tasks need to send cards/files in the future,
 * the SchedulerCallbacks interface needs to be extended.
 *
 * Issue #1412: Removes duplicate empty implementations from Primary Node.
 * Issue #1446: Documents limitation of callback conversion.
 * Issue #2717: Migrated from @disclaude/worker-node to @disclaude/core.
 *
 * @param callbacks - SchedulerCallbacks with sendMessage method
 * @returns ChatAgentCallbacks with functional sendMessage and no-op other methods
 *
 * @example
 * ```typescript
 * const schedulerCallbacks: SchedulerCallbacks = {
 *   sendMessage: async (chatId, msg) => { ... }
 * };
 * const agentCallbacks = toChatAgentCallbacks(schedulerCallbacks);
 * const agent = AgentFactory.createAgent(chatId, agentCallbacks);
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
   * Factory function to create the channel MCP server.
   * Injected to avoid circular dependency between core and mcp-server.
   * Issue #2717 Phase 1: Migrated from @disclaude/worker-node.
   */
  createChannelMcpServer?: () => unknown;
}

/**
 * Factory for creating ChatAgent instances with unified configuration.
 *
 * Issue #2345 Phase 5: Simplified to a single createAgent() method.
 * Issue #2717 Phase 1: Migrated from @disclaude/worker-node to @disclaude/core.
 *
 * All agent types (chat, schedule, task) are now ChatAgent instances
 * created through the same method.
 *
 * Each call fetches default configuration from Config.getAgentConfig()
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

  /**
   * Create a ChatAgent instance.
   *
   * This is the unified factory method for all agent creation.
   * Whether the agent is used for long-lived chat, short-lived scheduled tasks,
   * or one-time task execution, they are all ChatAgent instances.
   *
   * @param chatId - Chat ID for message delivery and session binding
   * @param callbacks - Callbacks for platform-specific operations
   * @param options - Optional configuration overrides
   * @returns ChatAgent instance
   *
   * @example
   * ```typescript
   * // Long-lived chat agent (store in AgentPool)
   * const agent = AgentFactory.createAgent('chat-123', callbacks, {
   *   messageBuilderOptions: { ... },
   * });
   *
   * // Short-lived schedule/task agent (dispose after execution)
   * const agent = AgentFactory.createAgent('chat-456', callbacks, {
   *   model: 'claude-3-5-sonnet-20241022',
   * });
   * try {
   *   await agent.executeOnce(chatId, prompt);
   * } finally {
   *   agent.dispose();
   * }
   * ```
   */
  static createAgent(
    chatId: string,
    callbacks: ChatAgentCallbacks,
    options: AgentCreateOptions = {}
  ): ChatAgentInterface {
    const baseConfig = this.getBaseConfig(options);
    const config: ChatAgentConfig = {
      ...baseConfig,
      chatId,
      callbacks: callbacks as ChatAgentConfig['callbacks'],
      messageBuilderOptions: options.messageBuilderOptions,
      createChannelMcpServer: options.createChannelMcpServer,
    };

    return new ChatAgent(config);
  }
}
