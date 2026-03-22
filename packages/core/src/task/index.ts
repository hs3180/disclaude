/**
 * Task Module
 *
 * Provides task management utilities for worker nodes.
 *
 * @module task
 */

// Types
export type { TaskDefinitionDetails, TaskMessageType } from './types.js';

// Task Context (Issue #857: Progress reporting)
export {
  TaskContext,
  type TaskContextInfo,
  type TaskStatus,
  type TaskPhase,
  type IterationInfo,
} from './task-context.js';

// Dialogue Message Tracker
export { DialogueMessageTracker } from './dialogue-message-tracker.js';

// Task Tracker
export { TaskTracker } from './task-tracker.js';

// Task Files
export { TaskFileManager, type TaskFileManagerConfig } from './task-files.js';

// Task File Watcher
export { TaskFileWatcher, type TaskFileWatcherOptions, type OnTaskCreated } from './task-file-watcher.js';

// Reflection Pattern
export {
  ReflectionController,
  TerminationConditions,
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionConfig,
  type ReflectionMetrics,
  type ReflectionEvent,
  type ReflectionEvaluationResult,
  type ReflectionContext,
  type ReflectionPhaseStatus,
  type ReflectionPhaseResult,
  type ReflectionPhaseMetrics,
  type ExecutePhaseExecutor,
  type EvaluatePhaseExecutor,
  type ReflectPhaseExecutor,
  type TerminationCondition,
} from './reflection.js';
