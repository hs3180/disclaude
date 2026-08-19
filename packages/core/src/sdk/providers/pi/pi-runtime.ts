/**
 * Lazy runtime loader for `@earendil-works/pi-agent-core` (Issue #4386, S3 part 3).
 *
 * disclaude takes NO hard dependency on pi-agent-core (the skeleton decision,
 * #4385): the package is probed via `createRequire().resolve()` in
 * `PiAgentProvider.validateConfig()` and only imported here, lazily, when a
 * query actually runs on the pi backend. If the package is absent, the import
 * rejects and `loadPiRuntime()` surfaces a clear, actionable error instead.
 *
 * Source of truth for the shapes below: `@earendil-works/pi-agent-core@0.82.1`
 * (pinned; see #4384 §6 — pre-1.0, re-verify on bump). They are STRUCTURAL
 * MIRRORS of the `.d.ts` surfaces `queryStream` consumes, kept local to this
 * module so provider.ts stays focused on orchestration. Verified against the
 * published tarball (`dist/agent.d.ts`, `dist/types.d.ts`):
 *
 * - `Agent` (dist/agent.d.ts): stateful wrapper — `subscribe(listener)`,
 *   `prompt(msg)`, `followUp(msg)`, `abort()`, `waitForIdle()`, `state`.
 * - `AgentOptions.streamFn` is REQUIRED: the loop makes no model/credential
 *   decisions. Callers inject one (production: pi-ai `Models.streamSimple`;
 *   tests: a scripted faux stream fn).
 * - pi `AgentMessage` = pi-ai `Message` union; a user turn is
 *   `{ role: 'user', content, timestamp }` (types.d.ts:274).
 */

import type { PiAgentEvent } from './event-adapter.js';

/**
 * Structural mirror of pi-agent-core's `Agent` class — only the members
 * `queryStream` drives. `subscribe` returns an unsubscribe fn.
 */
export interface PiAgent {
  subscribe(listener: (event: PiAgentEvent) => Promise<void> | void): () => void;
  prompt(message: unknown): Promise<void>;
  followUp(message: unknown): Promise<void>;
  /** Continue from the current transcript, draining queued follow-ups into a new run. */
  continue(): Promise<void>;
  abort(): void;
  waitForIdle(): Promise<void>;
}

/** Structural mirror of `new Agent(options)`'s relevant option surface. */
export interface PiAgentOptions {
  /** Required by pi — the LLM stream function the loop calls each turn. */
  streamFn: (model: unknown, context: unknown, options?: unknown) => unknown;
  /** Initial transcript (the first user turn). */
  initialState?: {
    systemPrompt?: string;
    messages?: unknown[];
    tools?: unknown[];
  };
  /**
   * Pre-tool-call deny hook (Issue #4389). Optional on pi's side too; the
   * loop invokes it after argument validation and BEFORE execution
   * (`agent-loop.js:405-422`) and converts `{ block: true }` into an error
   * tool result carrying `reason`. Set by the provider from
   * `createPiToolPermissionGate()` when there is anything to deny.
   */
  beforeToolCall?: PiBeforeToolCallHook;
  [key: string]: unknown;
}

/**
 * Structural mirror of pi's `AgentToolCall` content block (pi-ai
 * `ToolCall`, `types.d.ts:244-250`) — only the fields the permission gate
 * reads (`name`).
 */
export interface PiAgentToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Structural mirror of pi's `BeforeToolCallContext` (`types.d.ts:69-79`).
 * `args` carries the schema-validated tool arguments (the seam for a future
 * arg-level policy layer, #4389 later parts); `toolCall.name` is the
 * deny-list key.
 */
export interface PiBeforeToolCallContext {
  assistantMessage: unknown;
  toolCall: PiAgentToolCall;
  args: unknown;
  context: unknown;
}

/** Structural mirror of pi's `BeforeToolCallResult` (`types.d.ts:40-43`). */
export interface PiBeforeToolCallResult {
  block?: boolean;
  reason?: string;
}

/** Structural mirror of pi's `AgentOptions.beforeToolCall` signature. */
export type PiBeforeToolCallHook = (
  context: PiBeforeToolCallContext,
  signal?: AbortSignal,
) => Promise<PiBeforeToolCallResult | undefined>;

/** Type of the `Agent` constructor as exported by pi-agent-core. */
type PiAgentConstructor = new (options: PiAgentOptions) => PiAgent;

/** The (cached) slice of pi-agent-core's module surface this provider uses. */
export interface PiRuntime {
  Agent: PiAgentConstructor;
}

/** The pi-agent-core module specifier (version pinned per #4384 §6). */
const PI_SPECIFIER = '@earendil-works/pi-agent-core';

let runtimePromise: Promise<PiRuntime> | null = null;

/**
 * Build the disclaude-side user message in pi's `AgentMessage` shape.
 * `timestamp` is required on pi-ai messages (types.d.ts:277); the provider
 * stamps it at enqueue time. Content blocks beyond plain text (images) are
 * stringified defensively — the MVP maps text turns (see event-adapter scope).
 */
export function toPiUserMessage(content: string): { role: 'user'; content: string; timestamp: number } {
  return { role: 'user', content, timestamp: Date.now() };
}

/**
 * Dynamically import pi-agent-core and extract the `Agent` constructor.
 *
 * The import result is cached (success AND failure): validateConfig() may
 * probe repeatedly, but the actual module load should happen at most once per
 * process, and a missing package should not trigger a module-not-found storm.
 *
 * @throws Error with an actionable message when the package is not installed.
 */
export function loadPiRuntime(): Promise<PiRuntime> {
  if (!runtimePromise) {
    runtimePromise = (async () => {
      try {
        const mod = (await import(PI_SPECIFIER)) as { Agent?: unknown };
        if (typeof mod.Agent !== 'function') {
          throw new Error(`${PI_SPECIFIER} did not export an Agent constructor`);
        }
        return { Agent: mod.Agent as PiAgentConstructor };
      } catch (err) {
        // Re-wrap so callers always get a clear message, never a raw
        // ERR_MODULE_NOT_FOUND with a specifier stack they must decode.
        const message =
          err instanceof Error && err.message.includes(PI_SPECIFIER)
            ? err.message
            : String(err);
        throw new Error(
          `PiAgentProvider: ${PI_SPECIFIER} is not installed or failed to load (${message}). ` +
            'Install it as a dependency of the host to use the pi backend (see docs/pi-backend.md).',
        );
      }
    })();
  }
  return runtimePromise;
}

/**
 * Test seam: reset the cached runtime so a subsequent `loadPiRuntime()`
 * re-imports. Also lets tests inject a fake module via module mocking.
 */
export function resetPiRuntimeCache(): void {
  runtimePromise = null;
}
