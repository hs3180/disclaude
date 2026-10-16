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
            // Deliver completed public messages, never individual tokens/reasoning.
            return [];
        }
        case 'assistant/message': {
            const message = data.message;
            const blocks = Array.isArray(message?.content) ? message.content : [];
            const text = blocks
                .filter((block) => block?.type === 'text' && typeof block.text === 'string')
                .map(block => block.text).join('');
            if (!text) {
                return [];
            }
            return [makeMessage('text', text, {
                    messageId: String(message?.id ?? ''),
                    phase: blocks.some(block => block?.type === 'tool-call') ? 'commentary' : 'final_answer',
                })];
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
                    toolOutput: data.meta ?? output,
                    messageId: String(block?.toolCallId ?? ''),
                }),
            ];
        }
        case 'turn/end': {
            const reason = data.reason;
            if (reason?.kind === 'completed') {
                return [makeMessage('result', '', { stopReason: 'completed' })];
            }
            if (reason?.kind === 'aborted') {
                return [makeMessage('result', '', { stopReason: 'interrupted' })];
            }
            const error = reason?.error;
            if (reason?.kind === 'error' && error?.code === 'CONTEXT_WINDOW_EXCEEDED') {
                return [makeMessage('error', '上下文已满，本轮未能继续。请先检查已完成的结果，再发送消息继续；如仍无法继续，可使用 /reset 开始新会话。', {
                        stopReason: 'error', terminationDetail: 'DSH CONTEXT_WINDOW_EXCEEDED',
                    })];
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
