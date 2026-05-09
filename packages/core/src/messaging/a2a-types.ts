/**
 * A2A (Agent-to-Agent) Messaging Types.
 *
 * Enables ChatAgents to delegate tasks to project-bound agents.
 *
 * Issue #3334: A2A messaging — Agent-to-Agent task delegation.
 *
 * Architecture:
 * ```
 * Agent A (chatId: oc_111) calls enqueue_task({ projectKey: 'repo-B', payload })
 *   → A2AQueue enqueues task
 *   → Target Agent B (chatId: oc_222) receives task
 *   → Agent B processes and replies to its bound chat
 * ```
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// A2A Task
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Priority levels for A2A tasks.
 */
export type A2APriority = 'low' | 'normal' | 'high';

/**
 * Status of an A2A task in its lifecycle.
 */
export type A2ATaskStatus = 'pending' | 'delivered' | 'failed';

/**
 * An A2A task represents a unit of work delegated from one agent to another.
 */
export interface A2ATask {
  /** Unique task identifier */
  id: string;
  /** Source chatId (the agent that created this task) */
  sourceChatId: string;
  /** Target project key (resolves to target agent's chatId) */
  projectKey: string;
  /** Task instruction payload */
  payload: string;
  /** Priority level */
  priority: A2APriority;
  /** Current status */
  status: A2ATaskStatus;
  /** ISO 8601 creation timestamp */
  createdAt: string;
  /** Target chatId (resolved at enqueue time) */
  targetChatId?: string;
  /** Error message if status is 'failed' */
  error?: string;
}

/**
 * Parameters for the enqueue_task tool.
 */
export interface EnqueueTaskParams {
  /** Target project key */
  projectKey: string;
  /** Task instruction payload */
  payload: string;
  /** Priority level (default: 'normal') */
  priority?: A2APriority;
}

/**
 * Result of an enqueue_task call.
 */
export interface EnqueueTaskResult {
  /** Whether the enqueue was successful */
  success: boolean;
  /** Human-readable message */
  message: string;
  /** The task ID (if successful) */
  taskId?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rate Limiting
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Configuration for A2A rate limiting.
 */
export interface A2ARateLimitConfig {
  /** Maximum number of A2A tasks per source chatId within the window */
  maxTasks: number;
  /** Time window in milliseconds */
  windowMs: number;
}

/**
 * Default rate limit configuration.
 */
export const DEFAULT_A2A_RATE_LIMIT: A2ARateLimitConfig = {
  maxTasks: 10,
  windowMs: 60_000, // 1 minute
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Project Resolver
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Resolves a projectKey to a target chatId.
 *
 * This interface decouples the A2A queue from ProjectManager,
 * allowing easy testing and future integration with PR #3440.
 */
export interface A2AProjectResolver {
  /**
   * Resolve a projectKey to a chatId.
   *
   * @param projectKey - The project key to resolve
   * @returns The chatId bound to this project, or undefined if not found
   */
  resolve(projectKey: string): string | undefined;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Agent Pool
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Minimal agent pool interface for A2A task delivery.
 *
 * Decoupled from the real AgentPool for testability.
 */
export interface A2AAgentPool {
  /**
   * Check if an agent exists for the given chatId.
   */
  has(chatId: string): boolean;

  /**
   * Get the chatId of the agent bound to a source chatId.
   * Used for anti-recursion checks.
   */
  getAgentProjectKey(chatId: string): string | undefined;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Type Guards
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Check if a priority value is valid.
 */
export function isValidA2APriority(value: string): value is A2APriority {
  return value === 'low' || value === 'normal' || value === 'high';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let taskCounter = 0;

/**
 * Generate a unique task ID.
 */
export function generateTaskId(): string {
  taskCounter++;
  return `a2a-${Date.now()}-${taskCounter}`;
}
