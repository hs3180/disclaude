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

// Research Files (Issue #1710)
export {
  ResearchFileManager,
  parseResearchMd,
  type ResearchState,
  type ResearchFinding,
  type ResearchResource,
  type ResearchFileManagerConfig,
} from './research-files.js';
