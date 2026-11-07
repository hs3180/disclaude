/**
 * /discuss (Issue #5412 / T-086): convenient side-discussion entry.
 *
 * A side discussion (支线) is a short detour from the current conversation —
 * dig into an aside, chase a question down — WITHOUT stalling the main line.
 * This command is the user-side quick entry; the heavy group handoff stays
 * with the start-discussion skill, and this slice deliberately prefers the
 * platform's native topic/thread mechanism over mechanically creating groups.
 *
 * Three sub-paths:
 * - `/discuss <问题>` — open a side venue. Reply to a message to branch from
 *   that message (it becomes the thread anchor). The venue is chosen from
 *   platform capabilities and chat type (see chooseSideVenue): native thread /
 *   native topic by default, DM with --private, and a delegated group path
 *   with --group that hands the assembled context to start-discussion.
 * - `/discuss done [side-N] <结论摘要>` — typed inside the side venue, posts
 *   the conclusion summary back to the source topic; the main task continues.
 * - `/discuss status` — list this chat's side discussions.
 *
 * Like /issue, the command itself stays thin: it parses, picks the venue with
 * a pure function, and delegates delivery to the channel hook
 * (context.sideDiscussions) so it works even while an agent turn is running —
 * the main line is never paused.
 */

import type { ControlCommand, ControlResponse } from '../../types/channel.js';
import type { CommandHandler, ControlHandlerContext, SideVenueKind } from '../types.js';

const QUESTION_MAX = 500;
const SUMMARY_MAX = 4000;

const usage = [
  '`/discuss <问题>`：就地发起支线（默认原生话题/线程，主线不受影响）。回复某条消息发起则以该消息为锚点。',
  '`/discuss --private <问题>`：支线转到与机器人的私聊承接。',
  '`/discuss --group <问题>`：需要独立群/多人参与时，生成移交 start-discussion 的上下文包。',
  '`/discuss done [side-N] <结论摘要>`：在支线内回流结论到来源话题。',
  '`/discuss status`：查看本聊天的支线记录。',
].join('\n');

type Parsed =
  | { kind: 'usage' }
  | { kind: 'status' }
  | { kind: 'open'; question: string; scope?: 'group' | 'private' }
  | { kind: 'done'; id?: string; summary: string };

/** Split leading `--group` / `--private` flags off the argument list. */
function splitScopeFlags(args: string[]): { args: string[]; scope?: 'group' | 'private' } {
  let scope: 'group' | 'private' | undefined;
  const rest: string[] = [];
  for (const arg of args) {
    if (scope === undefined && arg === '--group') { scope = 'group'; continue; }
    if (scope === undefined && arg === '--private') { scope = 'private'; continue; }
    rest.push(arg);
  }
  return { args: rest, scope };
}

/** Parse normalized `{ args, parentId }` data into a sub-path. Exported for tests. */
export function parseDiscussArgs(args: string[] | undefined): Parsed {
  const list = Array.isArray(args) ? args.filter(item => typeof item === 'string') : [];
  if (list.length === 0) { return { kind: 'usage' }; }
  if (list[0] === 'status' && list.length === 1) { return { kind: 'status' }; }
  if (list[0] === 'done') {
    const rest = list.slice(1);
    const explicitId = /^side-\d+$/.test(rest[0] ?? '') ? rest[0] : undefined;
    const summary = (explicitId ? rest.slice(1) : rest).join(' ').trim();
    if (!summary) { return { kind: 'usage' }; }
    return { kind: 'done', ...(explicitId ? { id: explicitId } : {}), summary };
  }
  const { args: rest, scope } = splitScopeFlags(list);
  const question = rest.join(' ').trim();
  if (!question) { return { kind: 'usage' }; }
  return { kind: 'open', question, ...(scope ? { scope } : {}) };
}

export interface SideVenueDecision {
  venue: SideVenueKind;
  /** Anchor message for thread venues: the trigger message when replying, else the command message. */
  anchorMessageId?: string;
  /** Human-readable criterion — echoed to the user so the routing is discoverable. */
  reason: string;
}

/**
 * Deterministic venue routing (the 选路判据). Platform-native thread/topic is
 * the default; groups are delegated (never created inline); DM is opt-in.
 * Exported for tests and for the channel hook to re-verify.
 */
export function chooseSideVenue(input: {
  chatType?: string;
  supportsThread?: boolean;
  scope?: 'group' | 'private';
  triggerMessageId?: string;
  commandMessageId?: string;
}): SideVenueDecision {
  if (input.scope === 'group') {
    return { venue: 'delegated-group', reason: '需要独立群或多人参与，按 start-discussion 建群交接' };
  }
  if (input.scope === 'private') {
    return { venue: 'p2p', reason: '转入与发起人的私聊承接，群内主线不被打断' };
  }
  if (input.supportsThread === false) {
    return { venue: 'delegated-group', reason: '当前渠道不支持原生话题/线程，降级为建群交接' };
  }
  const anchor = input.triggerMessageId ?? input.commandMessageId;
  if (input.chatType === 'topic') {
    return { venue: 'topic-thread', reason: '话题群内以新话题承接，与原话题会话隔离' };
  }
  return {
    venue: 'message-thread',
    ...(anchor ? { anchorMessageId: anchor } : {}),
    reason: input.triggerMessageId
      ? '以触发消息为锚点开原生话题线程，主线会话不受影响'
      : '以命令消息为锚点开原生话题线程，主线会话不受影响',
  };
}

