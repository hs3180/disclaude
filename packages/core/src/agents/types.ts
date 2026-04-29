/**
 * Agent Type Definitions - Unified interfaces for Agent classification.
 *
 * This module defines the core interfaces for the Agent architecture (Issue #1501):
 *
 * Simplified Architecture (ChatAgent-only):
 * - ChatAgent is the single Agent implementation in code
 * - Subagent functionality is defined via .md files in .claude/agents/
 * - Managed by Claude Code's native subagent mechanism (Issue #1410)
 *
 * Key Design Principles (Issue #1501):
 * 1. **ChatAgent as the only Agent implementation** - Single code-level Agent type
 * 2. **SkillAgent removed** - Skills handled via ChatAgent or .md-defined subagents
 * 3. **Subagent via .md files** - Defined in .claude/agents/, managed by Claude Code
 *
 * @module agents/types
 */

import type { AgentMessage, FileRef } from '../types/index.js';

// ============================================================================
// Disposable Interface (Issue #328)
// ============================================================================

/**
 * Disposable - Interface for resource cleanup.
 *
 * All agents should implement this interface to ensure proper resource release.
 * The dispose() method is called when the agent is no longer needed.
 *
 * @example
 * ```typescript
 * const agent = new ChatAgent(config);
 * try {
 *   await agent.start();
 *   // use agent...
 * } finally {
 *   agent.dispose();
 * }
 * ```
 */
export interface Disposable {
  /**
   * Dispose of resources held by this agent.
   *
   * This method should:
   * - Release all held resources
   * - Close any open connections
   * - Clear any cached data
   * - Be idempotent (safe to call multiple times)
   */
  dispose(): void;
}

// ============================================================================
// User Input Types
// ============================================================================

/**
 * User input for agent processing.
 */
export interface UserInput {
  /** User role */
  role: 'user';
  /** Message content */
  content: string;
  /** Optional metadata */
  metadata?: {
    /** Chat ID for context */
    chatId?: string;
    /** Parent message ID for thread replies */
    parentMessageId?: string;
    /** File references attached to the message */
    fileRefs?: Array<{
      name: string;
      path: string;
      type: string;
    }>;
  };
}

// ============================================================================
// ChatAgent Interface (Issue #1501: Only remaining Agent type)
// ============================================================================

/**
 * ChatAgent - Continuous conversation agent with streaming input/output.
 *
 * This is the **only** agent interface in the simplified architecture (Issue #1501).
 * ChatAgent implements this interface and serves as the universal agent for all scenarios:
 * - Long-lived conversation (via handleInput + processMessage)
 * - One-shot task execution (via executeOnce) - replaces former SkillAgent/Subagent
 * - Scheduled tasks (via AgentFactory.createAgent())
 *
 * @example
 * ```typescript
 * const chatAgent: ChatAgent = new ChatAgent(config);
 * await chatAgent.start();
 *
 * // Process user messages
 * for await (const response of chatAgent.handleInput(userInputStream)) {
 *   console.log(response.content);
 * }
 *
 * // Reset session when done
 * chatAgent.reset();
 *
 * // Dispose when agent is no longer needed
 * chatAgent.dispose();
 * ```
 */
export interface ChatAgent extends Disposable {
  /** Agent type identifier */
  readonly type: 'chat';

  /** Agent name for logging */
  readonly name: string;

  /**
   * Start the agent session.
   * Called once before processing any messages.
   */
  start(): Promise<void>;

  /**
   * Handle streaming user input and yield responses.
   *
   * @param input - AsyncGenerator yielding user messages
   * @yields AgentMessage responses
   */
  handleInput(input: AsyncGenerator<UserInput>): AsyncGenerator<AgentMessage>;

  /**
   * Process a message from a user.
   *
   * @param chatId - Chat/conversation ID
   * @param text - Message text
   * @param messageId - Unique message identifier
   * @param senderOpenId - Optional sender's open_id for @ mentions
   * @param attachments - Optional file attachments
   * @param chatHistoryContext - Optional chat history context for passive mode (Issue #517)
   */
  processMessage(
    chatId: string,
    text: string,
    messageId: string,
    senderOpenId?: string,
    attachments?: FileRef[],
    chatHistoryContext?: string
  ): void;

  /**
   * Execute a one-shot query (for CLI and scheduled tasks).
   *
   * @param chatId - Chat/conversation ID
   * @param text - Message text
   * @param messageId - Optional message identifier
   * @param senderOpenId - Optional sender's open_id
   */
  executeOnce(
    chatId: string,
    text: string,
    messageId?: string,
    senderOpenId?: string
  ): Promise<void>;

