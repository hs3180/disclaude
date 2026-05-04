/**
 * Task Module
 *
 * Provides task management utilities for worker nodes.
 *
 * @module task
 */

// Types
export type {
  TaskDefinitionDetails,
  TaskMessageType,
  TaskContext,
  TaskContextStatus,
  CreateTaskContextOptions,
  UpdateTaskContextOptions,
} from './types.js';

// Dialogue Message Tracker
export { DialogueMessageTracker } from './dialogue-message-tracker.js';

// Task Tracker
export { TaskTracker } from './task-tracker.js';

// Task Files
export { TaskFileManager, type TaskFileManagerConfig } from './task-files.js';

// Task Context (Issue #857: Independent Reporter Agent)
export { TaskContextStore } from './task-context.js';
