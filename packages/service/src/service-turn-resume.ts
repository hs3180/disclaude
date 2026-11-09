/**
 * Startup auto-resume for interactive turns interrupted by a service restart
 * (Issue #5733).
 *
 * Before this, a restart-interrupted interactive turn only ever produced the
 * "不会自动重放" notice; the final reply stayed lost until the user's next
 * message happened to resume the session. This module injects exactly one
 * continuation trigger per interrupted interactive turn at startup — the same
 * recovery shape the scheduler owns for scheduled turns and the same nudge
 * pattern as the in-session mid-stream auto-continue (chat-agent.ts
 * auto-midstream): a synthetic message asking the agent to verify already
 * executed side effects, then continue or summarize.
 *
 * Semantics:
 * - Only interactive-origin turns. Scheduled turns keep the scheduler's own
 *   retry semantics (origin 'scheduled' is derived from the sched- prefix at
 *   admission). Other synthetic ids (push_/cli-/auto-*) share the interactive
 *   outcome: the interruption notice already goes to the chat channel for
 *   them, so the continuation does too.
 * - At most one resume per chat (the newest interrupted turn); older
 *   interrupted turns in the same chat keep their notice-only outcome.
 * - The durable autoResume claim is persisted BEFORE injection, so repeated
 *   restarts can never stack duplicate nudges.
 * - Injection failure is logged, never thrown: the interruption notice is
 *   already the user-visible outcome.
 */
import type { Logger } from 'pino';
import type { InterruptedServiceTurn, ServiceTurnRecoveryStore } from './service-turn-recovery.js';

export const RESUME_TRIGGER_MESSAGE_ID_PREFIX = 'auto-restart-';

/** Wording shared with the interruption notice: verify first, never replay blindly. */
export const INTERRUPTED_TURN_RESUME_PROMPT =
  '（服务重启中断了上一轮回复，任务可能未完成，已产生的输出可能不完整。）' +
  '请先核对已执行操作的当前状态，不要重复已完成的操作；' +
  '然后继续完成刚才的任务；若任务已实质完成，请直接总结当前状态与结果。';

export interface ServiceTurnResumeDeps {
  store: ServiceTurnRecoveryStore;
  /** Returns the owning channel, or undefined when no channel serves the chat. */
  resolveChannel: (chatId: string) => unknown;
  /** Pushes the resume trigger into the chat's agent session. */
  inject: (turn: InterruptedServiceTurn, resumeMessageId: string) => Promise<void> | void;
  logger: Logger;
}

/** Select the resumable turns: interactive origin, unresumed, newest per chat. */
export function selectAutoResumableTurns(turns: InterruptedServiceTurn[]): InterruptedServiceTurn[] {
  const newestPerChat = new Map<string, InterruptedServiceTurn>();
  for (const turn of turns) {
    if (turn.origin !== 'interactive' || turn.autoResume) { continue; }
    const current = newestPerChat.get(turn.chatId);
    if (!current || turn.startedAt >= current.startedAt) {
      newestPerChat.set(turn.chatId, turn);
    }
  }
  return [...newestPerChat.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** Auto-resume interrupted interactive turns after the channels are ready. */
export async function resumeInterruptedInteractiveTurns(deps: ServiceTurnResumeDeps): Promise<void> {
  const { store, resolveChannel, inject, logger } = deps;
  for (const turn of selectAutoResumableTurns(store.getInterruptedTurns())) {
    const channel = resolveChannel(turn.chatId);
    if (!channel) {
      logger.warn(
        { chatId: turn.chatId, runId: turn.runId, sourceMessageId: turn.sourceMessageId },
        'No channel owns the interrupted chat; skipping startup auto-resume (Issue #5733)'
      );
      continue;
    }
    const resumeMessageId = `${RESUME_TRIGGER_MESSAGE_ID_PREFIX}${turn.runId.slice(0, 8)}`;
    let claimed = false;
    try {
      claimed = store.markAutoResumeAttempted(turn.runId, resumeMessageId);
    } catch (error) {
      logger.error(
        { err: error, runId: turn.runId },
        'Could not persist the auto-resume claim; not injecting (Issue #5733)'
      );
      continue;
    }
    if (!claimed) { continue; }
    try {
      await inject(turn, resumeMessageId);
      logger.info(
        { chatId: turn.chatId, runId: turn.runId, sourceMessageId: turn.sourceMessageId,
          resumeMessageId, user_visible: true },
        'Auto-resuming an interrupted interactive turn after service restart (Issue #5733)'
      );
    } catch (error) {
      logger.error(
        { err: error, chatId: turn.chatId, runId: turn.runId, resumeMessageId },
        'Auto-resume injection failed for an interrupted interactive turn (Issue #5733)'
      );
    }
  }
}
