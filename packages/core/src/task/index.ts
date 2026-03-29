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

// ETA Files
export {
  getTaskRecordsPath,
  getEtaRulesPath,
  getClaudeDir,
  ensureEtaFiles,
  readTaskRecords,
  readEtaRules,
  appendTaskRecord,
  updateEtaRules,
} from './eta-files.js';