  /**
   * Reset the agent session.
   * Clears conversation history and state.
   *
   * @param chatId - Optional chat ID to reset specific session
   * @param keepContext - If true, reloads history context after reset (default: false)
   */
  reset(chatId?: string, keepContext?: boolean): void;

  /**
   * Stop the current query without resetting the session.
   * Issue #1349: /stop command
   *
   * Unlike reset(), this only interrupts the current streaming response
   * while preserving the session state and conversation context.
   *
   * @param chatId - Optional chat ID to stop specific session
   * @returns true if a query was stopped, false if no active query
   */
  stop(chatId?: string): boolean;
}

// ============================================================================
// Agent Type Guards
// ============================================================================

/**
 * Type guard to check if an agent is a ChatAgent.
 */
export function isChatAgent(agent: unknown): agent is ChatAgent {
  return (
    typeof agent === 'object' &&
    agent !== null &&
    'type' in agent &&
    (agent as { type: string }).type === 'chat'
  );
}

/**
 * Type guard to check if an object is Disposable.
 */
export function isDisposable(obj: unknown): obj is Disposable {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'dispose' in obj &&
    typeof (obj as { dispose: unknown }).dispose === 'function'
  );
}

// ============================================================================
// Agent Configuration Types (Issue #327)
// ============================================================================

/**
 * API provider type.
 */
export type AgentProvider = 'anthropic' | 'glm';

/**
 * Base configuration for all agents.
 *
 * This is the unified configuration interface that all agents use.
 * It consolidates previously scattered configuration fields.
 *
 * @example
 * ```typescript
 * const config: BaseAgentConfig = {
 *   apiKey: 'sk-...',
 *   model: 'claude-3-5-sonnet-20241022',
 *   provider: 'anthropic',
 * };
 * ```
 */
export interface BaseAgentConfig {
  /** API key for authentication */
  apiKey: string;
  /** Model identifier */
  model: string;
  /** API provider (anthropic or glm) */
  provider?: AgentProvider;
  /** Optional API base URL (e.g., for GLM) */
  apiBaseUrl?: string;
  /** Permission mode for tool execution */
  permissionMode?: 'default' | 'bypassPermissions';
}

/**
 * Configuration for the ChatAgent implementation.
 *
 * Extends BaseAgentConfig with platform-specific callbacks
 * for streaming conversation support.
 *
 * @example
 * ```typescript
 * const config: ChatAgentConfig = {
 *   apiKey: 'sk-...',
 *   model: 'claude-3-5-sonnet-20241022',
 *   provider: 'anthropic',
 *   callbacks: {
 *     sendMessage: async (chatId, text) => { ... },
 *     sendCard: async (chatId, card) => { ... },
 *     sendFile: async (chatId, filePath) => { ... },
 *   },
 * };
 * ```
 */
export interface ChatAgentConfig extends BaseAgentConfig {
  /**
   * Callback functions for platform-specific operations.
   */
  callbacks: {
    /** Send a text message */
    sendMessage: (chatId: string, text: string, parentMessageId?: string) => Promise<void>;
    /** Send an interactive card */
    sendCard: (chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string) => Promise<void>;
    /** Send a file */
    sendFile: (chatId: string, filePath: string) => Promise<void>;
    /** Called when query completes */
    onDone?: (chatId: string, parentMessageId?: string) => Promise<void>;
  };
}

// ============================================================================
// Agent Factory Types
// ============================================================================

/**
 * Configuration for creating agents.
 * @deprecated Use BaseAgentConfig or ChatAgentConfig instead.
 */
export interface AgentConfig {
  /** API key for authentication */
  apiKey: string;
  /** Model identifier */
  model: string;
  /** Optional API base URL */
  apiBaseUrl?: string;
  /** Permission mode for tool execution */
  permissionMode?: 'default' | 'bypassPermissions';
}

// ============================================================================
// Runtime Context Interface (Issue #1040)
// ============================================================================

/**
 * Runtime context interface for dependency injection.
 *
 * Main package implements this interface and injects it into core
 * to decouple agents from platform-specific dependencies.
 *
 * @example
 * ```typescript
 * // In main package (src/cli-entry.ts)
 * import { setRuntimeContext } from '@disclaude/core';
 *
 * setRuntimeContext({
 *   getWorkspaceDir: () => Config.getWorkspaceDir(),
 *   getAgentConfig: () => Config.getAgentConfig(),
 *   getLoggingConfig: () => Config.getLoggingConfig(),
 *   getGlobalEnv: () => Config.getGlobalEnv(),
 *   isAgentTeamsEnabled: () => Config.isAgentTeamsEnabled(),
 *   createMcpServer: (chatId) => createChannelMcpServer(chatId),
 *   findSkill: (name) => findSkill(name),
 * });
 * ```
 */
