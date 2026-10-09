/**
 * pi-agent-core `AgentEvent` → disclaude `AgentMessage` adapter.
 *
 * Issue #4386 (S3, part 1): the pure mapping the `PiAgentProvider.queryStream`
 * implementation will use to translate pi's agent-loop event stream into
 * disclaude's SDK-agnostic `AgentMessage` stream. Extracted as a standalone,
 * fully unit-testable module so the mapping contract is locked independently
 * of the (still-unimplemented) queryStream wiring.
 *
 * Source of truth for the pi side: the pinned pi-agent-core/pi-ai TypeScript
 * declarations. The pi types below are a STRUCTURAL MIRROR, not an import —
 * disclaude does not take a hard dependency on pi-agent-core; they may drift on
 * a pi version bump and should be re-verified.
 */
/** Utility: stringify a tool result/error payload for the AgentMessage content. */
function stringifyPayload(value) {
    if (typeof value === 'string') {
        return value;
    }
    if (value === undefined) {
        return '';
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
/**
 * Map a single pi `AgentEvent` to a disclaude `AgentMessage`.
 *
 * Returns `null` for events that do not map to a user-visible message in the
 * MVP (agent/turn/message lifecycle boundaries, reasoning/thinking deltas,
 * `text_start`/`text_end` framing). The caller should filter nulls out of the
 * stream. See #4386 and the current pi backend guide.
 *
 * Mapping:
 * - `message_update` (`text_delta`)            → `text` (assistant text delta)
 * - `tool_execution_start`                      → `tool_use`
 * - `tool_execution_update`                     → `tool_progress`
 * - `tool_execution_end`                        → `tool_result` (errors prefixed)
 * - `agent_end`                                 → `result`
 * - everything else                             → `null`
 *
 * Out of scope (MVP, no-MCP per #4386): thinking_delta streaming, tool arg
 * schema translation (S4 #4387), streamed usage/cost metadata.
 */
export function adaptPiEvent(event) {
    switch (event.type) {
        case 'message_update': {
            const sub = event.assistantMessageEvent;
            if (sub.type === 'text_delta') {
                return makeMessage('text', sub.delta, {});
            }
            // thinking_delta / text_start / text_end / toolcall_* / done / error / start
            // / thinking_* → skip (MVP). (done/error terminate the AssistantMessage
            // sub-stream; the agent-level agent_end → result is the stream terminator.)
            return null;
        }
        case 'tool_execution_start': {
            return makeMessage('tool_use', event.toolName, {
                toolName: event.toolName,
                toolInput: event.args,
                messageId: event.toolCallId,
            });
        }
        case 'tool_execution_update': {
            return makeMessage('tool_progress', event.toolName, {
                toolName: event.toolName,
                toolOutput: event.partialResult,
                messageId: event.toolCallId,
            });
        }
        case 'tool_execution_end': {
            const content = event.isError
                ? `Error: ${stringifyPayload(event.result)}`
                : stringifyPayload(event.result);
            return makeMessage('tool_result', content, {
                toolName: event.toolName,
                toolOutput: event.result,
                messageId: event.toolCallId,
            });
        }
        case 'agent_end': {
            const last = event.messages.at(-1);
            if (last?.role === 'assistant' && last.stopReason === 'error') {
                return makeMessage('result', last.errorMessage || 'pi model request failed', { terminatedReason: 'turn_failed' });
            }
            return makeMessage('result', '', {});
        }
        default:
            // agent_start, turn_start, turn_end, message_start, message_end
            return null;
    }
}
function makeMessage(type, content, metadata) {
    return { type, content, role: 'assistant', metadata };
}
