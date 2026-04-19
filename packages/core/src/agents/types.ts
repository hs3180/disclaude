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
 * - Scheduled tasks (via AgentFactory.createAgent)
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
export type AgentProvider = 'anthropic' | 'glm' | 'openai';

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
  /**
   * ACP Client instance for Agent Client Protocol communication.
   * If not provided, will attempt to get from runtime context.
   * Required for ACP-based query execution (Issue #2311).
   */
  acpClient?: import('../sdk/acp/acp-client.js').AcpClient;
}

// ============================================================================
// Agent Configuration Types (Issue #2345 Phase 5: Legacy types removed)
// ============================================================================
//
// ChatAgentConfig is now defined in worker-node only (chat-agent/types.ts).
// The core package only defines BaseAgentConfig, which is the minimal
// config shared by all agent types.
//
// Removed (Issue #2345 Phase 5):
// - AgentConfig (deprecated, replaced by BaseAgentConfig)
// - ChatAgentConfig in core (worker-node's version is canonical)

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

  // ACP Client (optional - for ACP-based agent execution, Issue #2311)
  /** Get the shared ACP Client instance */
  getAcpClient?(): import('../sdk/acp/acp-client.js').AcpClient;
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
// Agent Factory Types — Removed (Issue #2345 Phase 5)
// ============================================================================
//
// AgentFactoryInterface has been removed. There is only one Agent type
// (ChatAgent), so the interface adds no abstraction value. The concrete
// AgentFactory class in worker-node is the single source of truth.
//
// Use AgentFactory.createAgent() for all agent creation.
