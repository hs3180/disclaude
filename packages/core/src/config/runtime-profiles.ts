/** Runtime declarations for chat creation (Issue #4913): expressed on the
 * AgentRuntime ports (#5255), never on the retired preset surface. */

import type { AgentRuntime, AgentRuntimes, ReasoningEffort } from './types.js';
import { isReasoningEffort } from './codex-settings.js';
import { isValidModelForBackend, resolveDefaultAgentRuntime, SWITCHABLE_BACKENDS } from './agent-runtime.js';

/** Harness domain shared with `/agent backend` (#5255), so creation cannot
 * declare a harness the session cannot switch to. */
const VALID_BACKENDS = new Set<AgentRuntime['agentBackend']>(SWITCHABLE_BACKENDS);
/** Harnesses whose runtimes can apply a reasoning effort; a capability list, not a codex special case. */
const EFFORT_CAPABLE_HARNESSES = new Set<string>(['codex']);
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
      base: { presetName: string; preset: AgentRuntime };
      overrides: { model: string; reasoningEffort?: ReasoningEffort };
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
  agents: AgentRuntimes,
  declaration: RuntimeProfileDeclaration
): RuntimeProfileResolution {
  const names = Object.keys(agents);
  const { harness, model, reasoningEffort } = declaration;
  if (harness === undefined) {
    return { ok: false, error: 'runtime must declare a harness' };
  }
  if (!VALID_BACKENDS.has(harness as AgentRuntime['agentBackend'])) {
    return { ok: false, error: `Unsupported harness: ${harness}`, options: [...VALID_BACKENDS] };
  }
  if (model === undefined) {
    return { ok: false, error: `An explicit runtime must declare a model for harness ${harness}; no fallback model is applied` };
  }
  if (!isValidModelForBackend(harness as AgentRuntime['agentBackend'], model)) {
    return { ok: false, error: `Model ${model} is not a Codex/ChatGPT model identifier` };
  }
  if (reasoningEffort !== undefined) {
    if (!EFFORT_CAPABLE_HARNESSES.has(harness)) {
      return { ok: false, error: `Harness ${harness} does not support a reasoning effort; supported harnesses: ${[...EFFORT_CAPABLE_HARNESSES].join(', ')}`, options: [...EFFORT_CAPABLE_HARNESSES] };
    }
    if (!isReasoningEffort(reasoningEffort)) {
      return { ok: false, error: `Invalid reasoning effort: ${reasoningEffort}`, options: REASONING_EFFORTS };
    }
  }

  // Credentials come only from an enabled agent for the requested harness.
  // Which one is the base follows main's default-marker/declaration-order
  // rules (resolveDefaultAgentRuntime), not a task-private ordering.
  const forHarness = Object.fromEntries(names.filter((name) => agents[name].agentBackend === harness).map((name) => [name, agents[name]]));
  const base = resolveDefaultAgentRuntime(forHarness);
  if (!base.ok) {
    return { ok: false, error: `No enabled agent provides the ${harness} harness; configure and enable one first`, options: names };
  }
  return {
    ok: true,
    base: { presetName: base.name, preset: base.preset },
    overrides: {
      model,
      ...(reasoningEffort !== undefined && isReasoningEffort(reasoningEffort) ? { reasoningEffort } : {}),
    },
  };
}
