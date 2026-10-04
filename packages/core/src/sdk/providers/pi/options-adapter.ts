/** Map shared query values to Pi; tool registration stays in its adapter. */

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
 * @returns the pi-relevant subset (system prompt / model
 *   string / env); see `PiAdaptedOptions` for the deferred-items contract.
 */
export function adaptPiOptions(options: AgentQueryOptions): PiAdaptedOptions {
  return {
    systemPrompt: resolveSystemPrompt(options),
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
