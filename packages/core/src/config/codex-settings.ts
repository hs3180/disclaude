import type { ReasoningEffort } from './types.js';

export const CODEX_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const satisfies readonly ReasoningEffort[];

export type CodexModelSource = 'environment' | 'llms.defaultModel' | 'codex-cli-default';
export type CodexEffortSource =
  | 'environment'
  | 'llms.reasoningEffort'
  | 'codex-cli-model-default';

export interface ResolvedCodexSetting<T, S extends string> {
  value?: T;
  source: S;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    typeof value === 'string' && (CODEX_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

/** Resolve the bound default model and the explicit host override. */
export function resolveCodexModelSetting(sources: {
  environment?: string;
  configured?: string;
}): ResolvedCodexSetting<string, CodexModelSource> {
  const candidates: Array<[string | undefined, CodexModelSource]> = [
    [sources.environment, 'environment'],
    [sources.configured, 'llms.defaultModel'],
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
  configured?: ReasoningEffort;
}): ResolvedCodexSetting<ReasoningEffort, CodexEffortSource> {
  const environment = nonEmpty(sources.environment);
  if (environment && isReasoningEffort(environment)) {
    return { value: environment, source: 'environment' };
  }
  if (sources.configured) {
    return { value: sources.configured, source: 'llms.reasoningEffort' };
  }
  return { source: 'codex-cli-model-default' };
}
