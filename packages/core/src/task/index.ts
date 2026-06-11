/**
 * Task Module
 *
 * Provides task management utilities for worker nodes.
 *
 * @module task
 */

// Dialogue Message Tracker
export { DialogueMessageTracker } from './dialogue-message-tracker.js';

// Task Tracker
export { TaskTracker } from './task-tracker.js';

// LOOP.md Parser (Issue #4039)
export {
  parseLoopMd,
  readLoopMd,
  writeLoopMd,
  serializeLoopMd,
  findNextPending,
  isAllDone,
  countByStatus,
  parseDuration,
} from './loop-parser.js';

export type {
  TodoItemStatus,
  TodoItem,
  LoopConfig,
  LoopFile,
} from './loop-parser.js';
