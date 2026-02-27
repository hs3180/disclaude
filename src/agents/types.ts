/**
 * Agent Types - Type definitions for agent classification.
 *
 * This module defines the three main agent categories:
 * - ChatAgent: Conversational agents (Pilot)
 * - TaskAgent: Task-oriented agents (Evaluator, Executor, Reporter)
 * - ToolAgent: Tool-specific agents (SiteMiner)
 *
 * Design principle: "Composition over inheritance"
 * These types provide classification and documentation, not a new inheritance hierarchy.
 *
 * @module agents/types
 */

/**
 * Agent category classification.
 */
export type AgentCategory = 'chat' | 'task' | 'tool';

/**
 * Base interface for all agent types.
 */
export interface AgentType {
  /** Agent category */
  readonly category: AgentCategory;
  /** Agent name for logging */
  readonly name: string;
}

/**
 * Chat agent - handles conversational interactions.
 *
 * Characteristics:
 * - Streaming input mode
 * - Persistent sessions
 * - Platform-specific callbacks
 *
 * Example: Pilot
 */
export interface ChatAgentType extends AgentType {
  readonly category: 'chat';
}

/**
 * Task agent role types.
 */
export type TaskAgentRole = 'evaluator' | 'executor' | 'reporter';

/**
 * Task agent - handles task execution workflow.
 *
 * Characteristics:
 * - Task evaluation and execution
 * - File-based communication
 * - Progress event streaming
 *
 * Examples: Evaluator, Executor, Reporter
 */
export interface TaskAgentType extends AgentType {
  readonly category: 'task';
  /** Task-specific role */
  readonly role: TaskAgentRole;
}

/**
 * Tool agent - handles specific tool operations.
 *
 * Characteristics:
 * - Focused on single tool/domain
 * - Isolated context
 * - Structured output
 *
 * Example: SiteMiner
 */
export interface ToolAgentType extends AgentType {
  readonly category: 'tool';
  /** Tool/domain this agent handles */
  readonly domain: string;
}

/**
 * Lifecycle phases for agents.
 */
export type AgentLifecyclePhase = 'created' | 'initializing' | 'ready' | 'active' | 'cleanup' | 'disposed';

/**
 * Lifecycle event for agent state changes.
 */
export interface AgentLifecycleEvent {
  /** Agent name */
  agentName: string;
  /** Previous phase */
  previousPhase: AgentLifecyclePhase;
  /** Current phase */
  currentPhase: AgentLifecyclePhase;
  /** Timestamp */
  timestamp: Date;
  /** Optional error if transition failed */
  error?: Error;
}

/**
 * Lifecycle observer callback.
 */
export type LifecycleObserver = (event: AgentLifecycleEvent) => void;

// ============================================================================
// Agent Type Guards
// ============================================================================

/**
 * Type guard to check if an agent is a ChatAgent.
 */
export function isChatAgent(agent: AgentType): agent is ChatAgentType {
  return agent.category === 'chat';
}

/**
 * Type guard to check if an agent is a TaskAgent.
 */
export function isTaskAgent(agent: AgentType): agent is TaskAgentType {
  return agent.category === 'task';
}

/**
 * Type guard to check if an agent is a ToolAgent.
 */
export function isToolAgent(agent: AgentType): agent is ToolAgentType {
  return agent.category === 'tool';
}
