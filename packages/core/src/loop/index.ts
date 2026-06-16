/**
 * Loop module — types, state persistence, and constants for Loop Runner.
 *
 * @see Issue #4063
 * @module loop
 */

// Types
export {
  LoopState,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_DURATION_MS,
  DEFAULT_STEP_DELAY_MS,
  LOOP_STATE_FILE,
} from './loop-types.js';

export type {
  LoopStartParams,
  LoopPersistedState,
  LoopStatus,
} from './loop-types.js';

// State persistence
export {
  getLoopStatePath,
  readLoopState,
  writeLoopState,
  createLoopState,
  toLoopStatus,
} from './loop-state.js';

export type { LoopStateReadResult } from './loop-state.js';
