/** Runtime profile declarations for chat creation (Issue #4913). */

import type { AgentPreset, AgentPresets, CodexReasoningEffort } from './types.js';
import { isCodexReasoningEffort } from './codex-settings.js';

const VALID_BACKENDS = new Set<AgentPreset['agentBackend']>(['claude', 'pi', 'codex', 'dsh']);
const CODEX_MODEL_PATTERN = /^gpt-\d+(?:[.-].+)/i;
const DECLARATION_KEYS = new Set(['preset', 'harness', 'model', 'thinking']);

/**
 * A runtime profile declared when a chat/group is created. Exactly one form:
 * a named preset from the configured enabled catalog, or an explicit
 * {harness, model, thinking} triple. Credentials and endpoints are never
 * accepted — the explicit form is always backed by a catalog preset.
 */
export interface RuntimeProfileDeclaration {
  preset?: string;
  harness?: string;
  model?: string;
  thinking?: string;
}

export type RuntimeProfileResolution =
  | {
      ok: true;
      /** Catalog preset that supplies provider settings/credentials. */
      presetName: string;
      preset: AgentPreset;
      /** Creation-time overrides applied on top of the catalog preset. */
      overrides?: { model?: string; reasoningEffort?: CodexReasoningEffort };
    }
  | { ok: false; error: string; options?: string[] };

/** Strictly parse a raw declaration value; rejects unknown keys (no credentials/endpoints). */
export function parseRuntimeProfileDeclaration(value: unknown): RuntimeProfileDeclaration | undefined {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('runtime must be an object with preset or harness/model/thinking');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const unknown = entries.filter(([key]) => !DECLARATION_KEYS.has(key)).map(([key]) => key);
  if (unknown.length > 0) {
    throw new Error(`runtime declares unsupported field(s): ${unknown.join(', ')}; only preset or harness/model/thinking are accepted (never credentials or endpoints)`);
  }
  const declaration: RuntimeProfileDeclaration = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`runtime.${key} must be a non-empty string`);
    }
    declaration[key as keyof RuntimeProfileDeclaration] = raw.trim();
  }
  if (entries.length === 0) {
    throw new Error('runtime must declare a preset or an explicit harness/model/thinking');
  }
  return declaration;
}

/**
 * Resolve a creation-time declaration against the configured enabled preset
 * catalog. Validation is strict and actionable: an unsupported combination
 * fails with the available options instead of silently degrading to another
 * harness, model or effort.
 */
export function resolveRuntimeProfile(
  agents: AgentPresets,
  declaration: RuntimeProfileDeclaration
): RuntimeProfileResolution {
  const names = Object.keys(agents);
  if (declaration.preset !== undefined) {
    if (declaration.harness !== undefined || declaration.model !== undefined || declaration.thinking !== undefined) {
      return { ok: false, error: 'runtime cannot combine a named preset with explicit harness/model/thinking; declare one form' };
    }
    const preset = agents[declaration.preset];
    return preset
      ? { ok: true, presetName: declaration.preset, preset }
      : { ok: false, error: `Unknown agent preset: ${declaration.preset}`, options: names };
  }

  const {harness} = declaration;
  if (harness === undefined) {
    return { ok: false, error: 'runtime must declare a preset or a harness' };
  }
  if (!VALID_BACKENDS.has(harness as AgentPreset['agentBackend'])) {
    return { ok: false, error: `Unsupported harness: ${harness}`, options: [...VALID_BACKENDS] };
  }
  // Only the codex runtime applies a reasoning effort; refuse instead of
  // silently ignoring the requested thinking on other harnesses (#4913).
  if (declaration.thinking !== undefined) {
    if (harness !== 'codex') {
      return { ok: false, error: `Harness ${harness} does not support a thinking level; only codex applies one`, options: ['codex'] };
    }
    if (!isCodexReasoningEffort(declaration.thinking)) {
      return { ok: false, error: `Invalid thinking level: ${declaration.thinking}`, options: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
    }
  }
  const {model} = declaration;
  if (model === undefined) {
    return { ok: false, error: `An explicit runtime must declare a model for harness ${harness}; no fallback model is applied` };
  }
  if (harness === 'codex' && !CODEX_MODEL_PATTERN.test(model)) {
    return { ok: false, error: `Model ${model} is not a Codex/ChatGPT model identifier`, options: undefined };
  }

  // The explicit triple borrows credentials/provider settings from a catalog
  // preset of the same harness. Deterministic base: the validated default
  // preset when it matches, else the first catalog entry in declaration order.
  const [base] =
    names
      .filter((name) => agents[name].agentBackend === harness)
      .sort((a, b) => Number(b === 'default' || agents[b].default === true) - Number(a === 'default' || agents[a].default === true));
  if (base === undefined) {
    return { ok: false, error: `No enabled agent preset provides the ${harness} harness; add one to the agents: map first`, options: names };
  }
  return {
    ok: true,
    presetName: base,
    preset: agents[base],
    overrides: {
      ...(model !== undefined ? { model } : {}),
      ...(declaration.thinking !== undefined && isCodexReasoningEffort(declaration.thinking)
        ? { reasoningEffort: declaration.thinking }
        : {}),
    },
  };
}
