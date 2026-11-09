/**
 * Delivery-position echo contract for the channel CLI send_* tools.
 *
 * Issue #5722 (maintainer evidence): in Feishu topic groups a send_file without
 * --parent does NOT land in the current topic — it silently starts a NEW topic
 * (im +messages-mget shows thread_message_position=-1), while the CLI success
 * message is byte-identical to an in-topic reply, so the agent cannot notice
 * the misplacement. Every send_* success message therefore echoes WHERE the
 * message was delivered, in one channel-agnostic form:
 *
 *   — thread reply to <parent> [ (messageId <id>) ]
 *   — chat root [ (messageId <id>) ]
 *
 * The service reports the position for send_file (`deliveryPosition` +
 * `threadId` in the REST uploadFile response, Issue #5722); when absent (older
 * service, or send_text/send_card whose REST responses carry no position yet)
 * the position is derived from the --parent request. Channels that ignore
 * threadId keep their current delivery behavior — the echo then describes the
 * requested position, which is the best information available client-side.
 *
 * Only IDs are echoed (parent/message ids); no other messages' content is
 * included.
 *
 * @module channel-cli/tools/delivery-position
 */
/** Warning appended when a send carried no --parent (topic-group hazard). */
export const PARENT_OMITTED_TOPIC_WARNING = '⚠️ Sent without --parent: in a topic group this starts a NEW topic instead of replying inside the current one — re-send with --parent <message_id> to deliver in the intended topic.';
/**
 * Resolve the delivery position and build the unified success-message suffix.
 *
 * The suffix always states the position; when no --parent was passed it also
 * carries {@link PARENT_OMITTED_TOPIC_WARNING}, because the CLI cannot
 * distinguish topic-group chats from plain chats offline — the warning is
 * phrased conditionally so it stays accurate in both.
 */
export function resolveDeliveryPosition(input) {
    const { parentMessageId, deliveryPosition, threadId, messageId } = input;
    const parentOmitted = !parentMessageId;
    const position = deliveryPosition ?? (parentMessageId ? 'thread-reply' : 'chat-root');
    const repliedUnder = position === 'thread-reply' ? (threadId ?? parentMessageId) : undefined;
    const parts = [];
    if (position === 'thread-reply') {
        parts.push(`— thread reply to ${repliedUnder ?? '<unknown parent>'}`);
    }
    else {
        parts.push('— chat root');
    }
    if (messageId && messageId !== repliedUnder) {
        parts.push(`(messageId ${messageId})`);
    }
    if (parentOmitted) {
        parts.push(PARENT_OMITTED_TOPIC_WARNING);
    }
    return {
        deliveryPosition: position,
        ...(repliedUnder ? { threadId: repliedUnder } : {}),
        parentOmitted,
        suffix: parts.join(' '),
    };
}
