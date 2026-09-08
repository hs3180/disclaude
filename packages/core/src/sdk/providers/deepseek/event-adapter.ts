/**
 * Structural dsh event → disclaude AgentMessage adapter (Issue #4743).
 *
 * The dsh wire schema is not yet verified against a real harness installation.
 * Keep this mirror deliberately small and tolerant: known event shapes map to
 * the shared message contract, while unknown notifications are ignored rather
 * than surfaced as user-visible text. The transport/provider wiring remains a
 * separate follow-up.
 */
import type { AgentMessage, AgentMessageMetadata, AgentMessageType } from '../../types.js';

export interface DeepSeekUsage {
  input_tokens?: number;
  output_tokens?: number;
}

export type DeepSeekHarnessEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; id: string; name: string; input?: unknown }
  | { type: 'tool_result'; id: string; name?: string; result?: unknown; is_error?: boolean }
  | { type: 'completed'; usage?: DeepSeekUsage }
  | { type: 'error'; message: string; retryable?: boolean }
  | { type: string; [key: string]: unknown };

function stringifyPayload(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined || value === null) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function makeMessage(
  type: AgentMessageType,
  content: string,
  metadata: AgentMessageMetadata
): AgentMessage {
  return { type, content, role: 'assistant', metadata };
}

/** Map one verified-or-fixture dsh event to the shared AgentMessage shape. */
export function adaptDeepSeekEvent(event: DeepSeekHarnessEvent): AgentMessage | null {
  switch (event.type) {
    case 'text_delta': {
      const known = event as { delta: string };
      return makeMessage('text', known.delta, {});
    }
    case 'tool_call': {
      const known = event as { id: string; name: string; input?: unknown };
      return makeMessage('tool_use', known.name, {
        toolName: known.name,
        toolInput: known.input,
        messageId: known.id,
      });
    }
    case 'tool_result': {
      const known = event as { id: string; name?: string; result?: unknown; is_error?: boolean };
      return makeMessage(
        'tool_result',
        known.is_error
          ? `Error: ${stringifyPayload(known.result)}`
          : stringifyPayload(known.result),
        { toolName: known.name, toolOutput: known.result, messageId: known.id }
      );
    }
    case 'completed': {
      const known = event as { usage?: DeepSeekUsage };
      return makeMessage('result', '', {
        inputTokens: known.usage?.input_tokens,
        outputTokens: known.usage?.output_tokens,
      });
    }
    case 'error': {
      const known = event as { message: string; retryable?: boolean };
      return makeMessage(known.retryable ? 'status' : 'error', known.message, {});
    }
    default:
      return null;
  }
}
