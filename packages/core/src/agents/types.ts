/**
 * Agent Type Definitions - Unified interfaces for Agent classification.
 *
 * This module defines the core interfaces for the simplified Agent architecture (Issue #1501):
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    Simplified Agent 体系                     │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                             │
 * │  ┌─────────────────┐     ┌─────────────────────────────┐   │
 * │  │  ChatAgent      │     │  Subagent                   │   │
 * │  │  (对话型)        │     │  (工具封装型)               │   │
 * │  │                 │     │                             │   │
 * │  │  ┌───────────┐  │     │  ┌───────────┐              │   │
 * │  │  │  Pilot    │  │     │  │ SiteMiner │              │   │
 * │  │  └───────────┘  │     │  └───────────┘              │   │
 * │  └─────────────────┘     └─────────────────────────────┘   │
 * │           │                           │                     │
 * │           │ 调用工具                   │ 被封装              │
 * │           ▼                           ▼                     │
 * │  ┌─────────────────────────────────────────────────────┐   │
 * │  │  Skills (via .md definitions)                        │   │
 * │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐               │   │
 * │  │  │evaluator│ │ executor│ │ reporter│  ...            │   │
 * │  │  └─────────┘ └─────────┘ └─────────┘               │   │
 * │  └─────────────────────────────────────────────────────┘   │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Key Design Principles:
 * 1. **ChatAgent** - For continuous conversation with streaming input/output (Pilot)
 * 2. **Subagent** - For tool-encapsulated agents that can be invoked by ChatAgent
 * 3. **Skills** - Defined via .md files, executed through Pilot or Claude Code subagents
 *
 * Note: SkillAgent interface was removed in Issue #1501. Skill execution is now
 * handled through Pilot + .md-defined subagents.
 *
 * @module agents/types
 */

import type { AgentMessage, FileRef } from '../types/index.js';
import type { InlineToolDefinition, McpServerConfig } from '../sdk/index.js';

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
 * const agent = new Pilot(config);
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
// ChatAgent Interface (对话型 Agent)
// ============================================================================

/**
 * ChatAgent - Continuous conversation agent with streaming input/output.
 *
 * Characteristics:
 * - Maintains persistent conversation session
 * - Streaming input from user
 * - Streaming output to user
 * - Maintains session state across messages
 *
 * Current implementations:
 * - `Pilot` - Main conversational agent with user
 *
 * @example
 * ```typescript
 * const chatAgent: ChatAgent = new Pilot(config);
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
// Subagent Interface (工具封装型 Agent)
// ============================================================================

/**
 * Subagent - Tool-encapsulated agent that can be invoked by ChatAgent.
 *
 * Characteristics:
 * - Extends Disposable for resource cleanup
 * - Can be exposed as an inline tool for other agents (via asTool())
 * - May have its own isolated MCP server (via getMcpServer())
 * - Has distinct type identifier 'subagent'
 *
 * Current implementations:
 * - `SiteMiner` - Playwright-based site mining, exposed as tool
 *
 * @example
 * ```typescript
 * const subagent: Subagent = createSiteMiner();
 *
 * // Execute task
 * for await (const response of subagent.execute(taskInput)) {
 *   console.log(response.content);
 * }
 *
 * // Or use as tool definition for other agents
 * const toolDef = subagent.asTool();
 * // toolDef can be added to another agent's MCP server
 *
 * // Get MCP server config if running standalone
 * const mcpConfig = subagent.getMcpServer();
 * ```
 */
export interface Subagent extends Disposable {
  /** Agent type identifier */
  readonly type: 'subagent';

  /** Agent name for logging */
  readonly name: string;

  /**
   * Execute a single task and yield results.
   *
   * @param input - Task input as string or structured data
   * @yields AgentMessage responses
   */
  execute(input: string | UserInput[]): AsyncGenerator<AgentMessage>;

  /**
   * Get the agent's tool definition for use by other agents.
   *
   * Returns an InlineToolDefinition that can be added to an
   * inline MCP server, allowing other agents to invoke this
   * subagent as a tool.
   *
   * @returns Tool definition for MCP registration
   */
  asTool(): InlineToolDefinition;

