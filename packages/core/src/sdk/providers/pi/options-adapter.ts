/**
 * disclaude `AgentQueryOptions` → pi-agent-core run-options adapter.
 *
 * Issue #4386 (S3, part 2): the pure option mapping the
 * `PiAgentProvider.queryStream` implementation will use to translate
 * disclaude's SDK-agnostic `AgentQueryOptions` into the pieces of pi's
 * per-run options that disclaude can supply declaratively. Extracted as a
 * standalone, fully unit-testable module — companion to `event-adapter.ts`
 * (part 1, #4409) — so the options contract is locked independently of the
 * (still-unimplemented) queryStream wiring (part 3).
 *
 * Source of truth for the pi side: `@earendil-works/pi-agent-core@0.82.1` +
 * `@earendil-works/pi-ai` TypeScript declarations, as recorded in the #4384
 * spike (`docs/pi-agent-core-api-research.md`). The pi type references below
 * cite the 0.82.1 `.d.ts` line numbers; they are a STRUCTURAL description of
 * what the adapter targets, NOT an import — disclaude takes no hard dependency
 * on pi-agent-core (see the PiAgentProvider skeleton, #4385). Re-verify on a
 * pi version bump (cf. #4384 §6: 0.x, pre-1.0; latest observed 0.83.0 while
 * the pin remains 0.82.1).
 *
 * Why pi options are split (unlike Claude's flat options object):
 * - pi's `agentLoop(prompts, context, config, signal, streamFn)`
 *   (`agent-loop.d.ts:12`) takes a per-run **`AgentContext`**
 *   (`{ systemPrompt, messages, tools? }`, `types.d.ts:353`) AND a
 *   **`AgentLoopConfig`** (`{ model, convertToLlm, ... }` + `SimpleStreamOptions`,
 *   `types.d.ts:117`). The higher-level `AgentHarness` further exposes
 *   `setActiveTools(names)` / `setModel(Model)` / `setThinkingLevel(...)`.
 * - Several disclaude options therefore do not become a flat field: `model` is
 *   a string here but pi wants a `Model<any>` resolved through its `Models`
 *   registry (runtime work, deferred to provider.ts part 3); tool *names* map
 *   to `setActiveTools` rather than to a config field.
 *
 * Part-2 scope: the declarative mapping only (systemPrompt / activeToolNames /
 * model-string / env passthrough). The following are intentionally DEFERRED —
 * they are owned by sibling sub-issues or are Claude-specific and have no pi
 * equivalent at this layer:
 * - `model` string → `Model<any>` object: provider.ts (part 3), via pi `Models`.
 * - `mcpServers`: the MCP→`AgentHarnessTool` converter, #4417 (S4b).
 * - `permissionMode` / permission gating: #4389 (S6); pi has no built-in perms
 *   (the `disallowedTools` deny gate itself landed in tool-permission-gate.ts).
 * - Claude-only fields with no pi agentLoop-level meaning: `cwd`, `settingSources`
 *   (required on the disclaude type but a Claude-Code-settings concept),
 *   `stderr` (Claude subprocess capture), `teammateMode` (Claude Agent Teams),
 *   `includePartialMessages` (GLM stall watchdog, #3706), `plugins` (local
 *   Claude plugin, injected in the Claude adapter only).
 */

import type { AgentQueryOptions } from '../../types.js';

// ---------------------------------------------------------------------------
// Structural mirrors of the pi option surfaces the adapter targets.
// Only what is consumed below is mirrored; everything else is intentionally
// dropped to keep the surface small (cf. event-adapter.ts).
// ---------------------------------------------------------------------------

/**
 * The subset of pi's `AgentContext` (`types.d.ts:353`) that disclaude can
 * populate from `AgentQueryOptions`. `messages` are supplied by the caller
 * (provider.ts drives the prompt stream), not by options, so they are absent.
 *
 * NOTE: this interface documents the target shape; `adaptPiOptions` returns
 * `PiAdaptedOptions` (the declarative inputs), which provider.ts will assemble
 * into a real `AgentContext` + tool/model registration at runtime.
 */
export interface PiAgentContextInput {
  /** Maps to `AgentContext.systemPrompt` (`types.d.ts:355`, required string). */
  systemPrompt: string;
}

