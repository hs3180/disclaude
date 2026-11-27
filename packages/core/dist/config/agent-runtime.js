/**
 * Preset-free agent runtime selection (Issue #5255, review 5948908832): the
 * orthogonal harness/model dimensions, the LLM-provider compatibility matrix
 * that gates them, the `agents:` map validation and the default/named runtime
 * resolution. Extracted from the retired named-preset module so the selection
 * surface no longer depends on preset concepts.
 */
/**
 * Issue #5255: backends selectable through the orthogonal `/agent backend`
 * dimension. Same set as validation; exported so the switch path and its
 * "available options" replies cannot drift from the configured domain.
 */
export const SWITCHABLE_BACKENDS = [
    'claude',
    'pi',
    'codex',
    'dsh',
    'miniswe',
];
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
export function backendLlmCompatibility(backend, binding) {
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
export function switchableBackendsFor(binding) {
    return SWITCHABLE_BACKENDS.filter((backend) => backendLlmCompatibility(backend, binding).ok);
}
/**
 * Issue #5255: model identifiers each backend accepts on the orthogonal
 * `/agent model` path. Codex must receive a Codex/ChatGPT model id; the
 * API-driven backends pass the identifier through to the provider verbatim,
 * so any non-empty string is accepted (the provider validates availability).
 */
export function isValidModelForBackend(backend, model) {
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
export function composeSessionRuntime(base, override) {
    if (!override?.backendOverride && !override?.modelOverride) {
        return base;
    }
    const { backendOverride, modelOverride } = override;
    const agentBackend = backendOverride ?? base.agentBackend;
    const { modelMapping, ...portable } = base;
    return {
        ...portable,
        agentBackend,
        ...(modelOverride ? { model: modelOverride } : {}),
        ...(agentBackend === 'claude' ? { modelMapping } : {}),
    };
}
/**
 * Issue #5255: resolve the default agent runtime — the harness-keyed
 * `defaultHarness` lookup first, then the single-entry fallback and the
 * default-marker/declaration-order rules. Extracted from the retired
 * named-preset resolver so config, loader and the CLI share one preset-free
 * default-selection path. Like the resolver it replaces, this does not
 * revalidate the map — callers that accept user configuration run validation
 * first.
 */
export function resolveDefaultAgentRuntime(agents, defaultHarness) {
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
        return { ok: false, error: 'agents must contain at least one named runtime' };
    }
    // Do not silently reorder integer-index keys, even when a caller resolves
    // the default directly without first validating the map.
    if (entries.some(([presetName]) => /^\d+$/.test(presetName))) {
        return { ok: false, error: 'agents runtime names must not be numeric' };
    }
    const defaults = entries.filter(([presetName, preset]) => presetName === 'default' || preset.default === true);
    if (defaults.length > 1) {
        return {
            ok: false,
            error: `Unable to resolve default agent runtime (found ${defaults.length})`,
        };
    }
    const [defaultName, preset] = defaults[0] ?? entries[0];
    return { ok: true, name: defaultName, preset };
}
/**
 * Issue #5255: resolve the runtime a session should run on — the pool's
 * selected runtime name first (the session override domain), then the
 * default-resolution chain. Named resolution moved here from the retired
 * named-preset module so the whole selection surface is preset-free.
 *
 * This deliberately does not revalidate the map: callers that accept user
 * configuration should run validateAgentRuntimes first, while runtime command
 * handlers can use this helper without duplicating selection semantics.
 */
export function resolveSessionAgentRuntime(agents, selectedName, defaultHarness) {
    const name = selectedName?.trim();
    if (name) {
        const preset = agents[name];
        return preset
            ? { ok: true, name, preset }
            : { ok: false, error: `Unknown agent runtime: ${name}` };
    }
    return resolveDefaultAgentRuntime(agents, defaultHarness);
}
const VALID_BACKENDS = new Set(SWITCHABLE_BACKENDS);
/**
 * Validate the public `agents:` map and resolve its effective default
 * runtime. Moved from the retired named-preset module (Issue #5255 r4).
 *
 * The reserved `default` key is the compatibility-friendly default marker.
 * A named runtime may instead set `default: true`, but the two forms may not
 * be combined. With no marker, declaration order provides a stable fallback.
 */
export function validateAgentRuntimes(agents, options = {}) {
    if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
        return { ok: false, errors: ['agents must be a non-empty map of named runtimes'] };
    }
    const entries = Object.entries(agents);
    if (entries.length === 0) {
        return { ok: false, errors: ['agents must contain at least one named runtime'] };
    }
    const errors = [];
    const defaults = [];
    for (const [name, raw] of entries) {
        if (!name.trim()) {
            errors.push('agents runtime names must not be empty');
        }
        if (/^\d+$/.test(name)) {
            errors.push(`agents.${name}: runtime names must not be numeric; use a name such as agent-${name}`);
        }
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            errors.push(`agents.${name} must be a mapping`);
            continue;
        }
        const preset = raw;
        if (!VALID_BACKENDS.has(preset.agentBackend)) {
            errors.push(`agents.${name}.agentBackend must be one of: claude, pi, codex, dsh, miniswe`);
        }
        if (typeof preset.model !== 'string' ||
            (!options.allowUnconfiguredModel && !preset.model.trim())) {
            errors.push(`agents.${name}.model must be a non-empty string`);
        }
        else if (preset.agentBackend === 'codex' &&
            // Issue #5338: the ChatGPT-catalog shape only applies to the
            // ChatGPT-subscription access method; an API binding serves whatever
            // models the actual provider validates on the wire.
            preset.llmVia !== 'api' &&
            preset.model.trim() &&
            !/^gpt-\d+(?:[.-].+)/i.test(preset.model.trim())) {
            errors.push(`agents.${name}.model must be a Codex/ChatGPT model identifier`);
        }
        if (preset.default !== undefined && typeof preset.default !== 'boolean') {
            errors.push(`agents.${name}.default must be a boolean`);
        }
        if (name === 'default' || preset.default === true) {
            defaults.push(name);
        }
    }
    if (defaults.length > 1) {
        errors.push(`agents must not declare multiple default runtimes (found ${defaults.length})`);
    }
    if (errors.length > 0) {
        return { ok: false, errors };
    }
    const name = defaults[0] ?? entries[0][0];
    return { ok: true, name, preset: agents[name] };
}
