/**
 * codex exec `--json` ThreadEvent → disclaude `AgentMessage` adapter.
 *
 * Issue #4630 (S2 of #4627): the pure mapping the `CodexAgentProvider.queryStream`
 * implementation uses to translate the Codex CLI's JSONL event stream into
 * disclaude's SDK-agnostic `AgentMessage` stream. Extracted as a standalone,
 * fully unit-testable module so the mapping contract is locked independently
 * of the subprocess wiring — same pattern as pi's event-adapter (#4386 part 1).
 *
 * Source of truth for the codex side: a live capture against codex-cli
 * **0.132.0** (`codex exec --json --ephemeral --skip-git-repo-check -s read-only`,
 * 2026-08-29) cross-checked with the published event cheatsheet. The types
 * below are a STRUCTURAL MIRROR, not an import — codex has no npm types
 * package. Event-schema stability across CLI versions is an open question on
 * #4627; the adapter is therefore TOLERANT: unknown event types and unknown
 * item types map to `null` (skipped), never thrown.
 *
 * Captured wire shape (0.132.0):
 *   {"type":"thread.started","thread_id":"01a04d36-…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}
 *   {"type":"turn.completed","usage":{"input_tokens":18768,"cached_input_tokens":3712,
 *    "output_tokens":5,"reasoning_output_tokens":0}}
 */

import type { AgentMessage, AgentMessageMetadata, AgentMessageType } from '../../types.js';

// ---------------------------------------------------------------------------
// Structural mirrors of the codex `--json` event shapes the adapter reads.
// Only the fields consumed below are mirrored; unknown extra fields are
// ignored by design ("Unknown fields may appear; ignore what you don't use").
// ---------------------------------------------------------------------------

/** `turn.completed.usage` — token accounting (subscription billing, no USD). */
export interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

/**
 * `item.*` payloads. The discriminated cases below are the item types with a
 * user-visible mapping; the catch-all keeps future/unknown item types flowing
 * through the adapter as `null` instead of breaking the bridge.
 */
export type CodexItem =
  | { id: string; type: 'agent_message'; text: string }
  | { id: string; type: 'reasoning'; text: string }
  | {
      id: string;
      type: 'command_execution';
      command: string;
      aggregated_output?: string;
      exit_code?: number | null;
      status?: string;
    }
  | {
      id: string;
      type: 'file_change';
      changes?: Array<{ path: string; kind: string }>;
      status?: string;
    }
  | {
      id: string;
      type: 'mcp_tool_call';
      server: string;
      tool: string;
      arguments?: unknown;
      error?: { message?: string } | null;
      /**
       * Successful MCP tool payload (0.132.0 cheatsheet): `result.content`
       * is an array of content blocks; `structured_content` may accompany
       * it. Mirrored so successful calls surface their output instead of
       * an empty tool_result (S2 review finding).
       */
      result?: { content?: unknown; structured_content?: unknown } | null;
      status?: string;
    }
  | { id: string; type: 'web_search'; query: string }
  | { id: string; type: 'todo_list'; items?: Array<{ text: string; completed: boolean }> }
  | { id: string; type: 'error'; message: string }
  // Tolerance catch-all: unknown item types (schema drift, newer CLI) skip.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { id?: string; type: string; [extra: string]: any };

/** Top-level `--json` thread event (one JSON object per stdout line). */
export type CodexThreadEvent =
  | { type: 'thread.started'; thread_id: string }
  | { type: 'turn.started' }
  | { type: 'turn.completed'; usage?: CodexUsage }
  | { type: 'turn.failed'; error?: { message?: string } }
  | { type: 'error'; message: string }
  | { type: 'item.started'; item: CodexItem }
  | { type: 'item.updated'; item: CodexItem }
  | { type: 'item.completed'; item: CodexItem }
  // Tolerance catch-all: unknown top-level types skip.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { type: string; [extra: string]: any };

/**
 * Is this event an item.* event carrying the given item type?
 * Narrows the catch-all without asserting exhaustiveness.
 */
function isItemEvent(
  event: CodexThreadEvent,
  phase: 'item.started' | 'item.updated' | 'item.completed',
  itemType: string,
): boolean {
  return event.type === phase && typeof event.item === 'object' &&
    event.item !== null && event.item.type === itemType;
}

/** Utility: stringify a tool payload for the AgentMessage content. */
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

/**
 * Render a successful MCP tool payload for the tool_result content: content
 * blocks' text parts joined by newline; anything else (missing, non-array,
 * exotic blocks) falls back to JSON stringification (S2 review).
 */
function mcpResultText(
  result: { content?: unknown; structured_content?: unknown } | null | undefined,
): string {
  if (Array.isArray(result?.content)) {
    const texts = result.content
      .map((block) =>
        block !== null && typeof block === 'object' && 'text' in block &&
        typeof (block as { text: unknown }).text === 'string'
          ? (block as { text: string }).text
          : '',
      )
      .filter((text) => text.length > 0);
    if (texts.length > 0) {
      return texts.join('\n');
    }
  }
  return stringifyPayload(result?.content);
}

