/**
 * Coordination domain barrel.
 *
 * Feature work adds new task-coordination exports here, not to the package
 * root — the root only re-exports this module wholesale, so stacked PRs stop
 * colliding on a shared hand-enumerated list (see index.ts).
 */
export { TaskClaimStore, TaskClaimConflictError } from './task-claim-store.js';
export { TaskResultOutbox } from './task-result-outbox.js';
export { readProjectArtifact } from './project-artifact.js';
export { TaskAdmissionStore } from './task-admission-store.js';
// Durable task submission/review history with byte-verified approvals.
export { TaskReviewStore, TaskReviewConflictError } from './task-review-store.js';
// Task-bound public question/answer delivery state (#5584).
export { TaskQuestionStore } from './task-question-store.js';
