/**
 * pi-path tool permission gate (Issue #4389, part 1 — deny-list layer).
 *
 * Threat model (#4383 §5 / #4432): pi has NO built-in permission system —
 * it inherits the launcher's OS permissions and never prompts, denies, or
 * logs a permission decision. With `agentBackend = pi`, disclaude is the
 * sole permission authority, so the gate must live in disclaude-owned code
 * that EVERY tool invocation routes through.
 *
 * Mechanism (research lean, #4432 parts 2–5, all reinforced): pi-agent-core
 * exposes a native pre-tool-call deny hook — `AgentOptions.beforeToolCall`
 * (`agent.d.ts:13`), invoked by the loop after argument validation and
 * BEFORE execution (`agent-loop.js:405-422`): returning `{ block: true }`
 * prevents execution and the loop emits an error tool result carrying
 * `reason`. Because pi will not support MCP (2026-08-07 decision, #4417
 * closed won't-do), inline tools (#4387) are the ONLY tool path on the pi
 * backend — one hook covers the entire surface.
 *
 * Part-1 scope — the decision layer is the existing disclaude-owned
 * deny-list (`AgentQueryOptions.disallowedTools`, fed by
 * `buildDisallowedTools()` #4181 on every chat-agent query): a tool call is
 * blocked iff its tool name is in that list. Exact-name matching, same
 * semantics as the Claude path's `disallowedTools` hand-off. Later parts of
 * #4389 (after #4432's final C1/C2/C3 call) may widen the decision to
 * arg-level inspection — `BeforeToolCallContext.args` already carries the
 * schema-validated arguments, so the hook seam does not change.
 *
 * This hook is the SINGLE permission gate on the pi path. An earlier
 * execute-level gate (#4538: `PiPermissionGate` consulted inside
 * `adaptInlineTool`, installed as provider-instance state) was removed in
 * favor of this one seam: the two enforced the SAME denylist with the same
 * semantics, and the hook alone gets both properties the execute gate
 * lacked — per-query scoping (the hook rides each query's own Agent
 * instance; the provider is a process-wide cached singleton whose mutable
 * gate field let interleaved queries overwrite each other's denylist) and
 * full coverage (every tool call the loop makes, not only inline-adapted
 * ones). A direct call to a tool's `execute` bypassing the loop — the one
 * path the execute gate additionally covered — does not exist in disclaude.
 *
 * Pure module: no I/O, injectable, fully unit-testable (the deny path —
 * #4389 acceptance item 2 — is asserted in `tool-permission-gate.test.ts`).
 */

import type { AgentQueryOptions } from '../../types.js';
import type { PiBeforeToolCallContext, PiBeforeToolCallResult } from './pi-runtime.js';

/**
 * A pi `beforeToolCall`-shaped deny hook.
 *
 * Returns `{ block: true, reason }` to DENY the call (pi converts it to an
 * error tool result the model sees), or `undefined` to allow it through.
 * Async because pi's hook signature is (pi awaits it in-loop); the decision
 * itself is synchronous.
 */
export type PiToolPermissionGate = (
  context: PiBeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<PiBeforeToolCallResult | undefined>;

/** The deny decision — a pure function over the tool name. */
function decideDeny(name: string, deny: ReadonlySet<string>): PiBeforeToolCallResult | undefined {
  if (deny.has(name)) {
    return {
      block: true,
      reason:
        `Tool "${name}" is disallowed by disclaude's permission policy ` +
        '(pi backend gate, #4389)',
    };
  }
  return undefined;
}

/**
 * Build the tool permission gate from disclaude's query options.
 *
 * Returns `null` when there is nothing to deny (`disallowedTools` absent or
 * empty) so the provider can omit the hook entirely and today's behavior
 * stays bit-identical; otherwise returns a hook that blocks exactly the
 * disallowed tool names (exact-match, like the Claude path).
 */
export function createPiToolPermissionGate(
  options: Pick<AgentQueryOptions, 'disallowedTools'>,
): PiToolPermissionGate | null {
  const deny = new Set(options.disallowedTools ?? []);
  if (deny.size === 0) {
    return null;
  }
  return (context, signal) =>
    Promise.resolve().then(() => {
      if (signal?.aborted) {
        // The loop handles abort itself; do not emit a spurious deny reason.
        return undefined;
      }
      const name = context?.toolCall?.name;
      if (typeof name === 'string') {
        return decideDeny(name, deny);
      }
      return undefined;
    });
}
