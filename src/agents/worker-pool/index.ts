/**
 * Worker Pool Module - Master-Workers multi-agent collaboration.
 *
 * Issue #897: Support master-workers multi-agent collaboration pattern.
 *
 * This module provides the infrastructure for parallel task execution
 * using a pool of worker agents:
 *
 * - **TaskQueue**: Priority-based task queue with dependency resolution
 * - **WorkerPool**: Worker management and task distribution
 *
 * ## Architecture
 *
 * ```
 *                    ┌─────────────────┐
 *                    │   User Input    │
 *                    └────────┬────────┘
 *                             │
 *                             ▼
 *                    ┌─────────────────┐
 *                    │  Worker Pool    │
 *                    │  (Manager)      │
 *                    └────────┬────────┘
 *                             │
 *              ┌──────────────┼──────────────┐
 *              │              │              │
 *              ▼              ▼              ▼
 *        ┌──────────┐  ┌──────────┐  ┌──────────┐
 *        │ Worker 1 │  │ Worker 2 │  │ Worker 3 │
 *        │ (Agent)  │  │ (Agent)  │  │ (Agent)  │
 *        └──────────┘  └──────────┘  └──────────┘
 *              │              │              │
 *              └──────────────┼──────────────┘
 *                             │
 *                             ▼
 *                    ┌─────────────────┐
 *                    │  Aggregated     │
 *                    │    Result       │
 *                    └─────────────────┘
 * ```
 *
 * ## Usage
 *
 * ```typescript
 * import { WorkerPool, TaskQueue } from './agents/worker-pool';
 *
 * // Create worker pool
 * const pool = new WorkerPool({
 *   maxWorkers: 3,
 *   callbacks: {
 *     sendMessage: async (chatId, text) => { ... },
 *   },
 * }, callbacks);
 *
 * // Submit tasks
 * const results = await pool.executeBatch([
 *   { id: 'task-1', name: 'Task 1', prompt: '...', chatId, callbacks },
 *   { id: 'task-2', name: 'Task 2', prompt: '...', chatId, callbacks },
 * ]);
 *
 * // Cleanup
 * pool.dispose();
 * ```
 *
 * @module agents/worker-pool
 */

// Types
export type {
  // Task types
  TaskStatus,
  TaskPriority,
  TaskDependency,
  TaskOptions,
  TaskResult,
  Task,

  // Worker types
  WorkerStatus,
  WorkerType,
  WorkerOptions,
  WorkerStats,
  WorkerHandle,

  // Pool configuration
  WorkerPoolConfig,
  ExecuteOptions,
  BatchResult,

  // Events
  WorkerPoolEventType,
  WorkerPoolEvent,
  WorkerPoolEventCallback,
} from './types.js';

// Components
export { TaskQueue } from './task-queue.js';
export { WorkerPool } from './worker-pool.js';
