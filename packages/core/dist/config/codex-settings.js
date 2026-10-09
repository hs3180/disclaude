export const CODEX_REASONING_EFFORTS = [
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
];
function nonEmpty(value) {
    const normalized = value?.trim();
    return normalized || undefined;
}
export function isCodexReasoningEffort(value) {
    return (typeof value === 'string' && CODEX_REASONING_EFFORTS.includes(value));
}
/** Resolve the one effective default model, keeping legacy inputs as ordered fallbacks. */
export function resolveCodexModelSetting(sources) {
    const candidates = [
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
export function resolveCodexReasoningEffort(sources) {
    const environment = nonEmpty(sources.environment);
    if (environment && isCodexReasoningEffort(environment)) {
        return { value: environment, source: 'environment' };
    }
    if (sources.configured) {
        return { value: sources.configured, source: 'agent.codex.reasoningEffort' };
    }
    return { source: 'codex-cli-model-default' };
}
