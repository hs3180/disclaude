/**
 * Task Module
 *
 * Provides task management utilities for worker nodes.
 *
 * @module task
 */

// Types
export type { TaskDefinitionDetails, TaskMessageType } from './types.js';

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

// Task Context (Issue #857: Independent Reporter Agent)
export {
  TaskContext,
  formatDuration,
  type TaskPhase,
  type TaskContextData,
  type TaskMilestone,
} from './task-context.js';

// Task Context Tools (Issue #857: MCP tool implementations)
export {
  getTaskStatus,
  updateTaskStatus,
  createTaskContext,
  type TaskContextToolsOptions,
  type GetTaskStatusInput,
  type UpdateTaskStatusInput,
} from './task-context-tools.js';
