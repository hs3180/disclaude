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
  IterationSnapshot,
  IterationStatus,
  TaskStatus,
} from './types.js';

// Dialogue Message Tracker
export { DialogueMessageTracker } from './dialogue-message-tracker.js';

// Task Tracker
export { TaskTracker } from './task-tracker.js';

// Task Files
export { TaskFileManager, type TaskFileManagerConfig } from './task-files.js';

// Task Context Reader (Issue #857)
export { TaskContextReader } from './task-context-reader.js';
