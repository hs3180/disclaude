/**
 * Main-group routing for the Feishu message entrypoint (Issue #5396).
 *
 * A project declares one "main battlefield" group chat (persisted by
 * {@link BotChatMappingStore}). Task messages arriving in a *different* group
 * that belongs to the same project would silently open a second parallel
 * execution stream. This module decides whether an incoming group message is
 * such a non-main-group task message and builds the reply that redirects the
 * user to the main group.
 *
 * Content-safety invariant: the reply never includes the incoming message
 * text nor any other group's message content — only the main-group chatId and
 * a coarse busy-state summary.
 *
 * @module service/channels/feishu/main-group-routing
 */

import type { BotChatMappingStore } from '@disclaude/core';

/** Structural slice of the mapping store this module needs (keeps tests fs-free). */
export type MainGroupStoreLike = Pick<BotChatMappingStore,
  'findEntryByChatId' | 'getMainGroup' | 'declareMainGroup' | 'clearMainGroup'
>;

/** Dependencies injected by the channel wiring. */
export interface MainGroupRoutingDeps {
  /** Mapping store holding project entries and main-group declarations. */
  store: MainGroupStoreLike;
  /** Whether redirect hints are enabled (`feishu.mainGroupRoutingHint`, default true). */
  hintEnabled: () => boolean;
  /**
   * Coarse busy-state summary for the main group's agent (no content).
   * Returns undefined when no state is available.
   */
  getBusySummary?: (chatId: string) => string | undefined;
}

/** Outcome of the routing check for one incoming message. */
export interface MainGroupRedirect {
  /** Declared main-group chatId for the project this chat belongs to. */
  mainChatId: string;
  /** Normalized workdir of the project. */
  workdir: string;
}

/**
 * Default per-chat redirect-hint cooldown. Message retries (or a user
 * re-sending in quick succession) must not re-spam the chat with identical
 * hints; the redirect decision itself is unaffected — only the hint reply is
 * rate-limited.
 */
export const MAIN_GROUP_HINT_COOLDOWN_MS = 10 * 60 * 1000;

const hintSentAt = new Map<string, number>();

/**
 * Try to acquire this chat's redirect-hint slot for the current cooldown
 * window. Returns true exactly once per window (and marks it); false means a
 * hint was already sent recently and this one should be suppressed.
 */
export function tryAcquireRedirectHintSlot(
  chatId: string,
  now: number = Date.now(),
  cooldownMs: number = MAIN_GROUP_HINT_COOLDOWN_MS,
): boolean {
  const last = hintSentAt.get(chatId);
  if (last !== undefined && now - last < cooldownMs) { return false; }
  hintSentAt.set(chatId, now);
  return true;
}

/** Forget all redirect-hint cooldowns (test isolation). */
export function resetRedirectHintCooldowns(): void {
  hintSentAt.clear();
}

/**
 * Decide whether a group-chat message should be redirected to the project's
 * main group.
 *
 * "Task message" is deliberately the minimal completable set: the message
 * must @mention this bot. Ambient group chatter (the side-talk a non-main
 * group legitimately hosts) is never intercepted — prefer under-blocking to
 * mis-blocking a structure that cannot fully classify intent.
 *
 * Returns null (message proceeds normally) when any of these hold:
 * - the chat is not a plain group chat (p2p/topic chats are untouched);
 * - routing hints are disabled by configuration;
 * - the message does not @mention the bot;
 * - the chat has no project mapping entry, or the entry carries no workdir
 *   (no mapping / single-group setups behave exactly as before);
 * - this chat *is* the declared main group, or no main group is declared.
 *
 * @param deps - Routing dependencies
 * @param input - Incoming message facts
 * @returns Redirect info when the message belongs to the project but arrived
 *   in a non-main group; null otherwise
 */
export async function evaluateMainGroupRedirect(
  deps: MainGroupRoutingDeps,
  input: { chatId: string; chatType?: string; mentionsBot: boolean },
): Promise<MainGroupRedirect | null> {
  if (input.chatType !== 'group') { return null; }
  if (!deps.hintEnabled()) { return null; }
  if (!input.mentionsBot) { return null; }

  const entry = await deps.store.findEntryByChatId(input.chatId);
  if (!entry?.workdir) { return null; }

  const mainChatId = await deps.store.getMainGroup(entry.workdir);
  if (!mainChatId || mainChatId === input.chatId) { return null; }

  return { mainChatId, workdir: entry.workdir };
}

/**
 * Build the redirect hint reply. Contains no message content.
 *
 * @param redirect - Redirect outcome from {@link evaluateMainGroupRedirect}
 * @param deps - Routing dependencies (busy summary)
 * @returns Hint text to send back to the non-main group
 */
export function buildRedirectHint(redirect: MainGroupRedirect, deps: MainGroupRoutingDeps): string {
  const lines = [`本项目的执行与讨论主群是 ${redirect.mainChatId}，任务消息请发到主群，避免开出第二条平行流水。`];
  const busy = deps.getBusySummary?.(redirect.mainChatId);
  if (busy) { lines.push(`主群当前状态：${busy}。`); }
  lines.push('临时支线讨论请在主群发起（/discuss 或让主群 agent 发起支线讨论），不要在本群另开任务讨论。');
  lines.push('如需把本群设为主群：发送 /main-group。');
  return lines.join('\n');
}

/**
 * Build the one-time migration notice for the previous main group after a
 * declaration switch. Contains no message content from either group.
 *
 * @param params - Old/new chatIds and the project workdir
 * @returns Notice text to send to the old main group
 */
export function buildMigrationGuidance(params: { oldChatId: string; newChatId: string; workdir: string }): string {
  return [
    `【主群迁移】项目（workdir: ${params.workdir}）的主战场群已切换为 ${params.newChatId}。`,
    '后续任务消息与执行流水请发到新群；本群保留既有历史，不再作为该项目主入口。',
  ].join('\n');
}