/** Context bundle for the delegated group path: everything start-discussion needs, pre-assembled. */
export function delegatedGroupBundle(request: {
  question: string;
  chatId: string;
  reason: string;
  triggerMessageId?: string;
  commandMessageId?: string;
  threadRootId?: string;
}): string {
  return [
    `已选择建群承接（判据：${request.reason}）。本命令不直接建群；请把下面的上下文包交给本会话 agent 执行 start-discussion 完成建群交接：`,
    `- 话题：${request.question}`,
    `- 来源会话：${request.chatId}`,
    `- 触发消息：${request.triggerMessageId ?? '（无，按当前对话上下文取背景）'}`,
    `- 来源话题根：${request.threadRootId ?? '（主线，无话题根）'}`,
    `- 发起命令消息：${request.commandMessageId ?? 'unknown'}`,
  ].join('\n');
}

export const handleDiscuss: CommandHandler<'discuss'> = async (
  command: ControlCommand<'discuss'>,
  context: ControlHandlerContext
): Promise<ControlResponse> => {
  const hook = context.sideDiscussions;
  const parsed = parseDiscussArgs(command.data?.args);
  const { chatId } = command;

  if (parsed.kind === 'usage') {
    return { success: false, message: usage };
  }

  if (parsed.kind === 'status') {
    if (!hook) { return { success: false, message: '当前渠道不支持支线讨论记录。' }; }
    const records = await hook.list(chatId);
    if (records.length === 0) { return { success: true, message: '本聊天暂无支线讨论记录。' }; }
    return {
      success: true,
      message: records.map(record =>
        `- **${record.id}**（${record.status === 'open' ? '进行中' : '已回流'}）${record.title}` +
        `${record.anchorMessageId ? ` · 锚点 ${record.anchorMessageId}` : ''}`
      ).join('\n'),
    };
  }

  if (parsed.kind === 'done') {
    if (parsed.summary.length > SUMMARY_MAX) {
      return { success: false, message: `结论摘要过长（>${SUMMARY_MAX} 字符），请精简后重试。` };
    }
    if (!hook) { return { success: false, message: '当前渠道不支持支线讨论回流。' }; }
    const result = await hook.conclude({
      chatId,
      ...(parsed.id ? { id: parsed.id } : {}),
      ...(command.threadRootId ? { threadRootId: command.threadRootId } : {}),
      summary: parsed.summary,
      ...(command.actorId ? { actorId: command.actorId } : {}),
    });
    return result.ok
      ? { success: true, message: result.message }
      : { success: false, message: result.error };
  }

  // parsed.kind === 'open'
  if (parsed.question.length > QUESTION_MAX) {
    return { success: false, message: `问题过长（>${QUESTION_MAX} 字符），请提炼后重试。` };
  }
  const capabilities = context.getHelpCapabilities?.();
  const decision = chooseSideVenue({
    ...(command.chatType ? { chatType: command.chatType } : {}),
    ...(capabilities ? { supportsThread: capabilities.supportsThread } : {}),
    ...(parsed.scope ? { scope: parsed.scope } : {}),
    ...(command.data?.parentId ? { triggerMessageId: command.data.parentId } : {}),
    ...(command.sourceMessageId ? { commandMessageId: command.sourceMessageId } : {}),
  });

  if (decision.venue === 'delegated-group') {
    return {
      success: true,
      message: delegatedGroupBundle({
        chatId,
        question: parsed.question,
        reason: decision.reason,
        ...(command.data?.parentId ? { triggerMessageId: command.data.parentId } : {}),
        ...(command.sourceMessageId ? { commandMessageId: command.sourceMessageId } : {}),
        ...(command.threadRootId ? { threadRootId: command.threadRootId } : {}),
      }),
    };
  }

  if (!hook) { return { success: false, message: '当前渠道不支持支线讨论入口。' }; }
  const result = await hook.open({
    chatId,
    question: parsed.question,
    venue: decision.venue,
    ...(decision.anchorMessageId ? { anchorMessageId: decision.anchorMessageId } : {}),
    ...(command.data?.parentId ? { triggerMessageId: command.data.parentId } : {}),
    ...(command.sourceMessageId ? { commandMessageId: command.sourceMessageId } : {}),
    ...(command.threadRootId ? { threadRootId: command.threadRootId } : {}),
    ...(command.chatType ? { chatType: command.chatType } : {}),
    ...(command.actorId ? { actorId: command.actorId } : {}),
  });
  return result.ok
    ? { success: true, message: result.message }
    : { success: false, message: `支线发起未完成：${result.error}` };
};
