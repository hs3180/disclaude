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

// Task Records (Issue #1234 - ETA Estimation Phase 1)
export {
  TaskRecordKeeper,
  type TaskRecordInput,
  type ParsedTaskRecord,
  type TaskRecordSearchOptions,
} from './task-records.js';