  /**
   * Get MCP server configuration for standalone execution.
   *
   * Returns configuration for running this subagent with its
   * own isolated MCP server (e.g., for context isolation).
   *
   * @returns MCP server configuration, or undefined if not applicable
   */
  getMcpServer(): McpServerConfig | undefined;
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
 * Type guard to check if an agent is a Subagent.
 *
 * Checks for:
 * 1. type === 'subagent'
 * 2. Has asTool() method
 * 3. Has getMcpServer() method
 */
export function isSubagent(agent: unknown): agent is Subagent {
  return (
    typeof agent === 'object' &&
    agent !== null &&
    'type' in agent &&
    (agent as { type: string }).type === 'subagent' &&
    'asTool' in agent &&
    typeof (agent as { asTool: unknown }).asTool === 'function' &&
    'getMcpServer' in agent &&
    typeof (agent as { getMcpServer: unknown }).getMcpServer === 'function'
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
 * Configuration for ChatAgent (Pilot).
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

/**
 * Configuration for Subagent (SiteMiner).
 *
 * Subagents are tool-encapsulated agents with their own isolated capabilities.
 *
 * @example
 * ```typescript
 * const config: SubagentConfig = {
 *   apiKey: 'sk-...',
 *   model: 'claude-3-5-sonnet-20241022',
 *   provider: 'anthropic',
 *   defaultTimeout: 120000, // 2 minutes
 * };
 * ```
 */
export interface SubagentConfig extends BaseAgentConfig {
  /** Default timeout for operations in milliseconds */
  defaultTimeout?: number;
}

// ============================================================================
// Agent Factory Types
// ============================================================================

/**
 * Configuration for creating agents.
 * @deprecated Use BaseAgentConfig, ChatAgentConfig, or SubagentConfig instead.
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
// Agent Factory Types
// ============================================================================

/**
 * Factory for creating Agent instances.
 *
 * Issue #711: Agent Lifecycle Management Strategy
 * Issue #1501: Simplified to ChatAgent + Subagent (SkillAgent removed)
 *
 * | Agent Type     | chatId Binding | Max Lifetime | Storage Location |
 * |----------------|----------------|--------------|------------------|
 * | ChatAgent      | ✅ Yes         | Unlimited    | AgentPool        |
 * | ScheduleAgent  | ❌ No          | 24 hours     | None (temporary) |
 * | TaskAgent      | ❌ No          | Task finish  | None (temporary) |
 *
 * @example
 * ```typescript
 * const factory = new AgentFactory(config);
 *
 * // Create ChatAgent (long-lived, store in AgentPool)
 * const pilot = factory.createChatAgent('pilot', callbacks);
 *
 * // Create ScheduleAgent (short-lived, dispose after execution)
 * const scheduleAgent = factory.createScheduleAgent(chatId, callbacks);
 * try {
 *   await scheduleAgent.executeOnce(chatId, prompt);
 * } finally {
 *   scheduleAgent.dispose();
 * }
 *
 * // Create Subagent
 * const siteMiner = factory.createSubagent('site-miner');
 * ```
 */
export interface AgentFactoryInterface {
  /**
   * Create a ChatAgent instance.
   * Long-lived, should be stored in AgentPool.
   */
  createChatAgent(name: string, ...args: unknown[]): ChatAgent;

  /**
   * Create a ScheduleAgent instance.
   * Short-lived, caller must dispose after execution.
   * Maximum lifetime: 24 hours.
   */
  createScheduleAgent(chatId: string, callbacks: unknown, options?: unknown): ChatAgent;

  /**
   * Create a TaskAgent instance.
   * Short-lived, caller must dispose after task completion.
   */
  createTaskAgent(chatId: string, callbacks: unknown, options?: unknown): ChatAgent;

  /**
   * Create a Subagent instance.
   * Short-lived, caller must dispose after execution.
   */
  createSubagent(name: string, ...args: unknown[]): Subagent;
}
