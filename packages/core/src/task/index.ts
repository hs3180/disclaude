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

// ETA Rules Updater (Issue #1234 Phase 2: ETA learning from task records)
export {
  EtaRulesUpdater,
  parseTimeToMinutes,
  extractRecordsFromMarkdown,
  analyzeTypePatterns,
} from './eta-rules-updater.js';
