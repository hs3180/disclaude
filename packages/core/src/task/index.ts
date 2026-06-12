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
  LoopConfig,
  LoopStepRecord,
  LoopState,
  LoopStartParams,
  LoopStartResult,
  LoopStopParams,
  LoopStatusParams,
  LoopStatusResult,
  LoopIpcRequest,
  StepResult,
} from './loop-types.js';
export { LOOP_DEFAULTS, LOOP_STATE_FILE, TERMINAL_STATES } from './loop-types.js';

// Loop State
export {
  parseDuration,
  getStateFilePath,
  createInitialState,
  readLoopState,
  readLoopStateSync,
  writeLoopState,
  writeLoopStateSync,
  startLoop,
  recordStep,
  terminateLoop,
  checkTermination,
  getStepCounts,
  LoopStateCorruptedError,
} from './loop-state.js';

// Loop Runner
export { LoopRunner, type PushToAgentFn, type PushToAgentResult } from './loop-runner.js';
