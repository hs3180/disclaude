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

// Task Context (Issue #857: Foundation for progress reporting)
export { TaskContext, type TaskContextInfo, type TaskContextStatus, type TaskSummary, type IterationPhase } from './task-context.js';

// Task History (Issue #857: Task execution history for ETA estimation)
export { TaskHistory, type TaskHistoryEntry, type TaskHistoryStats, type TaskHistoryQueryOptions } from './task-history.js';
