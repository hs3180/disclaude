/**
 * Preset-free agent runtime selection (Issue #5255, review 5948908832): the
 * orthogonal harness/model dimensions and the LLM-provider compatibility
 * matrix that gates them. Extracted from the retired named-preset module so
 * the selection surface no longer depends on preset concepts.
 */

import type { AgentConfig, AgentPreset } from './types.js';

/** Harness runtimes selectable through the orthogonal `/agent backend` dimension. */
export type AgentBackend = NonNullable<AgentConfig['agentBackend']>;

/**
 * Issue #5255: backends selectable through the orthogonal `/agent backend`
 * dimension. Same set as validation; exported so the switch path and its
 * "available options" replies cannot drift from the configured domain.
 */
export const SWITCHABLE_BACKENDS: readonly AgentBackend[] = [
  'claude',
  'pi',
  'codex',
  'dsh',
  'miniswe',
];

/**
 * Issue #5255: per-session orthogonal selection overrides, stored by the
 * session pool alongside the selected runtime. Each dimension overrides
 * exactly one axis of the resolved runtime binding.
 */
export interface SessionAgentOverride {
  backendOverride?: AgentBackend;
  modelOverride?: string;
}

/** Codex/ChatGPT model identifier shape (mirrors runtime config validation). */
const CODEX_MODEL_ID = /^gpt-\d+(?:[.-].+)/i;

/**
 * Issue #5255: judge whether a resolved LLM binding (protocol + endpoint) can
 * serve a different backend when only the backend dimension changes.
 *
 * The criteria mirror resolveConfiguredAgents: claude requires an
 * anthropic-protocol provider; pi speaks both protocols; dsh additionally
 * needs an explicit baseUrl; codex owns its ChatGPT connection and cannot
 * carry an llm api binding at all.
 */
export function backendLlmCompatibility(
  backend: AgentBackend,
  binding: Pick<AgentPreset, 'apiProtocol' | 'apiBaseUrl'>
): { ok: true } | { ok: false; reason: string } {
  switch (backend) {
    case 'claude':
      return binding.apiProtocol === 'anthropic'
        ? { ok: true }
        : { ok: false, reason: 'the claude backend requires an anthropic-protocol llm provider, but the bound llm does not use one' };
    case 'pi':
      return binding.apiProtocol
        ? { ok: true }
        : { ok: false, reason: 'the pi backend requires an llm with an api connection' };
    case 'dsh':
      return binding.apiProtocol && binding.apiBaseUrl
        ? { ok: true }
        : { ok: false, reason: 'the dsh backend requires an llm api with both protocol and baseUrl' };
    case 'codex':
      // #5338: codex may bind an llm api connection (OpenAI-protocol
      // Responses endpoint); without one it owns its ChatGPT login. Only an
      // anthropic-protocol binding cannot serve it.
      return !binding.apiProtocol || binding.apiProtocol === 'openai'
        ? { ok: true }
        : { ok: false, reason: 'the codex backend serves llm bindings over an OpenAI-compatible (Responses) endpoint; the bound llm uses the anthropic protocol' };
    case 'miniswe':
      // #5006: endpoint, model and credentials live on the bound llm api
      // connection — the backend cannot run without one.
      return binding.apiProtocol && binding.apiBaseUrl
        ? { ok: true }
        : { ok: false, reason: 'the miniswe backend requires an llm api with both protocol and baseUrl (endpoint/model/credentials live on the bound llm)' };
  }
}

/**
 * Issue #5255: backends the given llm binding can serve — the "available
 * options" reply for a rejected orthogonal backend switch.
 */
export function switchableBackendsFor(
  binding: Pick<AgentPreset, 'apiProtocol' | 'apiBaseUrl'>
): AgentBackend[] {
  return SWITCHABLE_BACKENDS.filter((backend) => backendLlmCompatibility(backend, binding).ok);
}

/**
 * Issue #5255: model identifiers each backend accepts on the orthogonal
 * `/agent model` path. Codex must receive a Codex/ChatGPT model id; the
 * API-driven backends pass the identifier through to the provider verbatim,
 * so any non-empty string is accepted (the provider validates availability).
 */
export function isValidModelForBackend(
  backend: AgentBackend,
  model: string
): boolean {
  if (backend === 'codex') {
    return CODEX_MODEL_ID.test(model.trim());
  }
  return model.trim().length > 0;
}

/**
 * Issue #5255: overlay one session's orthogonal overrides on a resolved
 * runtime binding. Backend-agnostic settings (permissions, codex governance,
 * llm binding) carry over unchanged; claude-only model metadata is dropped
 * when the effective backend is not claude, mirroring how
 * resolveConfiguredAgents compiles it for claude runtimes only.
 */
export function composeSessionRuntime(
  base: AgentPreset,
  override?: SessionAgentOverride
): AgentPreset {
  if (!override?.backendOverride && !override?.modelOverride) {
    return base;
  }
  const { backendOverride, modelOverride } = override;
  const agentBackend = backendOverride ?? base.agentBackend;
  const { modelOverrides, ...portable } = base;
  return {
    ...portable,
    agentBackend,
    ...(modelOverride ? { model: modelOverride } : {}),
    ...(agentBackend === 'claude' ? { modelOverrides } : {}),
  };
}

export type AgentRuntimeResolution<T = AgentPreset> =
  | { ok: true; name: string; preset: T }
  | { ok: false; error: string };

/**
 * Issue #5255: resolve the default agent runtime — the harness-keyed
 * `defaultHarness` lookup first, then the single-entry fallback and the
 * default-marker/declaration-order rules. Extracted from the retired
 * named-preset resolver so config, loader and the CLI share one preset-free
 * default-selection path; named lookups stay with the session-pool override
 * chain. Like the resolver it replaces, this does not revalidate the map —
 * callers that accept user configuration run validation first.
 */
export function resolveDefaultAgentRuntime<T extends Pick<AgentPreset, 'agentBackend' | 'model' | 'default'>>(
  agents: Record<string, T>,
  defaultHarness?: string
): AgentRuntimeResolution<T> {
  const harness = defaultHarness?.trim();
  if (harness) {
    const preset = agents[harness];
    if (!preset) {
      return { ok: false, error: `defaultHarness must reference a defined agents entry: ${harness}` };
    }
    return { ok: true, name: harness, preset };
  }

  const entries = Object.entries(agents);
  if (entries.length === 0) {
    return { ok: false, error: 'agents must contain at least one named preset' };
  }
  // Do not silently reorder integer-index keys, even when a caller resolves
  // the default directly without first validating the map.
  if (entries.some(([presetName]) => /^\d+$/.test(presetName))) {
    return { ok: false, error: 'agents preset names must not be numeric' };
  }
  const defaults = entries.filter(
    ([presetName, preset]) => presetName === 'default' || preset.default === true
  );
  if (defaults.length > 1) {
    return {
      ok: false,
      error: `Unable to resolve default agent preset (found ${defaults.length})`,
    };
  }

  const [defaultName, preset] = defaults[0] ?? entries[0];
  return { ok: true, name: defaultName, preset };
}
