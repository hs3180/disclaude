function stringifyPayload(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined || value === null) {
        return '';
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
function makeMessage(type, content, metadata) {
    return { type, content, role: 'assistant', metadata };
}
/** Map one verified-or-fixture dsh event to the shared AgentMessage shape. */
export function adaptDeepSeekEvent(event) {
    const data = event.data ?? {};
    switch (event.type) {
        case 'assistant/chunk': {
            // The provider buffers text deltas until a message boundary. A shared
            // text event represents a deliverable reply, not one token or reasoning.
            return [];
        }
        case 'assistant/message': {
            const message = data.message;
            const blocks = Array.isArray(message?.content) ? message.content : [];
            return blocks.flatMap((block) => {
                if (!block || typeof block !== 'object') {
                    return [];
                }
                const value = block;
                if (value.type !== 'text') {
                    return [];
                }
                if (typeof value.text !== 'string' || value.text.length === 0) {
                    return [];
                }
                return [makeMessage('text', value.text, { messageId: String(message?.id ?? '') })];
            });
        }
        case 'tool/call': {
            const rawArguments = typeof data.arguments === 'string' ? data.arguments : '';
            let input = rawArguments;
            try {
                input = JSON.parse(rawArguments);
            }
            catch {
                /* retain malformed provider text */
            }
            return [
                makeMessage('tool_use', String(data.name ?? ''), {
                    toolName: String(data.name ?? ''),
                    toolInput: input,
                    messageId: String(data.callId ?? ''),
                }),
            ];
        }
        case 'tool/result': {
            const message = data.message;
            const block = Array.isArray(message?.content)
                ? message.content[0]
                : undefined;
            const content = Array.isArray(block?.content) ? block.content : [];
            const output = content
                .map((item) => item && typeof item === 'object' && 'text' in item
                ? String(item.text)
                : stringifyPayload(item))
                .join('');
            return [
                makeMessage('tool_result', block?.isError === true ? `Error: ${output}` : output, {
                    toolOutput: output,
                    messageId: String(block?.toolCallId ?? ''),
                }),
            ];
        }
        case 'turn/end': {
            const reason = data.reason;
            if (reason?.kind === 'completed') {
                return [makeMessage('result', '', { stopReason: 'completed' })];
            }
            const detail = reason?.kind === 'error'
                ? stringifyPayload(reason.error)
                : String(reason?.kind ?? 'unknown');
            return [
                makeMessage('error', `DeepSeek Harness turn ended: ${detail}`, {
                    stopReason: String(reason?.kind ?? 'unknown'),
                }),
            ];
        }
        default:
            return [];
    }
}
