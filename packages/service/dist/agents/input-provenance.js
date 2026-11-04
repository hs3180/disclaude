// Object identity is intentionally process-local. Neither a REST JSON object
// nor a persisted/replayed message can manufacture an entry in these maps.
const incomingSources = new WeakMap();
const verifiedSources = new WeakMap();
const sourceKey = Symbol('verifiedFeishuInput');
/** Call only for an accepted user event from the authenticated Feishu channel. */
export function registerFeishuInputSource(message, sourceMessageId, senderType) {
    if (senderType !== 'user' || !message.userId || !message.chatId ||
        !message.messageId || !sourceMessageId || incomingSources.has(message)) {
        return;
    }
    const source = Object.freeze({});
    const threadRootId = message.metadata?.threadRootId;
    verifiedSources.set(source, Object.freeze({
        channel: 'feishu', chatId: message.chatId, actorId: message.userId,
        inputMessageId: message.messageId, sourceMessageId,
        ...(typeof threadRootId === 'string' && threadRootId ? { threadRootId } : {}),
    }));
    incomingSources.set(message, source);
}
/** Opaque host-only reference; not a model argument or an authorization result. */
export function getIncomingInputSource(message) {
    return incomingSources.get(message);
}
function matches(context, facts) {
    return context.chatId === facts.chatId && context.actorId === facts.actorId &&
        context.sourceMessageId === facts.inputMessageId &&
        (!facts.threadRootId || context.threadRootId === facts.threadRootId);
}
/** Keep identity across host shallow snapshots, without adding JSON fields. */
export function bindVerifiedInputContext(context, source) {
    const facts = typeof source === 'object' && source !== null ? verifiedSources.get(source) : undefined;
    if (!facts || !matches(context, facts)) {
        return context;
    }
    const bound = { ...context, [sourceKey]: source };
    return bound;
}
/** Provenance only. Callers must separately enforce permissions and Project scope. */
export function readVerifiedInputSource(context) {
    const source = context?.[sourceKey];
    const facts = source && verifiedSources.get(source);
    return context && facts && matches(context, facts) ? facts : undefined;
}
