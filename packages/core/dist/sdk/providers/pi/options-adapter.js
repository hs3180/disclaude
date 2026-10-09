/** Map shared query values to Pi; tool registration stays in its adapter. */
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
export function adaptPiOptions(options) {
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
function resolveSystemPrompt(options) {
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
