/**
 * Task Module
 *
 * Provides task management utilities for worker nodes.
 *
 * @module task
 */

// Types
export type { TaskDefinitionDetails, TaskMessageType } from './types.js';

// Task Context (Issue #857: Shared state for progress tracking)
export {
  TaskContext,
  getTaskContext,
  initTaskContext,
  resetTaskContext,
} from './task-context.js';
export type {
  TaskProgress,
  TaskProgressStatus,
  TaskStep,
  RegisterTaskOptions,
  UpdateProgressOptions,
  TaskContextEventType,
  TaskContextEvent,
} from './task-context.js';

// Dialogue Message Tracker
export { DialogueMessageTracker } from './dialogue-message-tracker.js';

// Task Tracker
export { TaskTracker } from './task-tracker.js';

// Task Files
export { TaskFileManager, type TaskFileManagerConfig } from './task-files.js';
