/**
 * Queue module - Core queue utilities.
 *
 * This module provides:
 * - TaskQueue: Priority-based task queue with dependency resolution
 * - Types: Task interfaces and status types
 *
 * @module queue
 */

export { TaskQueue } from './task-queue.js';

export type {
  Task,
  BaseTaskOptions,
  TaskStatus,
  TaskPriority,
  TaskDependency,
  TaskResult,
} from './types.js';
