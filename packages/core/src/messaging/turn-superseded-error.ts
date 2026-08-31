/**
 * Typed error signaling that an awaited agent turn was superseded by a
 * newer message pushed into the same session.
 *
 * ChatAgent's per-turn completion promise (`turnComplete`, Issue #4063) is
 * single-slot: pushing any new message rejects the still-pending promise of
 * the previous one. For awaiters (the Scheduler via `waitForCompletion`, the
 * Loop Runner) that rejection is NOT a task failure — the chat is
 * demonstrably alive and the newer message's turn runs in the old turn's
 * place — so it gets a dedicated error class instead of a plain `Error`,
 * letting consumers branch on `instanceof` rather than string-matching.
 *
 * Lives in core (not primary-node, where ChatAgent throws it) so the
 * Scheduler can instanceof-check it across the package boundary; both
 * sides import the same module instance in-process.
 *
 * Issue #4649 (review finding ①): introduced when the Scheduler started
 * awaiting turn outcomes — without it, every user message landing mid-turn
 * in a scheduled task's chat was recorded as a task failure (❌ spam +
 * false consecutive-failure alerts).
 */
export class TurnSupersededError extends Error {
  constructor() {
    // Message kept identical to the pre-typed plain Error for log-search
    // continuity with historical entries.
    super('Turn superseded by new message');
    this.name = 'TurnSupersededError';
  }
}
