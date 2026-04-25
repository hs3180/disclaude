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

// Task Records (Issue #1234: ETA estimation Phase 1)
export { TaskRecords, type TaskRecordEntry, type ParsedTaskRecord, type TaskRecordsConfig } from './task-records.js';
