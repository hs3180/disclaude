/** Runtime profile declarations for chat creation (Issue #4913). */

import type { AgentPreset, AgentPresets, CodexReasoningEffort } from './types.js';
import { isCodexReasoningEffort } from './codex-settings.js';

const VALID_BACKENDS = new Set<AgentPreset['agentBackend']>(['claude', 'pi', 'codex', 'dsh']);
const CODEX_MODEL_PATTERN = /^gpt-\d+(?:[.-].+)/i;
const DECLARATION_KEYS = new Set(['harness', 'model', 'reasoningEffort']);
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** The only accepted creation-time declaration surface. */
export interface RuntimeProfileDeclaration {
  harness?: string;
  model?: string;
  reasoningEffort?: string;
}

export type RuntimeProfileResolution =
  | {
      ok: true;
      /** Internal credential/store base; never part of the declaration API. */
      base: { presetName: string; preset: AgentPreset };
      overrides: { model: string; reasoningEffort?: CodexReasoningEffort };
    }
  | { ok: false; error: string; options?: string[] };

/** Strictly parse a declaration; credentials, endpoints and legacy aliases are rejected. */
export function parseRuntimeProfileDeclaration(value: unknown): RuntimeProfileDeclaration | undefined {
  if (value === undefined || value === null) { return undefined; }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('runtime must be an object declaring harness/model/reasoningEffort');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const unknown = entries.filter(([key]) => !DECLARATION_KEYS.has(key)).map(([key]) => key);
  if (unknown.length > 0) {
    throw new Error(`runtime declares unsupported field(s): ${unknown.join(', ')}; only harness/model/reasoningEffort are accepted (preset and thinking are rejected; credentials and endpoints are never accepted)`);
  }
  const declaration: RuntimeProfileDeclaration = {};
  for (const [key, raw] of entries) {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error(`runtime.${key} must be a non-empty string`);
    }
    declaration[key as keyof RuntimeProfileDeclaration] = raw.trim();
  }
  if (entries.length === 0) {
    throw new Error('runtime must declare harness/model/reasoningEffort');
  }
  return declaration;
}

/** Validate the explicit runtime and select its internal credential/store base. */
export function resolveRuntimeProfile(
  agents: AgentPresets,
  declaration: RuntimeProfileDeclaration
): RuntimeProfileResolution {
  const names = Object.keys(agents);
  const { harness, model, reasoningEffort } = declaration;
  if (harness === undefined) {
    return { ok: false, error: 'runtime must declare a harness' };
  }
  if (!VALID_BACKENDS.has(harness as AgentPreset['agentBackend'])) {
    return { ok: false, error: `Unsupported harness: ${harness}`, options: [...VALID_BACKENDS] };
  }
  if (model === undefined) {
    return { ok: false, error: `An explicit runtime must declare a model for harness ${harness}; no fallback model is applied` };
  }
  if (harness === 'codex' && !CODEX_MODEL_PATTERN.test(model)) {
    return { ok: false, error: `Model ${model} is not a Codex/ChatGPT model identifier` };
  }
  if (reasoningEffort !== undefined) {
    if (harness !== 'codex') {
      return { ok: false, error: `Harness ${harness} does not support a reasoning effort; only codex applies one`, options: ['codex'] };
    }
    if (!isCodexReasoningEffort(reasoningEffort)) {
      return { ok: false, error: `Invalid reasoning effort: ${reasoningEffort}`, options: REASONING_EFFORTS };
    }
  }

  // Credentials come only from an enabled agent for the requested harness.
  // Prefer its default, otherwise use declaration order deterministically.
  const [base] = names
    .filter((name) => agents[name].agentBackend === harness)
    .sort((a, b) => Number(b === 'default' || agents[b].default === true) - Number(a === 'default' || agents[a].default === true));
  if (base === undefined) {
    return { ok: false, error: `No enabled agent provides the ${harness} harness; configure and enable one first`, options: names };
  }
  return {
    ok: true,
    base: { presetName: base, preset: agents[base] },
    overrides: {
      model,
      ...(reasoningEffort !== undefined && isCodexReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}),
    },
  };
}
