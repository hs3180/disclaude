/**
 * Worker Agent Module - Master-Workers Collaboration Pattern (Issue #897).
 *
 * This module provides the infrastructure for parallel task execution
 * using a pool of worker agents.
 *
 * Architecture:
 * ```
 *                     ┌─────────────────┐
 *                     │   User Input    │
 *                     └────────┬────────┘
 *                              │
 *                              ▼
 *                     ┌─────────────────┐
 *                     │  Master Agent   │
 *                     │    (Pilot)      │
 *                     └────────┬────────┘
 *                              │
 *               ┌──────────────┼──────────────┐
 *               │              │              │
 *               ▼              ▼              ▼
 *         ┌──────────┐  ┌──────────┐  ┌──────────┐
 *         │ Worker 1 │  │ Worker 2 │  │ Worker 3 │
 *         │ (Agent)  │  │ (Agent)  │  │ (Agent)  │
 *         └──────────┘  └──────────┘  └──────────┘
 *               │              │              │
 *               └──────────────┼──────────────┘
 *                              │
 *                              ▼
 *                     ┌─────────────────┐
 *                     │  Aggregated     │
 *                     │    Result       │
 *                     └─────────────────┘
 * ```
 *
 * Components:
 * - **types**: Type definitions for workers, tasks, and pools
 * - **TaskQueue**: Priority-based task queue
 * - **WorkerPool**: Manages a pool of worker agents
 * - **TaskDispatcher**: Coordinates task execution
 * - **ResultAggregator**: Combines results from multiple tasks
 * - **SimpleWorker**: Basic worker implementation
 *
 * @example
 * ```typescript
 * import { WorkerPool, TaskDispatcher, SimpleWorker, ResultAggregator } from './agents/worker';
 *
 * // Create a worker pool
 * const pool = new WorkerPool({
 *   workerFactory: (id) => new SimpleWorker({
 *     id,
 *     executor: async (task) => `Processed: ${task.input}`,
 *   }),
 *   maxWorkers: 5,
 * });
 *
 * // Create a dispatcher
 * const dispatcher = new TaskDispatcher({ pool });
 *
 * // Dispatch tasks
 * const tasks = [
 *   { id: '1', input: 'task1' },
 *   { id: '2', input: 'task2' },
 * ];
 *
 * const handles = dispatcher.dispatchAll(tasks);
 * const results = await dispatcher.waitForAll(handles);
 *
 * // Aggregate results
 * const aggregator = new ResultAggregator({ strategy: 'concat' });
 * const aggregated = aggregator.aggregate(results);
 *
 * // Cleanup
 * dispatcher.dispose();
 * pool.dispose();
 * ```
 *
 * @module agents/worker
 */

// Type definitions
export {
  // Task types
  type SubTask,
  type SubTaskStatus,
  type TaskPriority,
  type TaskHandle,
  type TaskResult,
  // Worker types
  type WorkerStatus,
  type WorkerCapabilities,
  type WorkerStats,
  type WorkerAgent,
  type WorkerFactory,
  // Pool types
  type WorkerPoolConfig,
  type WorkerPool as WorkerPoolInterface,
  // Queue types
  type TaskQueueConfig,
  type TaskQueue as TaskQueueInterface,
  // Dispatcher types
  type TaskDispatcherConfig,
  type TaskDispatcher as TaskDispatcherInterface,
  // Aggregator types
  type AggregationStrategy,
  type ResultAggregatorConfig,
  type ResultAggregator as ResultAggregatorInterface,
  // Type guards
  isWorkerAgent,
  isWorkerPool,
  isTaskQueue,
  isTaskDispatcher,
} from './types.js';

// Implementations
export { TaskQueue } from './task-queue.js';
export { WorkerPool } from './worker-pool.js';
export { TaskDispatcher } from './task-dispatcher.js';
export { ResultAggregator } from './result-aggregator.js';
export { SimpleWorker, type SimpleWorkerConfig, type TaskExecutor } from './simple-worker.js';
