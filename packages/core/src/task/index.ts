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

// Task Context (Issue #857: Deep task progress reporting)
export type {
  TaskContext,
  TaskPhase,
  TaskMetrics,
  TaskStep,
  CreateTaskContextOptions,
  UpdateTaskContextOptions,
} from './task-context.js';

// Task Context Manager
export { TaskContextManager } from './task-context-manager.js';
