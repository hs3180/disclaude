/**
 * @disclaude/voice-orchestrator — public surface (MVP foundation).
 *
 * M0 ships the intent snapshot store + state machine + lifecycle. M1
 * (background intent daemon) and M2 (FREEZE + single-agent loop) build on top.
 */

export { IntentSnapshotStore } from './store.js';
export type { IntentSnapshotStoreOptions } from './store.js';
export {
  InvalidTransitionError,
  assertAllowed,
  isAllowed,
} from './state-machine.js';
export type { SnapshotEvent } from './state-machine.js';
export type {
  AgentResult,
  Canonical,
  Candidate,
  Draft,
  IntentFields,
  IntentSnapshot,
  ResultStatus,
  SnapshotPhase,
} from './types.js';
