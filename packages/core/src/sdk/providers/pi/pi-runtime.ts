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

/**
 * Structural mirror of `new Agent(options)`'s relevant option surface.
 *
 * `initialState.tools` (Issue #4386 part 4, inline-tool injection): the Agent
 * constructor passes `initialState` to `createMutableAgentState()` (agent.js:26),
 * which seeds the state's tool registry from `initialState.tools` — verified
 * against the published 0.82.1 tarball. Tools passed here are live for every
 * run of the session; the Agent class itself has no separate registry call
 * (`setTools` lives on AgentHarness, a different entrypoint this provider
 * does not use).
 */
export interface PiAgentOptions {
  /** Required by pi — the LLM stream function the loop calls each turn. */
  streamFn: (model: unknown, context: unknown, options?: unknown) => unknown;
  /** Initial transcript (the first user turn) + the session's tool registry. */
  initialState?: {
    model?: unknown;
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
  signal?: AbortSignal
) => Promise<PiBeforeToolCallResult | undefined>;

/**
 * Structural mirror of pi's native `Skill` (0.83.0 `dist/harness/types.d.ts`:
 * agentskills.io-shaped). Only the fields the provider consumes through
 * `formatSkillsForSystemPrompt` are mirrored; pi owns the wording and the XML
 * schema of the rendered block.
 */
export interface PiNativeSkill {
  name: string;
  description: string;
  content: string;
  /** Absolute path; pi surfaces it as the model-visible skill location. */
  filePath: string;
  disableModelInvocation?: boolean;
}

/** Structural mirror of pi's `SkillDiagnostic` (currently warnings only). */
export interface PiSkillLoadDiagnostic {
  type: 'warning';
  code: string;
  message: string;
  path: string;
}

/**
 * Structural mirror of pi's native skills channel — `loadSkills`
 * (`dist/harness/skills.ts`, recursive SKILL.md discovery) and
 * `formatSkillsForSystemPrompt` (`dist/harness/system-prompt.ts`, the
 * spec-compatible system prompt block pi tells applications to compose;
 * `AgentHarnessOptions.systemPrompt` is a resources-aware callback of the
 * same shape). Verified present in @earendil-works/pi-agent-core@0.83.0.
 */
export interface PiNativeSkillsChannel {
  loadSkills(
    env: unknown,
    dirs: string | string[]
  ): Promise<{ skills: PiNativeSkill[]; diagnostics: PiSkillLoadDiagnostic[] }>;
  formatSkillsForSystemPrompt(skills: PiNativeSkill[]): string;
}

/** The slice of pi's `NodeExecutionEnv` (`/node` subentry) the channel needs. */
export interface PiExecutionEnv {
  cleanup(): Promise<void>;
}

/** Type of the `Agent` constructor as exported by pi-agent-core. */
type PiAgentConstructor = new (options: PiAgentOptions) => PiAgent;

/** The (cached) slice of pi-agent-core's module surface this provider uses. */
export interface PiRuntime {
  Agent: PiAgentConstructor;
  /**
   * pi's native skills channel, when the installed runtime exposes it
   * (verified in 0.83.0). Absent on older runtimes — the provider then fails
   * explicitly when an installed skill source cannot be delivered natively.
   */
  skills?: PiNativeSkillsChannel;
  /**
   * `NodeExecutionEnv` from the optional `/node` subentry (the node
   * `ExecutionEnv` implementation `loadSkills` consumes). Absent when the
   * installed runtime predates the subentry.
   */
  ExecutionEnv?: new (options: { cwd: string }) => PiExecutionEnv;
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
export function toPiUserMessage(content: string): {
  role: 'user';
  content: string;
  timestamp: number;
} {
  return { role: 'user', content, timestamp: Date.now() };
}

/**
 * Dynamically import pi-agent-core and extract the runtime slice: the `Agent`
 * constructor plus, when the installed version exports them, pi's native
 * skills channel (`loadSkills` + `formatSkillsForSystemPrompt`) and the
 * `/node` subentry's `NodeExecutionEnv` (verified in 0.83.0; pre-0.83.0
 * runtimes simply leave them absent and the provider's capability probe
 * reports the gap explicitly).
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
      let mod: Record<string, unknown>;
      try {
        mod = (await import(PI_SPECIFIER)) as Record<string, unknown>;
        if (typeof mod.Agent !== 'function') {
          throw new Error(`${PI_SPECIFIER} did not export an Agent constructor`);
        }
      } catch (err) {
        // Re-wrap so callers always get a clear message, never a raw
        // ERR_MODULE_NOT_FOUND with a specifier stack they must decode.
        const message =
          err instanceof Error && err.message.includes(PI_SPECIFIER) ? err.message : String(err);
        throw new Error(
          `PiAgentProvider: ${PI_SPECIFIER} is not installed or failed to load (${message}). ` +
            'Install it as a dependency of the host to use the pi backend (see docs/pi-backend.md).'
        );
      }
      const runtime: PiRuntime = { Agent: mod.Agent as PiAgentConstructor };
      // Native skills channel: extracted only when the installed runtime
      // exports the whole surface — a partial surface stays absent so the
      // provider's capability probe fails explicitly, never half-works.
      if (
        typeof mod.loadSkills === 'function' &&
        typeof mod.formatSkillsForSystemPrompt === 'function'
      ) {
        runtime.skills = {
          loadSkills: mod.loadSkills as PiNativeSkillsChannel['loadSkills'],
          formatSkillsForSystemPrompt:
            mod.formatSkillsForSystemPrompt as PiNativeSkillsChannel['formatSkillsForSystemPrompt'],
        };
      }
      try {
        const node = (await import(`${PI_SPECIFIER}/node`)) as {
          NodeExecutionEnv?: unknown;
        };
        if (typeof node.NodeExecutionEnv === 'function') {
          runtime.ExecutionEnv = node.NodeExecutionEnv as PiRuntime['ExecutionEnv'];
        }
      } catch {
        // Optional `/node` subentry: absent on runtimes that predate it or do
        // not export it; the capability probe handles the gap explicitly.
      }
      return runtime;
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
