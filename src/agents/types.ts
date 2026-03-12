/**
 * Agent Type Definitions - Unified interfaces for Agent classification.
 *
 * This module defines the core interfaces for the Agent architecture as described in Issue #282:
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      Agent 体系                              │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                             │
 * │  ┌─────────────────┐     ┌─────────────────────────────┐   │
 * │  │  ChatAgent      │     │  SkillAgent                 │   │
 * │  │  (对话型)        │     │  (技能型)                   │   │
 * │  │                 │     │                             │   │
 * │  │  ┌───────────┐  │     │  ┌─────────┐ ┌─────────┐   │   │
 * │  │  │  Pilot    │  │     │  │Evaluator│ │Executor │...│   │
 * │  │  └───────────┘  │     │  └─────────┘ └─────────┘   │   │
 * │  └─────────────────┘     └─────────────────────────────┘   │
 * │           │                           │                     │
 * │           │ 调用工具                   │ 被封装              │
 * │           ▼                           ▼                     │
 * │  ┌─────────────────────────────────────────────────────┐   │
 * │  │  Subagent (工具封装)                                 │   │
 * │  │  ┌───────────┐                                      │   │
 * │  │  │ SiteMiner │  ← SkillAgent + 独立 MCP Server      │   │
 * │  │  └───────────┘                                      │   │
 * │  └─────────────────────────────────────────────────────┘   │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 *
 * Key Design Principles:
 * 1. **ChatAgent** - For continuous conversation with streaming input/output
 * 2. **SkillAgent** - For single-shot task execution (input → output)
 * 3. **Subagent** - SkillAgent that can be encapsulated as a tool
 *
 * @module agents/types
 */

import type { AgentMessage } from '../types/agent.js';
import type { SdkInlineToolDefinition, SdkMcpServerConfig } from '@disclaude/core';
import type { FileRef } from '../file-transfer/types.js';

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
}

// ============================================================================
// SkillAgent Interface (技能型 Agent)
// ============================================================================

/**
 * SkillAgent - Single-shot task execution agent.
 *
 * Characteristics:
 * - Single task execution (input → output)
 * - No persistent session state (or limited state)
 * - Returns results and terminates
 *
 * Current implementations:
 * - `Evaluator` - Evaluates task completion
 * - `Executor` - Executes specific tasks
 * - `Reporter` - Generates user feedback reports
 *
 * @example
 * ```typescript
 * const skillAgent: SkillAgent = new Evaluator(config);
 *
 * // Execute single task
 * for await (const response of skillAgent.execute(taskInput)) {
 *   console.log(response.content);
 * }
 *
 * skillAgent.dispose();
 * ```
 */
export interface SkillAgent extends Disposable {
  /** Agent type identifier */
  readonly type: 'skill';

  /** Agent name for logging */
  readonly name: string;

  /**
   * Execute a single task and yield results.
   *
   * @param input - Task input as string or structured data
   * @yields AgentMessage responses
   */
  execute(input: string | UserInput[]): AsyncGenerator<AgentMessage>;
}

// ============================================================================
// Subagent Interface (工具封装型 Agent)
// ============================================================================

/**
 * Subagent - SkillAgent that can be encapsulated as a tool.
 *
 * Characteristics:
 * - Extends SkillAgent capabilities
 * - Can be exposed as an inline tool for other agents
 * - May have its own isolated MCP server
 * - Has distinct type identifier 'subagent'
 *
 * Current implementations:
 * - `SiteMiner` - Playwright-based site mining, exposed as tool
 *
 * @example
 * ```typescript
 * const subagent: Subagent = createSiteMiner();
 *
 * // Use as SkillAgent
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
export interface Subagent extends Omit<SkillAgent, 'type'> {
  /** Agent type identifier - subagent is a distinct type from skill */
  readonly type: 'subagent';

  /**
   * Get the agent's tool definition for use by other agents.
   *
   * Returns an InlineToolDefinition that can be added to an
   * inline MCP server, allowing other agents to invoke this
   * subagent as a tool.
   *
   * @returns Tool definition for MCP registration
   */
  asTool(): SdkInlineToolDefinition;

  /**
   * Get MCP server configuration for standalone execution.
   *
   * Returns configuration for running this subagent with its
   * own isolated MCP server (e.g., for context isolation).
   *
   * @returns MCP server configuration, or undefined if not applicable
   */
  getMcpServer(): SdkMcpServerConfig | undefined;
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
 * Type guard to check if an agent is a SkillAgent.
 */
export function isSkillAgent(agent: unknown): agent is SkillAgent {
  return (
    typeof agent === 'object' &&
    agent !== null &&
    'type' in agent &&
    (agent as { type: string }).type === 'skill'
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
 * Configuration for SkillAgent (Evaluator, Executor, Reporter).
 *
 * Extends BaseAgentConfig with optional agent-specific settings.
 *
 * @example
 * ```typescript
 * // Evaluator config
 * const evaluatorConfig: SkillAgentConfig = {
 *   apiKey: 'sk-...',
 *   model: 'claude-3-5-sonnet-20241022',
 *   provider: 'anthropic',
 *   subdirectory: 'regular',
 * };
 *
 * // Executor config
 * const executorConfig: SkillAgentConfig = {
 *   apiKey: 'sk-...',
 *   model: 'claude-3-5-sonnet-20241022',
 *   provider: 'anthropic',
 *   abortSignal: controller.signal,
 * };
 * ```
 */
export interface SkillAgentConfig extends BaseAgentConfig {
  /** Optional subdirectory for task files (Evaluator) */
  subdirectory?: string;
  /** Optional abort signal for cancellation (Executor) */
  abortSignal?: AbortSignal;
}

/**
 * Configuration for Subagent (SiteMiner).
 *
 * Subagents extend SkillAgent capabilities with tool encapsulation.
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
export interface SubagentConfig extends SkillAgentConfig {
  /** Default timeout for operations in milliseconds */
  defaultTimeout?: number;
}

// ============================================================================
// Agent Factory Types
// ============================================================================

/**
 * Configuration for creating agents.
 * @deprecated Use BaseAgentConfig, ChatAgentConfig, or SkillAgentConfig instead.
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

/**
 * Factory for creating Agent instances.
 *
 * Issue #711: Agent Lifecycle Management Strategy
 *
 * | Agent Type     | chatId Binding | Max Lifetime | Storage Location |
 * |----------------|----------------|--------------|------------------|
 * | ChatAgent      | ✅ Yes         | Unlimited    | AgentPool        |
 * | ScheduleAgent  | ❌ No          | 24 hours     | None (temporary) |
 * | TaskAgent      | ❌ No          | Task finish  | None (temporary) |
 * | SkillAgent     | ❌ No          | Task finish  | None (temporary) |
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
 * // Create SkillAgent
 * const evaluator = factory.createSkillAgent('evaluator');
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
   * Create a SkillAgent instance.
   * Short-lived, caller must dispose after execution.
   */
  createSkillAgent(name: string, ...args: unknown[]): Promise<SkillAgent>;

  /**
   * Create a Subagent instance.
   * Short-lived, caller must dispose after execution.
   */
  createSubagent(name: string, ...args: unknown[]): Subagent;
}
