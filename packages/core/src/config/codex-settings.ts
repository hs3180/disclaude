import type { CodexReasoningEffort } from './types.js';

export const CODEX_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies readonly CodexReasoningEffort[];

export type CodexModelSource =
  | 'environment'
  | 'agent.codex.model'
  | 'agent.model'
  | 'agents.default.model'
  | 'codex-cli-default';
export type CodexEffortSource =
  | 'environment'
  | 'agent.codex.reasoningEffort'
  | 'codex-cli-model-default';

export interface ResolvedCodexSetting<T, S extends string> {
  value?: T;
  source: S;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return (
    typeof value === 'string' && (CODEX_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/** Resolve the one effective default model, keeping legacy inputs as ordered fallbacks. */
export function resolveCodexModelSetting(sources: {
  environment?: string;
  configured?: string;
  legacyAgent?: string;
  legacyPreset?: string;
}): ResolvedCodexSetting<string, CodexModelSource> {
  const candidates: Array<[string | undefined, CodexModelSource]> = [
    [sources.environment, 'environment'],
    [sources.configured, 'agent.codex.model'],
    [sources.legacyAgent, 'agent.model'],
    [sources.legacyPreset, 'agents.default.model'],
  ];
  for (const [value, source] of candidates) {
    const normalized = nonEmpty(value);
    if (normalized) {
      return { value: normalized, source };
    }
  }
  return { source: 'codex-cli-default' };
}

/** Resolve explicit effort overrides while preserving Codex's per-model default when unset. */
export function resolveCodexReasoningEffort(sources: {
  environment?: string;
  configured?: CodexReasoningEffort;
}): ResolvedCodexSetting<CodexReasoningEffort, CodexEffortSource> {
  const environment = nonEmpty(sources.environment);
  if (environment && isCodexReasoningEffort(environment)) {
    return { value: environment, source: 'environment' };
  }
  if (sources.configured) {
    return { value: sources.configured, source: 'agent.codex.reasoningEffort' };
  }
  return { source: 'codex-cli-model-default' };
}