export interface AgentRuntimeContext {
  // Config-related methods
  /** Get the workspace directory path */
  getWorkspaceDir(): string;
  /** Get agent configuration (API key, model, provider) */
  getAgentConfig(): { apiKey: string; model: string; apiBaseUrl?: string; provider: AgentProvider };
  /** Get logging configuration */
  getLoggingConfig(): { sdkDebug: boolean };
  /** Get global environment variables */
  getGlobalEnv(): Record<string, string>;
  /** Check if Agent Teams mode is enabled */
  isAgentTeamsEnabled(): boolean;

  // Platform adapters (optional - only needed for ChatAgent)
  /** Create MCP server instance for a chatId */
  createMcpServer?(chatId: string): Promise<unknown>;
  /** Send a text message to a chat */
  sendMessage?(chatId: string, text: string, parentMessageId?: string): Promise<void>;
  /** Send an interactive card to a chat */
  sendCard?(chatId: string, card: Record<string, unknown>, description?: string, parentMessageId?: string): Promise<void>;
  /** Send a file to a chat */
  sendFile?(chatId: string, filePath: string): Promise<void>;

  // Skill-related methods (optional)
  /** Find a skill by name */
  findSkill?(skillName: string): Promise<string | undefined>;
}

// Global runtime context (set by main package)
let globalRuntimeContext: AgentRuntimeContext | null = null;

/**
 * Set the runtime context for agents.
 * Must be called by main package before using any agents.
 *
 * @param ctx - Runtime context implementation
 */
export function setRuntimeContext(ctx: AgentRuntimeContext): void {
  globalRuntimeContext = ctx;
}

/**
 * Get the runtime context.
 * Throws if context is not set.
 *
 * @returns The runtime context
 * @throws Error if context not set
 */
export function getRuntimeContext(): AgentRuntimeContext {
  if (!globalRuntimeContext) {
    throw new Error('Runtime context not set. Call setRuntimeContext() first.');
  }
  return globalRuntimeContext;
}

/**
 * Check if runtime context is set.
 * Useful for conditional behavior during migration.
 *
 * @returns true if context is set
 */
export function hasRuntimeContext(): boolean {
  return globalRuntimeContext !== null;
}

/**
 * Clear the runtime context (for testing).
 */
export function clearRuntimeContext(): void {
  globalRuntimeContext = null;
}

// ============================================================================
// Agent Factory Types (Issue #2941: Simplified to ChatAgent-only)
// ============================================================================

/**
 * Factory for creating Agent instances.
 *
 * Issue #2941: Simplified — there is only one agent type (ChatAgent).
 * All factory methods now return ChatAgent instances.
 *
 * | Agent Type     | chatId Binding | Max Lifetime | Storage Location |
 * |----------------|----------------|--------------|------------------|
 * | ChatAgent      | ✅ Yes         | Unlimited    | AgentPool        |
 *
 * Note: ScheduleAgent/TaskAgent were intermediate abstractions that have
 * been removed. They were identical ChatAgent instances created for
 * short-lived use cases (scheduled tasks, one-shot tasks).
 *
 * @example
 * ```typescript
 * const factory = new AgentFactory(config);
 *
 * // Create ChatAgent (long-lived, store in AgentPool)
 * const pilot = factory.createChatAgent('pilot', callbacks);
 *
 * // Create short-lived ChatAgent for scheduled tasks (dispose after execution)
 * const agent = factory.createAgent(chatId, callbacks);
 * try {
 *   await agent.executeOnce(chatId, prompt);
 * } finally {
 *   agent.dispose();
 * }
 * ```
 *
 * @deprecated This interface adds unnecessary indirection since there is
 * only ChatAgent. Use concrete factory classes directly instead.
 */
export interface AgentFactoryInterface {
  /**
   * Create a ChatAgent instance.
   * Long-lived, should be stored in AgentPool.
   */
  createChatAgent(name: string, ...args: unknown[]): ChatAgent;

  /**
   * Create a short-lived ChatAgent instance for task execution.
   * Caller must dispose after execution.
   *
   * @deprecated Use createAgent() with the same signature instead.
   */
  createScheduleAgent(chatId: string, callbacks: unknown, options?: unknown): ChatAgent;

  /**
   * Create a short-lived ChatAgent instance for task execution.
   * Caller must dispose after task completion.
   *
   * @deprecated Use createAgent() with the same signature instead.
   */
  createTaskAgent(chatId: string, callbacks: unknown, options?: unknown): ChatAgent;
}
