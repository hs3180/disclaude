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

// Task Context (Issue #857: runtime state tracking for progress reporting)
export { TaskContext, type TaskContextStatus, type TaskStep, type TaskProgressSnapshot } from './task-context.js';

// Task History (Issue #857: records completed task metrics for learning)
export { TaskHistory, type TaskHistoryEntry, type TaskHistorySummary } from './task-history.js';
