/**
 * Coordination domain barrel.
 *
 * Feature work adds new task-coordination exports here, not to the package
 * root — the root only re-exports this module wholesale, so stacked PRs stop
 * colliding on a shared hand-enumerated list (see index.ts).
 */

export { TaskClaimStore, TaskClaimConflictError } from './task-claim-store.js';
export type { TaskClaimSnapshot, TaskClaimLease } from './task-claim-store.js';

export { TaskResultOutbox, type TaskCompletionReport, type TaskResultRecord } from './task-result-outbox.js';
export { readProjectArtifact, type ProjectArtifactIdentity } from './project-artifact.js';
export { TaskAdmissionStore, type TaskAdmissionIntent } from './task-admission-store.js';
