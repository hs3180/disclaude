/**
 * Permission gate for the pi backend (Issue #4389, S6 — part 1).
 *
 * pi has **no built-in permission system**: it inherits the launcher's OS
 * permissions and never prompts, denies, or logs a permission decision (see
 * docs/pi-permission-gating-research.md, C-Q2). With `agentBackend = pi`,
 * disclaude must therefore be the **sole permission authority** — the gate has
 * to live in disclaude-owned code that every tool invocation routes through.
 *
 * Per the 2026-08-07 MCP-removal decision (#4383), the pi backend has exactly
 * ONE tool injection point: the inline-tool adapter (#4387,
 * `inline-tool-adapter.ts`). The part-3 addendum of the research doc states the
 * invariant this module serves: *the inline-tool adapter must route every
 * tool's `execute` through the gate* — no tool reaches the OS/browser
 * ungated.
 *
 * Part-1 scope (this file): the gate **mechanism** — a pure, decision-only
 * interface + a denylist policy fed by the existing `AgentQueryOptions.
 * disallowedTools` option (no new config surface). Which policy paradigm(s)
 * disclaude ultimately installs (allowlist / arg-level / ExecutionEnv sandbox
 * — the C1/C2/C3 selection of #4432) is deliberately NOT decided here: any of
 * them implements this same interface, so the enforcement seam stays stable.
 *
 * Pure functions/objects only — no I/O, no clock, no globals — so the deny
 * path is unit-testable without pi-agent-core installed.
 */

/**
 * A tool call the gate is asked about. `args` is the raw (pre-Zod-validation)
 * parameter object pi is about to pass to `execute` — an arg-level policy can
 * inspect WHICH bash command / URL is being run, not just the tool name.
 */
export interface PiToolCallRequest {
  /** Tool name as registered with pi (the `InlineToolDefinition.name`). */
  toolName: string;
  /** Raw tool arguments (schema validation happens after the gate). */
  args: unknown;
}

/**
 * The gate's verdict. A deny MUST carry a human/model-readable reason — it
 * becomes the error text the model sees (pi converts a thrown execute error
 * into an `isError` tool result from the message).
 */
export type PiPermissionDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * disclaude-owned permission gate for pi-path tool calls.
 *
 * Implementations must be synchronous-safe and side-effect-free (the adapter
 * calls `decide` on every tool execution; a throwing or slow gate degrades
 * every call). Audit logging, if wanted, belongs to the wiring layer, not to
 * `decide`.
 */
export interface PiPermissionGate {
  decide(request: PiToolCallRequest): PiPermissionDecision;
}

/**
 * Pass-through gate: allows everything. The default when no policy is
 * installed — matches the pre-#4389 behavior so the seam is opt-in.
 */
export const ALLOW_ALL_GATE: PiPermissionGate = {
  decide: () => ({ allowed: true }),
};

/**
 * Exact-match denylist gate, fed by `AgentQueryOptions.disallowedTools`.
 *
 * Matching semantics mirror the tool-name subtraction the pi options-adapter
 * already performs (`options-adapter.ts`: `new Set(disallowed)` + exact
 * `deny.has(name)`) — the enumeration filter decides which tools the model is
 * OFFERED; this gate independently enforces the same list at execution time.
 * The two layers compose: a tool removed from the active set is never called,
 * and (defense-in-depth) a tool that reaches `execute` anyway is denied here.
 *
 * Empty list → allows everything (identical to {@link ALLOW_ALL_GATE}, but as
 * a fresh instance so callers can layer policies without sharing state).
 */
export function createDenylistGate(disallowedTools: readonly string[]): PiPermissionGate {
  const deny = new Set(disallowedTools);
  return {
    decide: ({ toolName }: PiToolCallRequest): PiPermissionDecision => {
      if (deny.has(toolName)) {
        return {
          allowed: false,
          reason: `tool "${toolName}" is in the disallowedTools denylist`,
        };
      }
      return { allowed: true };
    },
  };
}

/**
 * Compose gates left-to-right: the FIRST deny wins; allow only if every gate
 * allows. Lets the wiring layer stack policies (e.g. a denylist + a future
 * arg-level policy) without either one knowing about the other.
 */
export function composeGates(...gates: PiPermissionGate[]): PiPermissionGate {
  return {
    decide: (request: PiToolCallRequest): PiPermissionDecision => {
      for (const gate of gates) {
        const decision = gate.decide(request);
        if (!decision.allowed) {
          return decision;
        }
      }
      return { allowed: true };
    },
  };
}