/**
 * Result of the declarative option mapping. Every field is optional because
 * disclaude options may legitimately omit it (pi defaults then apply).
 */
export interface PiAdaptedOptions {
  /**
   * Resolved from `options.systemPrompt`.
   *
   * - A plain string is taken verbatim.
   * - A `{ type: 'preset', preset: 'claude_code', append? }` cannot be honored
   *   literally on the pi backend (it is a Claude Code concept); only the
   *   optional `append` tail is portable and is returned when present.
   * - Absent → `undefined` (provider.ts supplies the pi default system prompt).
   */
  systemPrompt?: string;

  /**
   * Resolved from `options.allowedTools` / `options.tools` (string-array form
   * only) minus `options.disallowedTools`. Maps to pi's
   * `AgentHarness.setActiveTools(names)` selection — NOT to a config field.
   *
   * A `ToolsPreset` (`{ type: 'preset', preset: 'claude_code' }`) is not
   * portable to pi and is ignored (returns `undefined`); the provider supplies
   * a default tool set.
   */
  activeToolNames?: string[];

  /**
   * `options.model` (string) passed through unchanged. pi needs a `Model<any>`
   * resolved through its `Models` registry — that resolution is runtime work
   * for provider.ts (part 3). Carried here so the contract is locked now.
   */
  model?: string;

  /**
   * `options.env` passed through. pi's `agentLoop` has no env field; provider.ts
   * may feed relevant entries (e.g. API keys) to the stream function / transport.
   */
  env?: Record<string, string | undefined>;
}

/**
 * Adapt disclaude `AgentQueryOptions` into the declarative pi run-option inputs.
 *
 * Pure function: no I/O, no throws for any valid `AgentQueryOptions` value —
 * unresolvable inputs (Claude-specific presets) yield `undefined` fields rather
 * than errors, so the caller can fall back to pi defaults.
 *
 * @param options - disclaude unified query options (`types.ts` `AgentQueryOptions`).
 * @returns the pi-relevant subset (system prompt / active tool names / model
 *   string / env); see `PiAdaptedOptions` for the deferred-items contract.
 */
export function adaptPiOptions(options: AgentQueryOptions): PiAdaptedOptions {
  return {
    systemPrompt: resolveSystemPrompt(options),
    activeToolNames: resolveActiveToolNames(options),
    model: options.model,
    env: options.env,
  };
}

/**
 * Resolve a portable system prompt from the disclaude option.
 *
 * - plain string → verbatim
 * - claude_code preset → only the `append` tail is portable (if any)
 * - absent → undefined
 */
function resolveSystemPrompt(options: AgentQueryOptions): string | undefined {
  const sp = options.systemPrompt;
  if (sp === undefined) {
    return undefined;
  }
  if (typeof sp === 'string') {
    return sp;
  }
  // SystemPromptPreset: { type: 'preset', preset: 'claude_code', append? }
  // The preset itself is a Claude Code concept; only `append` carries over.
  return sp.append;
}

/**
 * Resolve the active tool-name list from the disclaude tool options.
 *
 * Precedence: `allowedTools` (explicit allowlist) wins over a string-array
 * `tools`. A `ToolsPreset` is not portable to pi and contributes nothing.
 * `disallowedTools` are subtracted from whichever base was chosen.
 */
function resolveActiveToolNames(options: AgentQueryOptions): string[] | undefined {
  const base = pickToolBase(options);
  if (base === undefined) {
    return undefined;
  }
  const disallowed = options.disallowedTools;
  if (!disallowed || disallowed.length === 0) {
    return base;
  }
  const deny = new Set(disallowed);
  const filtered = base.filter((name) => !deny.has(name));
  return filtered;
}

/**
 * Pick the base tool-name list before disallowed-subtraction.
 * Returns `undefined` when no portable (string-array) tool source is present.
 */
function pickToolBase(options: AgentQueryOptions): string[] | undefined {
  if (Array.isArray(options.allowedTools) && options.allowedTools.length > 0) {
    return [...options.allowedTools];
  }
  const { tools } = options;
  if (Array.isArray(tools) && tools.length > 0) {
    return [...tools];
  }
  // tools = ToolsPreset ({ type: 'preset', preset: 'claude_code' }) is not
  // portable to pi → no base; provider supplies a default tool set.
  return undefined;
}
