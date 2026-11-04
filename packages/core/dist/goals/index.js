/**
 * Goal domain barrel.
 *
 * Feature work adds new goal exports here, not to the package root — the root
 * only re-exports this module wholesale, so stacked PRs stop colliding on a
 * shared hand-enumerated list (see index.ts).
 */
// Goal execution scheduling primitive; persistence/native admission remain adapters.
export { GoalLoop } from './goal-loop.js';
// Composes explicit controls with settled turn execution.
export { GoalController } from './goal-controller.js';
// Explicit, durable goal records; execution/control is wired separately.
export { GoalStore, GoalRevisionConflictError } from './goal-store.js';
