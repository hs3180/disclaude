import type { AgentInputContext, IncomingMessage } from '@disclaude/core';

/** Facts captured at the Feishu user-event boundary, before ordinary routing. */
export interface VerifiedFeishuInput {
  readonly channel: 'feishu';
  readonly chatId: string;
  readonly actorId: string;
  readonly inputMessageId: string;
  /** Real platform ID; media inputs may have a different internal message ID. */
  readonly sourceMessageId: string;
  readonly chatType?: 'p2p' | 'group' | 'topic';
  readonly threadRootId?: string;
}

// Object identity is intentionally process-local. Neither a REST JSON object
// nor a persisted/replayed message can manufacture an entry in these maps.
const incomingSources = new WeakMap<IncomingMessage, object>();
const verifiedSources = new WeakMap<object, Readonly<VerifiedFeishuInput>>();
const sourceKey = Symbol('verifiedFeishuInput');
type BoundContext = AgentInputContext & { [sourceKey]?: object };

/** Call only for an accepted user event from the authenticated Feishu channel. */
export function registerFeishuInputSource(
  message: IncomingMessage, sourceMessageId: string, senderType: string | undefined,
): void {
  if (senderType !== 'user' || !message.userId || !message.chatId ||
      !message.messageId || !sourceMessageId || incomingSources.has(message)) { return; }
  const source = Object.freeze({});
  const threadRootId = message.metadata?.threadRootId;
  const chatType = message.metadata?.chatType;
  verifiedSources.set(source, Object.freeze({
    channel: 'feishu', chatId: message.chatId, actorId: message.userId,
    inputMessageId: message.messageId, sourceMessageId,
    ...(chatType === 'p2p' || chatType === 'group' || chatType === 'topic' ? { chatType } : {}),
    ...(typeof threadRootId === 'string' && threadRootId ? { threadRootId } : {}),
  }));
  incomingSources.set(message, source);
}

/** Opaque host-only reference; not a model argument or an authorization result. */
export function getIncomingInputSource(message: IncomingMessage): unknown {
  return incomingSources.get(message);
}

function matches(context: Readonly<AgentInputContext>, facts: Readonly<VerifiedFeishuInput>): boolean {
  return context.chatId === facts.chatId && context.actorId === facts.actorId &&
    context.sourceMessageId === facts.inputMessageId &&
    (!facts.threadRootId || context.threadRootId === facts.threadRootId);
}

/** Keep identity across host shallow snapshots, without adding JSON fields. */
export function bindVerifiedInputContext(context: AgentInputContext, source: unknown): AgentInputContext {
  const facts = typeof source === 'object' && source !== null ? verifiedSources.get(source) : undefined;
  if (!facts || !matches(context, facts)) { return context; }
  const bound: BoundContext = { ...context, [sourceKey]: source as object };
  return bound;
}

/** Provenance only. Callers must separately enforce permissions and Project scope. */
export function readVerifiedInputSource(
  context: Readonly<AgentInputContext> | undefined,
): Readonly<VerifiedFeishuInput> | undefined {
  const source = (context as BoundContext | undefined)?.[sourceKey];
  const facts = source && verifiedSources.get(source);
  return context && facts && matches(context, facts) ? facts : undefined;
}