/**
 * Map a single codex ThreadEvent to a disclaude AgentMessage.
 *
 * Returns `null` for events that do not map to a user-visible message.
 * The caller (queryStream bridge) filters nulls. Mapping table:
 *
 * | codex event                                | AgentMessage           |
 * |--------------------------------------------|------------------------|
 * | item.completed / agent_message             | text (full item text) |
 * | item.started  / command_execution          | tool_use (shell)      |
 * | item.completed / command_execution         | tool_result            |
 * | item.started  / mcp_tool_call              | tool_use (server.tool) |
 * | item.completed / mcp_tool_call             | tool_result            |
 * | item.completed / file_change               | tool_result            |
 * | item.completed / web_search                | tool_result            |
 * | item.completed / error item                | status (non-fatal)     |
 * | turn.completed                             | result (turn terminator)|
 * | turn.failed / top-level error              | error                  |
 * | thread.started / turn.started / reasoning  | null                   |
 * | todo_list / item.updated                   | null (MVP, see below)  |
 *
 * Notes:
 * - `agent_message` arrives only as item.completed with the FULL text (0.132.0
 *   emits no partial agent-message deltas in exec --json), so there is one
 *   `text` message per assistant message, not a delta stream.
 * - `reasoning` is internal chain-of-thought — not surfaced (MVP).
 * - `todo_list` progress is noisy in chat; skipped (MVP, revisit with S5).
 * - top-level `error` events include transient reconnect notices
 *   ("Reconnecting… 1/5") that codex itself treats as non-fatal; those map to
 *   `status` so ChatAgent does not surface a scary error card for them.
 * - `turn.completed` carries the per-turn token usage; mapped onto the result
 *   metadata so ChatAgent's completion log has the numbers (no costUsd — a
 *   subscription has no per-call USD price).
 */
export function adaptCodexEvent(event: CodexThreadEvent): AgentMessage | null {
  switch (event.type) {
    // ── agent output ────────────────────────────────────────────────────────
    case 'item.completed': {
      const {item} = event;

      if (isItemEvent(event, 'item.completed', 'agent_message')) {
        return makeMessage('text', item.text ?? '', { messageId: item.id });
      }

      if (isItemEvent(event, 'item.completed', 'command_execution')) {
        const failed = item.status === 'failed' || (item.exit_code ?? 0) !== 0;
        const content = failed
          ? `exit ${item.exit_code ?? '?'}: ${item.aggregated_output ?? ''}`.trim()
          : (item.aggregated_output ?? '').trim();
        return makeMessage('tool_result', content, {
          toolName: 'shell',
          toolOutput: item.aggregated_output,
          messageId: item.id,
        });
      }

      if (isItemEvent(event, 'item.completed', 'mcp_tool_call')) {
        const errMsg = item.error?.message;
        return makeMessage(
          'tool_result',
          errMsg ? `Error: ${errMsg}` : mcpResultText(item.result),
          {
            toolName: `${item.server}.${item.tool}`,
            toolOutput: item.error ?? item.result ?? null,
            messageId: item.id,
          },
        );
      }

      if (isItemEvent(event, 'item.completed', 'file_change')) {
        const changes = item.changes ?? [];
        const content = changes
          .map((c: { path: string; kind: string }) => `${c.kind}: ${c.path}`)
          .join('\n');
        return makeMessage('tool_result', content, {
          toolName: 'file_change',
          toolOutput: changes,
          messageId: item.id,
        });
      }

      if (isItemEvent(event, 'item.completed', 'web_search')) {
        return makeMessage('tool_result', item.query, {
          toolName: 'web_search',
          messageId: item.id,
        });
      }

      // Non-fatal warning item ("command output truncated" etc.)
      if (isItemEvent(event, 'item.completed', 'error')) {
        return makeMessage('status', item.message ?? '', { messageId: item.id });
      }

      return null; // reasoning / todo_list / unknown item types
    }

    case 'item.started': {
      if (isItemEvent(event, 'item.started', 'command_execution')) {
        return makeMessage('tool_use', event.item.command, {
          toolName: 'shell',
          toolInput: event.item.command,
          messageId: event.item.id,
        });
      }
      if (isItemEvent(event, 'item.started', 'mcp_tool_call')) {
        return makeMessage('tool_use', event.item.tool, {
          toolName: `${event.item.server}.${event.item.tool}`,
          toolInput: event.item.arguments,
          messageId: event.item.id,
        });
      }
      return null; // todo_list started / other starts carry no chat payload
    }

    // ── turn lifecycle ──────────────────────────────────────────────────────
    case 'turn.completed': {
      const {usage} = event;
      return makeMessage('result', '', {
        inputTokens: usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      });
    }

    case 'turn.failed': {
      return makeMessage('error', event.error?.message ?? 'codex turn failed');
    }

    case 'error': {
      // Transient reconnect notices are non-fatal per the codex docs —
      // surface as status, everything else as an error message.
      const transient = /^reconnecting/i.test(event.message ?? '');
      return makeMessage(transient ? 'status' : 'error', event.message ?? '');
    }

    // thread.started / turn.started / item.updated / unknown top-level types
    default:
      return null;
  }
}

function makeMessage(
  type: AgentMessageType,
  content: string,
  metadata: AgentMessageMetadata = {},
): AgentMessage {
  return { type, content, role: 'assistant', metadata };
}

/**
 * Extract the plain-text prompt from a UserInput content (string or blocks).
 * Mirrors base-agent's convertInput exactly: strings pass through, anything
 * else is JSON-stringified (in practice base-agent always hands us strings).
 */
export function userInputText(input: UserInputLike): string {
  if (typeof input.content === 'string') {
    return input.content;
  }
  return stringifyPayload(input.content);
}

/** Local structural view of UserInput (avoids importing the SDK type here). */
interface UserInputLike {
  content: string | unknown;
}
