/**
 * Loop Module — autonomous loop execution engine.
 *
 * Issue #4063 (Phase 0): Loop Runner runtime execution engine.
 *
 * The Loop Runner drives an Agent in a loop using a fixed prompt.
 * It is domain-agnostic and does not depend on any specific task format.
 *
 * @module @disclaude/core/loop
 */

// Core Runner
export { LoopRunner } from './loop-runner.js';

// State persistence utilities
export {
  readLoopState,
  writeLoopState,
  createInitialLoopState,
  beginStep,
  finishStep,
  checkTermination,
  LOOP_STATE_FILE,
} from './loop-state.js';

// Types
export type {
  LoopStartConfig,
  LoopState,
  StepFailureReason,
  LoopStepRecord,
  LoopStateFile,
  LoopStatusResult,
  LoopRunnerCallbacks,
  LoopRunnerOptions,
} from './loop-types.js';
