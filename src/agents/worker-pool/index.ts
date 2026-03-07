/**
 * Worker Pool Module - Master-Workers Multi-Agent Collaboration.
 *
 * This module implements Phase 1 of Issue #897:
 * - Worker Agent interface
 * - Worker Pool management
 * - Task queue and dispatcher
 *
 * @example
 * ```typescript
 * import {
 *   WorkerPool,
 *   TaskDispatcher,
 *   SkillWorkerAgent,
 *   type SubTask,
 * } from './agents/worker-pool/index.js';
 *
 * // Create worker pool
 * const pool = new WorkerPool({
 *   maxWorkers: 5,
 *   workerFactory: (config) => new SkillWorkerAgent(config, skillAgentFactory),
 * });
 *
 * // Create dispatcher
 * const dispatcher = new TaskDispatcher({
 *   workerPool: pool,
 *   maxParallel: 3,
 * });
 *
 * // Submit tasks
 * const tasks: SubTask[] = [
 *   { id: '1', description: 'Task 1', input: 'Process file A' },
 *   { id: '2', description: 'Task 2', input: 'Process file B' },
 * ];
 *
 * const handles = dispatcher.submitAll(tasks);
 * const results = await dispatcher.waitForAll();
 *
 * // Cleanup
 * dispatcher.dispose();
 * pool.dispose();
 * ```
 *
 * @module agents/worker-pool
 */

// Types
export type {
  // SubTask types
  TaskPriority,
  TaskStatus,
  SubTask,
  SubTaskResult,
  TaskHandle,
  // Worker types
  WorkerStatus,
  WorkerConfig,
  WorkerStats,
  WorkerAgent,
  WorkerFactory,
  // Pool types
  WorkerPoolConfig,
  WorkerPoolStats,
  WorkerPool as WorkerPoolInterface,
  // Dispatcher types
  TaskDispatcherConfig,
  TaskDispatcher as TaskDispatcherInterface,
  // Aggregation types
  AggregationStrategy,
  AggregationOptions,
  AggregatedResult,
} from './types.js';

// Implementations
export { WorkerPool } from './worker-pool.js';
export { TaskDispatcher } from './task-dispatcher.js';
export { SkillWorkerAgent, type SkillAgentFactory } from './skill-worker-agent.js';
