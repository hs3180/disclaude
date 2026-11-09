import { validateAgentPresets } from './agent-presets.js';
import { isCodexReasoningEffort } from './codex-settings.js';
import { apiCredentialEnvName, credentialEnvName } from './env-reference.js';
import { modelSecretReferences, secretConfigurationErrors, resolveLlmEnvironment, hasUrlCredential } from './secret-references.js';
const CONFIG_KEYS = new Set([
    'workspace',
    'agents',
    'llms',
    'channels',
    'logging',
    'tools',
    'messaging',
    'sessionRestore',
    'env',
    'projectTemplates',
    '_source',
    '_fromFile',
]);
const BACKENDS = new Set(['claude', 'pi', 'codex', 'dsh', 'miniswe']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Full Claude model IDs as modelOverrides keys (Issue #5410); bare aliases are rejected below. */
const CLAUDE_MODEL_ID = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * Bare Claude Code model aliases (Issue #5679). Claude resolves these to its
 * current catalog ID before the wire; DSH/Pi/Codex send `model` verbatim, so a
 * shared binding must pin the wire model and keep the alias out of `model`.
 */
const BARE_CLAUDE_ALIAS = /^(opus|sonnet|haiku|fable|default)$/i;
/** Native variables Claude Code resolves the opus/sonnet/haiku tiers through. */
const CLAUDE_TIER_ENV = {
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};
const mapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
/**
 * Default tier environment for a Claude runtime (review 2026-11-06): each
 * opus/sonnet/haiku tier uses `claude.models.<tier>`, falling back to the
 * provider `defaultModel` — so configuring only one model points all three
 * tiers at it. Explicit `claude.env` entries keep precedence; a tier both
 * forms would set is rejected during validation instead.
 */
function claudeTierEnvironment(claude, defaultModel) {
    const tiers = {};
    for (const tier of Object.keys(CLAUDE_TIER_ENV)) {
        if (claude?.env?.[CLAUDE_TIER_ENV[tier]] !== undefined) {
            continue;
        }
        const configured = claude?.models?.[tier];
        const model = (typeof configured === 'string' ? configured.trim() : '') || defaultModel;
        if (model) {
            tiers[CLAUDE_TIER_ENV[tier]] = model;
        }
    }
    return Object.keys(tiers).length ? tiers : undefined;
}
export function resolveConfiguredAgents(config) {
    const errors = secretConfigurationErrors(config);
    for (const key of Object.keys(config)) {
        if (!CONFIG_KEYS.has(key)) {
            errors.push(`Unsupported configuration section ${key}; use agents, llms and channels (see docs/agent-configuration.md)`);
        }
    }
    if (config.env !== undefined &&
        (!mapping(config.env) ||
            Object.entries(config.env).some(([key, value]) => !ENV_NAME.test(key) || typeof value !== 'string'))) {
        errors.push('env must map variable names to strings');
    }
    if (config.agents === undefined && config.llms === undefined) {
        return errors.length ? { ok: false, errors } : { ok: true, presets: {} };
    }
    if (!mapping(config.agents) || !Object.keys(config.agents).length) {
        errors.push('agents must be a non-empty map of named runtimes');
    }
    if (!mapping(config.llms) || !Object.keys(config.llms).length) {
        errors.push('llms must be a non-empty map of named models');
    }
    if (errors.length) {
        return { ok: false, errors };
    }
    const llms = config.llms;
    const credentialEnvKeys = modelSecretReferences(config);
    for (const [name, raw] of Object.entries(llms)) {
        const field = `llms.${name}`;
        if (!mapping(raw)) {
            errors.push(`${field} must be a mapping`);
            continue;
        }
        for (const key of Object.keys(raw)) {
            if (key === 'behavesAs' || key === 'modelOverrides') {
                errors.push(`${field}.${key} has moved to agents.<name>.claude.${key}; llms contains provider settings only`);
            }
            else if (key === 'model') {
                errors.push(`${field}.model has been renamed to ${field}.defaultModel; agents can use any model of this provider and defaultModel only sets the default`);
            }
            else if (!['defaultModel', 'reasoningEffort', 'maxConcurrentSessions', 'api', 'env'].includes(key)) {
                errors.push(`${field}.${key} is unsupported`);
            }
        }
        const llm = raw;
        if (llm.defaultModel !== undefined && (typeof llm.defaultModel !== 'string' || !llm.defaultModel.trim())) {
            errors.push(`${field}.defaultModel must be a non-empty string when set`);
        }
        if (llm.reasoningEffort !== undefined && !isCodexReasoningEffort(llm.reasoningEffort)) {
            errors.push(`${field}.reasoningEffort is invalid`);
        }
        if (llm.maxConcurrentSessions !== undefined &&
            (!Number.isSafeInteger(llm.maxConcurrentSessions) || llm.maxConcurrentSessions <= 0)) {
            errors.push(`${field}.maxConcurrentSessions must be a positive integer`);
        }
        if (llm.env !== undefined &&
            (!mapping(llm.env) ||
                Object.entries(llm.env).some(([key, value]) => !ENV_NAME.test(key) || typeof value !== 'string'))) {
            errors.push(`${field}.env must map environment variable names to strings`);
        }
        for (const key of Object.keys(llm.env ?? {})) {
            if (/^ANTHROPIC_DEFAULT_(OPUS|SONNET|HAIKU)_MODEL$/.test(key)) {
                errors.push(`${field}.env.${key} has moved to agents.<name>.claude.models or agents.<name>.claude.env.${key}`);
            }
        }
        if (llm.api !== undefined) {
            if (!mapping(llm.api)) {
                errors.push(`${field}.api must be a mapping`);
                continue;
            }
            for (const key of Object.keys(llm.api)) {
                if (!['protocol', 'baseUrl', 'apiKey'].includes(key)) {
                    errors.push(`${field}.api.${key} is unsupported`);
                }
            }
            if (!['anthropic', 'openai'].includes(llm.api.protocol)) {
                errors.push(`${field}.api.protocol must be anthropic or openai`);
            }
            if (llm.api.baseUrl !== undefined) {
                try {
                    const url = new URL(llm.api.baseUrl);
                    if (typeof llm.api.baseUrl !== 'string' ||
                        !['http:', 'https:'].includes(url.protocol) ||
                        url.username ||
                        url.password || url.hash || hasUrlCredential(llm.api.baseUrl)) {
                        throw new Error('invalid endpoint');
                    }
                }
                catch {
                    errors.push(`${field}.api.baseUrl must be an HTTP(S) URL without credentials`);
                }
            }
            const keyEnv = apiCredentialEnvName(llm.api);
            if (!keyEnv) {
                errors.push(`${field}.api.apiKey must be an environment reference ($VARIABLE or \u0024{VARIABLE})`);
            }
            else {
                credentialEnvKeys.add(keyEnv);
            }
        }
    }
    if (errors.length) {
        return { ok: false, errors };
    }
    const presets = {};
    // Issue #5679: backends referencing each binding, for cross-harness checks.
    const backendsByLlm = new Map();
    for (const [name, raw] of Object.entries(config.agents)) {
        const field = `agents.${name}`;
        if (!mapping(raw)) {
            errors.push(`${field} must be a mapping`);
            continue;
        }
        const agent = raw;
        const allowed = new Set([
            'backend',
            'llm',
            'default',
            'mode',
            'dshHome',
            'permissionMode',
            'fullAccess',
            'codexSandbox',
            'codexNetworkAccess',
            'codex',
            'miniswe',
            'maxConcurrentTasks',
            'enableAgentTeams',
            'autoCompactWindow',
            'sdkTimeoutMs',
            'claude',
        ]);
        for (const key of Object.keys(raw)) {
            if (!allowed.has(key)) {
                errors.push(key === 'deepseek' || key === 'dsh'
                    ? `${field}.${key} is unsupported; keep mode and dshHome on the agent and move protocol, baseUrl and credential reference to llms.${agent.llm}.api`
                    : `${field}.${key} is unsupported; models and API connections belong in llms`);
            }
        }
        if (!BACKENDS.has(agent.backend)) {
            errors.push(raw.backend === 'deepseek'
                ? `${field}.backend deepseek is unsupported; use backend: dsh`
                : `${field}.backend must be claude, pi, codex, dsh or miniswe`);
        }
        if (typeof agent.llm !== 'string' || !Object.hasOwn(llms, agent.llm)) {
            errors.push(`${field}.llm must reference a defined llms entry`);
            continue;
        }
        const referenced = backendsByLlm.get(agent.llm) ?? new Set();
        referenced.add(agent.backend);
        backendsByLlm.set(agent.llm, referenced);
        for (const key of [
            'fullAccess',
            'codexNetworkAccess',
            'enableAgentTeams',
            'default',
        ]) {
            if (agent[key] !== undefined && typeof agent[key] !== 'boolean') {
                errors.push(`${field}.${key} must be a boolean`);
            }
        }
        for (const key of ['autoCompactWindow', 'sdkTimeoutMs']) {
            if (agent[key] !== undefined &&
                !(key === 'autoCompactWindow' && agent[key] === 'auto') &&
                (!Number.isInteger(agent[key]) || agent[key] < 0)) {
                errors.push(`${field}.${key} must be a non-negative integer${key === 'autoCompactWindow' ? ' or auto' : ''}`);
            }
        }
        if (agent.permissionMode !== undefined &&
            !['default', 'bypassPermissions'].includes(agent.permissionMode)) {
            errors.push(`${field}.permissionMode must be default or bypassPermissions`);
        }
        if (agent.codexSandbox !== undefined &&
            !['read-only', 'workspace-write', 'danger-full-access'].includes(agent.codexSandbox)) {
            errors.push(`${field}.codexSandbox is invalid`);
        }
        if (agent.fullAccess && agent.codexSandbox && agent.codexSandbox !== 'danger-full-access') {
            errors.push(`${field}.fullAccess conflicts with codexSandbox`);
        }
        if (agent.codex !== undefined) {
            if (!mapping(agent.codex)) {
                errors.push(`${field}.codex must be a mapping`);
                continue;
            }
            for (const key of Object.keys(agent.codex)) {
                if (!['transport', 'maxActiveSessions', 'maxConcurrentRuns', 'weeklyQuotaAdmission', 'weeklyLimitCooldownMs'].includes(key)) {
                    errors.push(`${field}.codex.${key} is unsupported`);
                }
            }
            if (agent.codex.transport !== undefined &&
                !['exec', 'app-server'].includes(agent.codex.transport)) {
                errors.push(`${field}.codex.transport must be exec or app-server`);
            }
            for (const key of ['maxActiveSessions', 'maxConcurrentRuns']) {
                if (agent.codex[key] !== undefined &&
                    (!Number.isInteger(agent.codex[key]) || agent.codex[key] <= 0)) {
                    errors.push(`${field}.codex.${key} must be a positive integer`);
                }
            }
            // #5607 rework: weekly-quota keys. Admission is a closed enum;
            // the fallback cooldown keeps the positive-integer rule.
            if (agent.codex.weeklyQuotaAdmission !== undefined &&
                !['observe', 'enforce'].includes(agent.codex.weeklyQuotaAdmission)) {
                errors.push(`${field}.codex.weeklyQuotaAdmission must be observe or enforce`);
            }
            if (agent.codex.weeklyLimitCooldownMs !== undefined &&
                (!Number.isInteger(agent.codex.weeklyLimitCooldownMs) || agent.codex.weeklyLimitCooldownMs <= 0)) {
                errors.push(`${field}.codex.weeklyLimitCooldownMs must be a positive integer`);
            }
        }
        if (agent.miniswe !== undefined) {
            if (!mapping(agent.miniswe)) {
                errors.push(`${field}.miniswe must be a mapping`);
            }
            else {
                for (const key of Object.keys(agent.miniswe)) {
                    if (!['binary', 'executionEnvironment', 'timeoutMs'].includes(key)) {
                        errors.push(`${field}.miniswe.${key} is unsupported`);
                    }
                }
                if (agent.miniswe.binary !== undefined &&
                    (typeof agent.miniswe.binary !== 'string' || !agent.miniswe.binary.trim())) {
                    errors.push(`${field}.miniswe.binary must be a non-empty string`);
                }
                if (agent.miniswe.executionEnvironment !== undefined) {
                    if (agent.miniswe.executionEnvironment === 'local') {
                        // The only implemented policy: subprocess in the managed workspace.
                    }
                    else {
                        errors.push(`${field}.miniswe.executionEnvironment must be local; docker and SWE-ReX execution environments are out of scope for this adapter (run those as native mini-swe-agent workflows, #5006)`);
                    }
                }
                if (agent.miniswe.timeoutMs !== undefined &&
                    (!Number.isInteger(agent.miniswe.timeoutMs) || agent.miniswe.timeoutMs < 0)) {
                    errors.push(`${field}.miniswe.timeoutMs must be a non-negative integer`);
                }
            }
            if (agent.backend !== 'miniswe') {
                errors.push(`${field}.miniswe requires backend: miniswe`);
            }
        }
        if (agent.mode !== undefined) {
            if (agent.backend !== 'dsh') {
                errors.push(`${field}.mode requires backend: dsh`);
            }
            if (typeof agent.mode !== 'string' || !['minimal', 'standard'].includes(agent.mode)) {
                errors.push(`${field}.mode must be minimal or standard`);
            }
        }
        if (agent.dshHome !== undefined) {
            if (agent.backend !== 'dsh') {
                errors.push(`${field}.dshHome requires backend: dsh`);
            }
            if (typeof agent.dshHome !== 'string' || !agent.dshHome.trim()) {
                errors.push(`${field}.dshHome must be a non-empty string`);
            }
        }
        if (agent.claude !== undefined) {
            if (agent.backend !== 'claude') {
                errors.push(`${field}.claude requires backend: claude`);
            }
            else if (!mapping(agent.claude)) {
                errors.push(`${field}.claude must be a mapping`);
            }
            else {
                for (const key of Object.keys(agent.claude)) {
                    if (!['behavesAs', 'modelOverrides', 'models', 'env'].includes(key)) {
                        errors.push(`${field}.claude.${key} is unsupported`);
                    }
                }
                if (agent.claude.behavesAs !== undefined) {
                    if (typeof agent.claude.behavesAs !== 'string' || !CLAUDE_MODEL_ID.test(agent.claude.behavesAs)) {
                        errors.push(`${field}.claude.behavesAs must be a full Claude model ID such as claude-opus-5; aliases are not auto-resolved`);
                    }
                    if (agent.claude.modelOverrides !== undefined) {
                        errors.push(`${field}.claude.behavesAs and modelOverrides are mutually exclusive`);
                    }
                    if (!llms[agent.llm]?.defaultModel?.trim()) {
                        errors.push(`${field}.claude.behavesAs requires a provider default model at llms.${agent.llm}.defaultModel`);
                    }
                }
                if (agent.claude.modelOverrides !== undefined &&
                    (!mapping(agent.claude.modelOverrides) || !Object.keys(agent.claude.modelOverrides).length ||
                        Object.entries(agent.claude.modelOverrides).some(([key, value]) => !CLAUDE_MODEL_ID.test(key) || typeof value !== 'string' || !value.trim()))) {
                    errors.push(`${field}.claude.modelOverrides must map full Claude model IDs to non-empty provider model IDs`);
                }
                // Three-tier opus/sonnet/haiku mapping (review 2026-11-06): each tier
                // names a provider model; omitted tiers fall back to the provider
                // defaultModel at resolution time.
                if (agent.claude.models !== undefined) {
                    if (!mapping(agent.claude.models)) {
                        errors.push(`${field}.claude.models must be a mapping of opus, sonnet and haiku model IDs`);
                    }
                    else {
                        const tiers = Object.keys(agent.claude.models);
                        if (!tiers.length) {
                            errors.push(`${field}.claude.models must set at least one of opus, sonnet or haiku`);
                        }
                        for (const tier of tiers) {
                            if (!Object.hasOwn(CLAUDE_TIER_ENV, tier)) {
                                errors.push(`${field}.claude.models.${tier} is unsupported; use opus, sonnet or haiku`);
                                continue;
                            }
                            const model = agent.claude.models[tier];
                            if (typeof model !== 'string' || !model.trim()) {
                                errors.push(`${field}.claude.models.${tier} must be a non-empty model ID`);
                            }
                            else if (agent.claude.env?.[CLAUDE_TIER_ENV[tier]] !== undefined) {
                                errors.push(`${field}.claude.models.${tier} conflicts with ${field}.claude.env.${CLAUDE_TIER_ENV[tier]}; configure the tier in one place`);
                            }
                        }
                    }
                }
                if (agent.claude.env !== undefined && (!mapping(agent.claude.env) ||
                    Object.entries(agent.claude.env).some(([key, value]) => !ENV_NAME.test(key) || typeof value !== 'string'))) {
                    errors.push(`${field}.claude.env must map environment variable names to strings`);
                }
            }
        }
        const llm = llms[agent.llm];
        if (!llm || typeof llm !== 'object') {
            continue;
        }
        if (agent.backend === 'claude' && llm.api?.protocol === 'openai') {
            errors.push(`${field}: Claude requires an Anthropic API connection`);
        }
        // reasoningEffort is a provider-level default, not a harness gate
        // (review 2026-11-06): runtimes that cannot apply an effort ignore it.
        if (agent.backend === 'codex' && llm.api !== undefined) {
            errors.push(`${field}: this native runtime owns its API connection; omit llms.${agent.llm}.api`);
        }
        if (agent.backend === 'dsh' && (!llm.api || !llm.api.baseUrl)) {
            errors.push(`llms.${agent.llm}.api with protocol, baseUrl and credential reference is required for DSH`);
        }
        // mini-swe-agent resolves its model through LiteLLM from the bound LLM
        // connection; without an api block it would silently fall back to the
        // interactive global setup the headless child can never complete.
        if (agent.backend === 'miniswe' && !llm.api) {
            errors.push(`llms.${agent.llm}.api with protocol, credential reference and (for custom endpoints) baseUrl is required for mini-swe`);
        }
        const protocol = llm.api?.protocol;
        const keyEnv = llm.api ? apiCredentialEnvName(llm.api) : undefined;
        const { backend, ...settings } = agent;
        const defaultModel = llm.defaultModel?.trim() ?? '';
        const resolvedEnv = resolveLlmEnvironment({
            ...llm.env,
            ...(backend === 'claude' ? agent.claude?.env : {}),
        });
        const tierEnv = backend === 'claude' ? claudeTierEnvironment(agent.claude, defaultModel) : undefined;
        presets[name] = {
            ...settings,
            agentBackend: backend,
            reasoningEffort: llm.reasoningEffort,
            maxConcurrentSessions: llm.maxConcurrentSessions,
            // Claude owns its model names; other runtimes never receive this metadata.
            modelOverrides: backend === 'claude'
                ? agent.claude?.behavesAs !== undefined && defaultModel
                    ? { [agent.claude.behavesAs]: defaultModel }
                    : agent.claude?.modelOverrides
                : undefined,
            model: defaultModel,
            apiKey: keyEnv ? (process.env[keyEnv] ?? '') : '',
            apiProtocol: protocol,
            apiBaseUrl: llm.api?.baseUrl,
            env: tierEnv ? { ...tierEnv, ...resolvedEnv } : resolvedEnv,
            missingEnvReferences: [
                ...Object.entries(llm.env ?? {}).map(([key, value]) => [`llms.${agent.llm}.env.${key}`, value]),
                ...Object.entries(backend === 'claude' ? agent.claude?.env ?? {} : {}).map(([key, value]) => [`${field}.claude.env.${key}`, value]),
            ].flatMap(([path, value]) => {
                const reference = credentialEnvName(value);
                return reference && !process.env[reference]?.trim() ? [`${path} (${reference})`] : [];
            }),
            credentialEnvKeys: [...credentialEnvKeys],
        };
    }
    // Issue #5679: a bare Claude alias resolves only inside Claude Code; every
    // other backend would put the alias string itself on the wire. A binding
    // shared across that boundary must pin the wire model and use behavesAs for
    // the Claude capability slot, so both providers send the same model ID.
    for (const [llmName, backends] of backendsByLlm) {
        if (backends.size < 2 || !backends.has('claude')) {
            continue;
        }
        const llm = llms[llmName];
        const model = llm.defaultModel?.trim();
        if (model && BARE_CLAUDE_ALIAS.test(model)) {
            const others = [...backends].filter((backend) => backend !== 'claude').join('/');
            errors.push(`llms.${llmName}.defaultModel "${model}" is a bare Claude alias; Claude resolves it internally while ${others} send it literally. Pin the wire model in llms.${llmName}.defaultModel and the Claude capability slot in agents.<name>.claude.behavesAs`);
        }
    }
    if (!errors.length) {
        // llms.defaultModel is optional and was validated above; an empty preset
        // model is its internal representation for "use the runtime's native
        // default".
        const validation = validateAgentPresets(presets, { allowUnconfiguredModel: true });
        if (!validation.ok) {
            errors.push(...validation.errors.map((error) => {
                for (const [name, preset] of Object.entries(presets)) {
                    error = error
                        .replace(`agents.${name}.model`, `llms.${preset.llm}.defaultModel`)
                        .replace(`agents.${name}.agentBackend`, `agents.${name}.backend`);
                }
                return error;
            }));
        }
    }
    return errors.length ? { ok: false, errors } : { ok: true, presets };
}
/** Validate only the selected runtime's secrets; dormant entries need no credentials. */
export function validateResolvedAgent(preset) {
    if (typeof preset.model !== 'string') {
        return `llms.${preset.llm}.defaultModel must be a string when set`;
    }
    if (preset.missingEnvReferences?.length) {
        return `External environment references are missing or empty: ${preset.missingEnvReferences.join(', ')}`;
    }
    if (preset.agentBackend === 'codex') {
        return undefined;
    }
    if (!preset.apiProtocol) {
        return `llms.${preset.llm}.api is required for this runtime`;
    }
    if (!preset.apiKey.trim()) {
        return `The credential referenced by llms.${preset.llm}.api.apiKey is missing`;
    }
    return undefined;
}
