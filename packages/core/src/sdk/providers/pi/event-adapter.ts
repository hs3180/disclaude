/**
 * pi-agent-core `AgentEvent` → disclaude `AgentMessage` adapter.
 *
 * Issue #4386 (S3, part 1): the pure mapping the `PiAgentProvider.queryStream`
 * implementation will use to translate pi's agent-loop event stream into
 * disclaude's SDK-agnostic `AgentMessage` stream. Extracted as a standalone,
 * fully unit-testable module so the mapping contract is locked independently
 * of the (still-unimplemented) queryStream wiring.
 *
 * Source of truth for the pi side: `@earendil-works/pi-agent-core@0.82.1` +
 * `@earendil-works/pi-ai` TypeScript declarations, as recorded in the #4384
 * spike (`docs/pi-agent-core-api-research.md`). The pi types below are a
 * STRUCTURAL MIRROR, not an import — disclaude does not take a hard dependency
 * on pi-agent-core (see the PiAgentProvider skeleton, #4385); they may drift
 * on a pi version bump and should be re-verified (cf. #4384 §6: 0.x, pre-1.0).
 */

import type { AgentMessage, AgentMessageMetadata, AgentMessageType } from '../../types.js';

// ---------------------------------------------------------------------------
// Structural mirrors of the pi event shapes the adapter reads.
// Only the fields consumed below are mirrored; everything else is intentionally
// dropped to keep the surface small.
// ---------------------------------------------------------------------------

/**
 * Subset of pi-ai's `AssistantMessageEvent` (the `assistantMessageEvent` field
 * of pi's `message_update` AgentEvent). Verified against
 * `@earendil-works/pi-ai@0.82.1` types.d.ts:365.
 *
 * Only the `type` discriminant + the `delta` field consumed by the adapter are
 * mirrored. pi-ai's real type additionally carries `contentIndex` and a
 * `partial: AssistantMessage` snapshot on every variant, plus `content` /
 * `toolCall` / `reason` on the *_end / done variants — intentionally dropped.
 *
 * Naming gotchas (do NOT confuse with Anthropic/disclaude vocabulary):
 * - pi-ai uses `toolcall_*`, NOT Anthropic-style `tool_use_*`.
 * - The sub-stream terminates with `done` / `error`, NOT `message_end`
 *   (`message_end` is a pi-agent-core *AgentEvent*, not a sub-event here).
 */
export type PiAssistantMessageEvent =
  | {
      type:
        | 'start'
        | 'text_start'
        | 'text_end'
        | 'thinking_start'
        | 'thinking_end'
        | 'toolcall_start'
        | 'toolcall_delta'
        | 'toolcall_end'
        | 'done'
        | 'error';
    }
  | {
      type: 'text_delta';
      delta: string;
    }
  | {
      type: 'thinking_delta';
      delta: string;
    };

/** Subset of pi-agent-core's `AgentEvent` discriminated union (types.ts:368). */
export type PiAgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: unknown[] }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | { type: 'message_start' }
  | { type: 'message_update'; assistantMessageEvent: PiAssistantMessageEvent }
  | { type: 'message_end' }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      partialResult: unknown;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

/** Utility: stringify a tool result/error payload for the AgentMessage content. */
function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Map a single pi `AgentEvent` to a disclaude `AgentMessage`.
 *
 * Returns `null` for events that do not map to a user-visible message in the
 * MVP (agent/turn/message lifecycle boundaries, reasoning/thinking deltas,
 * `text_start`/`text_end` framing). The caller should filter nulls out of the
 * stream. See #4386 / docs/pi-agent-core-api-research.md §2.
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
export function adaptPiEvent(event: PiAgentEvent): AgentMessage | null {
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
      return makeMessage('result', '', {});
    }

    default:
      // agent_start, turn_start, turn_end, message_start, message_end
      return null;
  }
}

function makeMessage(
  type: AgentMessageType,
  content: string,
  metadata: AgentMessageMetadata
): AgentMessage {
  return { type, content, role: 'assistant', metadata };
}
