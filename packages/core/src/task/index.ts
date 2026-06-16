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

// Loop Types
export type {
  LoopRunState,
  LoopStepRecord,
  LoopState,
  StepResult,
} from './loop-types.js';
export { LOOP_DEFAULTS, LOOP_STATE_FILE, TERMINAL_STATES } from './loop-types.js';

// Loop State
export {
  getStateFilePath,
  createInitialState,
  readLoopState,
  writeLoopState,
  startLoop,
  recordStep,
  terminateLoop,
  checkTermination,
  LoopStateCorruptedError,
} from './loop-state.js';
