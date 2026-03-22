/**
 * Task Module
 *
 * Provides task management utilities for worker nodes.
 *
 * @module task
 *
 * NOTE: TaskFileWatcher and ReflectionController have been removed in Issue #1309.
 * Deep Task execution is now handled via schedule-based approach.
 * @see examples/schedules/deep-task.example.md
 */

// Types
export type { TaskDefinitionDetails, TaskMessageType } from './types.js';

// Dialogue Message Tracker
export { DialogueMessageTracker } from './dialogue-message-tracker.js';

// Task Tracker
export { TaskTracker } from './task-tracker.js';

// Task Files
export { TaskFileManager, type TaskFileManagerConfig } from './task-files.js';
