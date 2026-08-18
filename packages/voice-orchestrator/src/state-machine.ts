/**
 * Voice Orchestrator — pure intent-snapshot state machine.
 *
 * Phase model (design v0.2 §2-3):
 *   drafting → candidate → frozen → delivered
 *
 * FREEZE (candidate → frozen) is the SINGLE freeze point: it may only fire
 * once per session. Once frozen, the intent is immutable; only results
 * accumulate in their own region until delivery.
 *
 * The store delegates transitions here so the machine is unit-testable in
 * isolation from persistence.
 */

import type { SnapshotPhase } from './types.js';

/** Lifecycle events that drive phase transitions. */
export type SnapshotEvent =
  | 'appendDraft' // drafting → drafting (background stream keeps writing)
  | 'promoteCandidate' // drafting|candidate → candidate (consolidate at turn boundary)
  | 'freeze' // candidate → frozen (the single freeze point)
  | 'appendResult' // frozen → frozen (agent writes to results region)
  | 'markDelivered'; // frozen → delivered (terminal)

/** Legal events for each phase. */
const LEGAL: Record<SnapshotPhase, ReadonlySet<SnapshotEvent>> = {
  // While drafting, the background stream appends drafts and may consolidate
  // into a candidate at a turn boundary.
  drafting: new Set<SnapshotEvent>(['appendDraft', 'promoteCandidate']),
  // A candidate may be re-consolidated (new drafts folded in upstream) or frozen.
  candidate: new Set<SnapshotEvent>(['promoteCandidate', 'freeze']),
  // Once frozen, the intent is immutable: only results accumulate until delivery.
  frozen: new Set<SnapshotEvent>(['appendResult', 'markDelivered']),
  // Terminal for this snapshot; a new turn opens a fresh session.
  delivered: new Set<SnapshotEvent>(),
};

/** Thrown when an event is not legal in the current phase. */
export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: SnapshotPhase,
    public readonly event: SnapshotEvent,
  ) {
    super(`Invalid snapshot transition: event "${event}" not allowed in phase "${from}"`);
    this.name = 'InvalidTransitionError';
  }
}

/** True iff `event` is legal in `from`. */
export function isAllowed(from: SnapshotPhase, event: SnapshotEvent): boolean {
  return LEGAL[from].has(event);
}

/** Assert an event is legal in `from`, else throw InvalidTransitionError. */
export function assertAllowed(from: SnapshotPhase, event: SnapshotEvent): void {
  if (!isAllowed(from, event)) {
    throw new InvalidTransitionError(from, event);
  }
}
