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

// Task Status (Issue #857: progress reporting foundation)
export {
  TaskStatusProvider,
  TaskState,
  type DialogueTaskStatus,
  type DialogueTaskSummary,
  type DialogueIterationStatus,
} from './task-status.js';
