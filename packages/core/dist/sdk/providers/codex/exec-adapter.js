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
/**
 * Classify a JSONL event before it is adapted for a channel.
 *
 * Keeping this decision separate from the payload adapter prevents a future
 * Codex event from accidentally becoming chat text merely because it happens
 * to contain a `text` field. In particular, reasoning/context construction
 * and lifecycle events remain available to logs without leaking to users.
 */
export function classifyCodexEvent(event) {
    switch (event.type) {
        case 'thread.started':
        case 'turn.started':
            return 'telemetry-only';
        case 'turn.completed':
            return 'user-visible';
        case 'turn.failed':
        case 'error':
            return 'user-visible';
        case 'item.started':
        case 'item.completed': {
            const itemType = event.item?.type;
            if (itemType === 'reasoning' || itemType === 'todo_list') {
                return 'internal';
            }
            if (itemType === 'agent_message' ||
                itemType === 'command_execution' ||
                itemType === 'mcp_tool_call' ||
                itemType === 'file_change' ||
                itemType === 'web_search' ||
                itemType === 'error') {
                return 'user-visible';
            }
            return 'ignored';
        }
        case 'item.updated':
            return 'telemetry-only';
        default:
            return 'ignored';
    }
}
/**
 * Is this event an item.* event carrying the given item type?
 * Narrows the catch-all without asserting exhaustiveness.
 */
function isItemEvent(event, phase, itemType) {
    return event.type === phase && typeof event.item === 'object' &&
        event.item !== null && event.item.type === itemType;
}
/** Utility: stringify a tool payload for the AgentMessage content. */
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
/**
 * Render a successful MCP tool payload for the tool_result content: content
 * blocks' text parts joined by newline; anything else (missing, non-array,
 * exotic blocks) falls back to JSON stringification (S2 review).
 */
