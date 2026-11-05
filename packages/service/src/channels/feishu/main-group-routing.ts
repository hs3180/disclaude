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
 * Decide whether a group-chat message should be redirected to the project's
 * main group.
 *
 * Returns null (message proceeds normally) when any of these hold:
 * - the chat is not a plain group chat (p2p/topic chats are untouched);
 * - routing hints are disabled by configuration;
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
  input: { chatId: string; chatType?: string },
): Promise<MainGroupRedirect | null> {
  if (input.chatType !== 'group') { return null; }
  if (!deps.hintEnabled()) { return null; }

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
