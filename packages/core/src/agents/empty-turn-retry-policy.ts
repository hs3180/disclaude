/**
 * EmptyTurnRetryPolicy — eligibility + bounding for empty-turn session-reset retry.
 *
 * Issue #4391 (#4194 follow-up ②): when a real-user turn produces no output,
 * the (deferred) mechanism will reset the ChatAgent session and replay the
 * user's input **exactly once**. This module captures the two hard constraints
 * that mechanism must honor, extracted as a pure, unit-testable policy:
 *
 * 1. **Synthetic messages are never retried.** Scheduled-task (`sched-*`) and
 *    other synthetic messages (`push_*`, `cli-*`, `msg-*`, …) are not valid
 *    Feishu `open_message_id`s — replaying them would hit the same reply-root
 *    400 that #4259 fixed. The check reuses the live synthetic-ID registry in
 *    `utils/message-id.ts` (the `isSyntheticMessageId` helper, #4166) so any
 *    new synthetic form is covered automatically — no drift.
 *
 * 2. **Retry is bounded to exactly 1 per chat (cannot loop).** `markRetried()`
 *    records that a retry was attempted; `canRetry()` returns false afterward
 *    until `reset()` (called on a successful turn). Reuses the existing
 *    `restartManager` circuit philosophy (bounded, not a parallel counter) but
 *    is intentionally a separate, focused policy so the empty-turn rule can be
 *    reviewed and tested in isolation.
 *
 * No caller wires this yet — the reset/replay mechanism is the larger
 * session-lifecycle follow-up (#4391, deferred as "needs design"). This policy
 * is the prerequisite: it locks the eligibility + bounding contract.
 */

import { isSyntheticMessageId } from '../utils/message-id.js';

/**
 * Per-chat policy for empty-turn retry eligibility + bounding.
 *
 * @see #4391, #4194, #4259, #4166
 */
export class EmptyTurnRetryPolicy {
  /** chatIds that have already used their one retry in the current window. */
  private readonly retriedChats = new Set<string>();

  /**
   * Whether an empty turn on the given message is ELIGIBLE for retry at all
   * (independent of whether this chat has already used its one retry).
   *
   * @param openMessageId - the message's open_message_id (synthetic IDs are
   *   detected via `isSyntheticMessageId`)
   * @param isEmptyTurn - whether the turn produced no user-visible output and
   *   no tool calls
   * @returns false for non-empty turns and for synthetic messages; true otherwise
   */
  isEligible(openMessageId: string, isEmptyTurn: boolean): boolean {
    if (!isEmptyTurn) {
      return false;
    }
    // Synthetic messages (sched-*, push_*, cli-*, msg-*, …) are not valid reply
    // roots — replaying would 400. Reuses the live registry (#4166).
    if (isSyntheticMessageId(openMessageId)) {
      return false;
    }
    return true;
  }

  /**
   * Record that a retry was attempted for this chat — bounds subsequent
   * retries to zero until `reset()`.
   */
  markRetried(chatId: string): void {
    this.retriedChats.add(chatId);
  }

  /** Whether this chat has already used its one retry in the current window. */
  hasRetried(chatId: string): boolean {
    return this.retriedChats.has(chatId);
  }

  /**
   * Whether the chat can still be retried for this empty turn: eligible AND
   * not already retried. The single check the reset/replay mechanism calls.
   */
  canRetry(chatId: string, openMessageId: string, isEmptyTurn: boolean): boolean {
    return this.isEligible(openMessageId, isEmptyTurn) && !this.hasRetried(chatId);
  }

  /**
   * Clear retry state for a chat — called after a successful turn (retry
   * recovered, or a fresh non-empty turn) so future empty turns can retry.
   */
  reset(chatId: string): void {
    this.retriedChats.delete(chatId);
  }
}