function mcpResultText(result) {
    if (Array.isArray(result?.content)) {
        const texts = result.content
            .map((block) => block !== null && typeof block === 'object' && 'text' in block &&
            typeof block.text === 'string'
            ? block.text
            : '')
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
export function adaptCodexEvent(event) {
    // The classifier is deliberately consulted here as the final safety net;
    // callers may use it independently for telemetry, but no internal/unknown
    // event can become user-facing through this adapter.
    const presentation = classifyCodexEvent(event);
    if (presentation === 'internal' || presentation === 'ignored' || presentation === 'telemetry-only') {
        return null;
    }
    switch (event.type) {
        // ── agent output ────────────────────────────────────────────────────────
        case 'item.completed': {
            const { item } = event;
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
                return makeMessage('tool_result', errMsg ? `Error: ${errMsg}` : mcpResultText(item.result), {
                    toolName: `${item.server}.${item.tool}`,
                    toolOutput: item.error ?? item.result ?? null,
                    messageId: item.id,
                });
            }
            if (isItemEvent(event, 'item.completed', 'file_change')) {
                const changes = item.changes ?? [];
                const content = changes
                    .map((c) => `${c.kind}: ${c.path}`)
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
            const { usage } = event;
            return makeMessage('result', '', {
                inputTokens: usage?.input_tokens,
                outputTokens: usage?.output_tokens,
            });
        }
        case 'turn.failed': {
            const message = event.error?.message ?? 'codex turn failed';
            // Limit wording → null: the provider's friendly notice covers it
            // (same dedupe rationale as the top-level error case, S5 review).
            if (isCodexUsageLimit(message)) {
                return null;
            }
            return makeMessage('error', message);
        }
        case 'error': {
            // Transient reconnect notices are non-fatal per the codex docs →
            // status. Usage-limit events return NULL (S5 review): the provider
            // synthesizes the FRIENDLY degrade from raw text collected in
            // enqueue (independent of adapter output), and a status mapping still
            // duplicated it — ChatAgent sendMessage's status messages too.
            const message = event.message ?? '';
            if (isCodexUsageLimit(message)) {
                return null;
            }
            const transient = /^reconnecting/i.test(message);
            return makeMessage(transient ? 'status' : 'error', message);
        }
        // thread.started / turn.started / item.updated / unknown top-level types
        default:
            return null;
    }
}
function makeMessage(type, content, metadata = {}) {
    return { type, content, role: 'assistant', metadata };
}
// ---------------------------------------------------------------------------
// Failure-signature detection (Issue #4628, S3) — pure text predicates over
// the two failure surfaces the bridge sees (top-level `error` event messages
// + turn.failed messages on stdout, and the stderr tail). Signatures captured
// live against codex-cli 0.132.0; detection is deliberately substring-based
// so wording drift degrades to the generic error path, never a false match.
// ---------------------------------------------------------------------------
/**
 * Auth failure ⇔ the ChatGPT login is gone/expired and `codex login` must be
 * re-run. Captured surfaces (0.132.0, auth removed):
 * - stdout error events: "Reconnecting... 2/5 (unexpected status 401
 *   Unauthorized: Missing bearer or basic authentication in header, url:
 *   wss://api.openai.com/v1/responses, cf-ray: …)"
 * - stderr: "ERROR codex_api::endpoint::responses_websocket: failed to
 *   connect to websocket: HTTP error: 401 Unauthorized, url: …"
 *
 * Refresh-token expiry funnels to the same 401 surface; explicit
 * token/session-expired wording is matched as a belt-and-braces fallback.
 */
export function isCodexAuthFailure(text) {
    if (/\b401\b/.test(text) && /unauthorized/i.test(text)) {
        return true;
    }
    return /token[ _-]?expir/i.test(text) || /session expired/i.test(text);
}
/**
 * Resume target missing ⇔ the thread rollout file codex would resume no
 * longer exists (session pruned/rotated on codex's side, CODEX_HOME wiped,
 * …). Captured (0.132.0): stderr "Error: thread/resume: thread/resume
 * failed: no rollout found for thread id <uuid> (code -32600)", exit 1.
 * The provider clears its resume target on this signature so the NEXT turn
 * starts a fresh session instead of bricking the chat until /reset.
 */
export function isCodexResumeTargetMissing(text) {
    return /no rollout found for thread/i.test(text);
}
/**
 * Usage limit exhausted ⇔ the ChatGPT plan's rolling-window quota (5h +
 * weekly) is spent; recovers by itself when the window resets. Official
 * wording (multiple OpenAI issues/reports, cross-checked 2026-08-29):
 *   "You've hit your usage limit. Try again at Apr 30th, 2026 11:21 AM"
 *   "… Upgrade to Plus to continue using Codex …"
 * The bare phrase "usage limit" also appears in unrelated exit noise (e.g.
 * a user's own stderr), so the fallback arm requires a recovery/escalation
 * cue ("try again" / "resets" / "upgrade") alongside it — the S2-era
 * provider test uses "usage limit reached" stderr deliberately and must
 * keep hitting the GENERIC exit mapping, not this one.
 */
export function isCodexUsageLimit(text) {
    if (/you'?ve hit your usage limit/i.test(text)) {
        return true;
    }
    // Proximity window (S5 review): both cues must sit in the SAME sentence
    // (~120 chars) — "usage limit" on one line and "upgrade" 8KB later is
    // noise, and argparse's "usage:" prefix must not pair with stray digits.
    if (/usage limit[^.\n]{0,120}(try again|resets?|upgrade)/i.test(text)) {
        return true;
    }
    if (/(try again|resets?|upgrade)[^.\n]{0,120}usage limit/i.test(text)) {
        return true;
    }
    // 429 must co-occur with rate-limit wording in the same sentence — a
    // bare "processed 429 records" is not a quota signal.
    return /\b429\b[^.\n]{0,80}rate.?limit/i.test(text) ||
        /rate.?limit[^.\n]{0,80}\b429\b/i.test(text);
}
/**
 * Extract the plain-text prompt from a UserInput content (string or blocks).
 * Mirrors base-agent's convertInput exactly: strings pass through, anything
 * else is JSON-stringified (in practice base-agent always hands us strings).
 */
export function userInputText(input) {
    if (typeof input.content === 'string') {
        return input.content;
    }
    return stringifyPayload(input.content);
}
