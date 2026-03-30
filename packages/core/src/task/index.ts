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
  TaskType,
  TaskRecord,
} from './types.js';

// Dialogue Message Tracker
export { DialogueMessageTracker } from './dialogue-message-tracker.js';

// Task Tracker
export { TaskTracker } from './task-tracker.js';

// Task Files
export { TaskFileManager, type TaskFileManagerConfig } from './task-files.js';

// Task Record Manager (ETA tracking)
export { TaskRecordManager, type ParsedTaskRecord } from './task-record-manager.js';

// ETA Rules Manager
export { ETARulesManager } from './eta-rules-manager.js';
