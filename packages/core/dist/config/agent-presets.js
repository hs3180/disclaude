/** Pure validation and default selection for named agent presets. */
const VALID_BACKENDS = new Set(['claude', 'pi', 'codex', 'deepseek']);
/**
 * Validate the public `agents:` map and resolve its effective default preset.
 *
 * The reserved `default` key is the compatibility-friendly default marker.
 * A named preset may instead set `default: true`, but the two forms may not
 * be combined. With no marker, declaration order provides a stable fallback.
 */
export function validateAgentPresets(agents) {
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
        return { ok: false, errors: ['agents must be a non-empty map of named presets'] };
    }
    const entries = Object.entries(agents);
    if (entries.length === 0) {
        return { ok: false, errors: ['agents must contain at least one named preset'] };
    }
    const errors = [];
    const defaults = [];
    for (const [name, raw] of entries) {
        if (!name.trim()) {
            errors.push('agents preset names must not be empty');
        }
        if (/^\d+$/.test(name)) {
            errors.push(`agents.${name}: preset names must not be numeric; use a name such as agent-${name}`);
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            errors.push(`agents.${name} must be a mapping`);
            continue;
        }
        const preset = raw;
        if (!VALID_BACKENDS.has(preset.agentBackend)) {
            errors.push(`agents.${name}.agentBackend must be one of: claude, pi, codex, deepseek`);
        }
        if (typeof preset.model !== 'string' || !preset.model.trim()) {
            errors.push(`agents.${name}.model must be a non-empty string`);
        }
        else if (preset.agentBackend === 'codex' &&
            !/^gpt-(?:[5-9]|[1-9]\d+)(?:[.-].+)/i.test(preset.model.trim())) {
            errors.push(`agents.${name}.model must be a Codex/ChatGPT model (expected gpt-5.x or newer)`);
        }
        if (preset.default !== undefined && typeof preset.default !== 'boolean') {
            errors.push(`agents.${name}.default must be a boolean`);
        }
        if (name === 'default' || preset.default === true) {
            defaults.push(name);
        }
    }
    if (defaults.length > 1) {
        errors.push(`agents must not declare multiple default presets (found ${defaults.length})`);
    }
    if (errors.length > 0) {
        return { ok: false, errors };
    }
    const name = defaults[0] ?? entries[0][0];
    return { ok: true, name, preset: agents[name] };
}
/**
 * Resolve a requested preset name, or the validated default when omitted.
 *
 * This deliberately does not revalidate the map: callers that accept user
 * configuration should run validateAgentPresets first, while runtime command
 * handlers can use this helper without duplicating selection semantics.
 */
export function resolveAgentPreset(agents, requestedName) {
    const name = requestedName?.trim();
    if (name) {
        const preset = agents[name];
        return preset
            ? { ok: true, name, preset }
            : { ok: false, error: `Unknown agent preset: ${name}` };
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
    const defaults = entries.filter(([presetName, preset]) => presetName === 'default' || preset.default === true);
    if (defaults.length > 1) {
        return {
            ok: false,
            error: `Unable to resolve default agent preset (found ${defaults.length})`,
        };
    }
    const [defaultName, preset] = defaults[0] ?? entries[0];
    return { ok: true, name: defaultName, preset };
}
