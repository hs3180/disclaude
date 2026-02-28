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
import type { InlineToolDefinition, McpServerConfig } from '../sdk/types.js';

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
 * ```
 */
export interface ChatAgent {
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
   * Reset the agent session.
   * Clears conversation history and state.
   */
  reset(): void;

  /**
   * Cleanup resources.
   * Called when agent is no longer needed.
   */
  cleanup(): void;
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
 * skillAgent.cleanup();
 * ```
 */
export interface SkillAgent {
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

  /**
   * Cleanup resources.
   * Called when agent is no longer needed.
   */
  cleanup(): void;
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
export interface Subagent extends SkillAgent {
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
 */
export function isSubagent(agent: unknown): agent is Subagent {
  return (
    isSkillAgent(agent) &&
    'asTool' in agent &&
    typeof (agent as { asTool: unknown }).asTool === 'function'
  );
}

// ============================================================================
// Agent Factory Types
// ============================================================================

/**
 * Configuration for creating agents.
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
 * @example
 * ```typescript
 * const factory = new AgentFactory(config);
 *
 * // Create ChatAgent
 * const pilot = factory.createChatAgent('pilot', callbacks);
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
   */
  createChatAgent(name: string, ...args: unknown[]): ChatAgent;

  /**
   * Create a SkillAgent instance.
   */
  createSkillAgent(name: string, ...args: unknown[]): SkillAgent;

  /**
   * Create a Subagent instance.
   */
  createSubagent(name: string, ...args: unknown[]): Subagent;
}
