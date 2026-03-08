/**
 * Worker Agent Types - Interfaces for Master-Workers multi-agent collaboration.
 *
 * This module implements Phase 1 of Issue #897:
 * - Worker Agent interface
 * - Task definition types
 * - Worker Pool configuration
 *
 * Architecture:
 *
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    Master-Workers Pattern                    │
 * ├─────────────────────────────────────────────────────────────┤
 * │                                                             │
 * │   ┌─────────────────┐                                      │
 * │   │  Master Agent   │                                      │
 * │   │    (Pilot)      │                                      │
 * │   └────────┬────────┘                                      │
 * │            │                                               │
 * │            ▼                                               │
 * │   ┌─────────────────┐                                      │
 * │   │   WorkerPool    │                                      │
 * │   │                 │                                      │
 * │   │  ┌───┐ ┌───┐    │                                      │
 * │   │  │ W │ │ W │    │  Workers (SkillAgents)               │
 * │   │  └───┘ └───┘    │                                      │
 * │   └────────┬────────┘                                      │
 * │            │                                               │
 * │            ▼                                               │
 * │   ┌─────────────────┐                                      │
 * │   │  Aggregated     │                                      │
 * │   │    Result       │                                      │
 * │   └─────────────────┘                                      │
 * │                                                             │
 * └─────────────────────────────────────────────────────────────┘
 *
 * @module agents/worker-types
 */

import type { SkillAgent as SkillAgentInterface } from './types.js';
import type { AgentMessage } from '../types/agent.js';

// ============================================================================
// Task Types
// ============================================================================

/**
 * Status of a subtask.
 */
export type SubTaskStatus = 'pending' | 'running' | 'completed' | 'failed';

/**
 * Priority levels for tasks.
 */
export type TaskPriority = 'low' | 'normal' | 'high';

/**
 * A subtask that can be dispatched to a worker.
 */
export interface SubTask {
  /** Unique identifier for the task */
  id: string;
  /** Task description/prompt */
  prompt: string;
  /** Task priority (affects dispatch order) */
  priority?: TaskPriority;
  /** IDs of tasks that must complete before this one can start */
  dependencies?: string[];
  /** Optional metadata for context */
  metadata?: Record<string, unknown>;
  /** Current status */
  status?: SubTaskStatus;
}

/**
 * Result from a worker executing a task.
 */
export interface TaskResult {
  /** ID of the task that was executed */
  taskId: string;
  /** ID of the worker that executed the task */
  workerId: string;
  /** Whether the task completed successfully */
  success: boolean;
  /** Result content (if successful) */
  content?: string;
  /** Error message (if failed) */
  error?: string;
  /** Execution time in milliseconds */
  elapsedMs: number;
  /** Agent messages from execution */
  messages?: AgentMessage[];
}

/**
 * Handle for tracking a dispatched task.
 */
export interface TaskHandle {
  /** Task ID */
  taskId: string;
  /** Worker ID assigned to the task */
  workerId: string;
  /** Promise that resolves when the task completes */
  result: Promise<TaskResult>;
}

// ============================================================================
// Worker Types
// ============================================================================

/**
 * Status of a worker.
 */
export type WorkerStatus = 'idle' | 'busy' | 'disposed';

/**
 * A worker that can execute tasks.
 *
 * Workers wrap SkillAgent instances and track their status.
 */
export interface Worker {
  /** Unique identifier for the worker */
  id: string;
  /** Worker type/name (e.g., 'general', 'specialized') */
  type: string;
  /** Current status */
  status: WorkerStatus;
  /** The underlying SkillAgent */
  agent: SkillAgentInterface;
  /** ID of the task currently being executed (if busy) */
  currentTaskId?: string;
}

/**
 * Options for creating a worker.
 */
export interface WorkerOptions {
  /** Worker type/name */
  type?: string;
  /** Custom configuration */
  config?: Record<string, unknown>;
}

// ============================================================================
// Worker Pool Types
// ============================================================================

/**
 * Configuration for WorkerPool.
 */
export interface WorkerPoolConfig {
  /** Maximum number of workers in the pool */
  maxWorkers?: number;
  /** Maximum concurrent tasks (default: equals maxWorkers) */
  maxConcurrent?: number;
  /** Task timeout in milliseconds (default: 300000 = 5 minutes) */
  taskTimeout?: number;
  /** Whether to auto-dispose workers after task completion */
  autoDispose?: boolean;
}

/**
 * Statistics about the worker pool.
 */
export interface WorkerPoolStats {
  /** Total number of workers */
  totalWorkers: number;
  /** Number of idle workers */
  idleWorkers: number;
  /** Number of busy workers */
  busyWorkers: number;
  /** Number of pending tasks in queue */
  pendingTasks: number;
  /** Number of completed tasks */
  completedTasks: number;
  /** Number of failed tasks */
  failedTasks: number;
}

/**
 * Callback for task completion events.
 */
export type TaskCompletionCallback = (result: TaskResult) => void;

/**
 * Callback for worker status changes.
 */
export type WorkerStatusCallback = (workerId: string, status: WorkerStatus) => void;

// ============================================================================
// Task Dispatcher Types
// ============================================================================

/**
 * Strategy for dispatching tasks to workers.
 */
export type DispatchStrategy = 'fifo' | 'priority' | 'round-robin';

/**
 * Configuration for TaskDispatcher.
 */
export interface TaskDispatcherConfig {
  /** Dispatch strategy */
  strategy?: DispatchStrategy;
  /** Maximum retries for failed tasks */
  maxRetries?: number;
  /** Callback when task completes */
  onTaskComplete?: TaskCompletionCallback;
  /** Callback when worker status changes */
  onWorkerStatusChange?: WorkerStatusCallback;
}
