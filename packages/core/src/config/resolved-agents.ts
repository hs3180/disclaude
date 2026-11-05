/** Resolve named runtimes and LLMs once for preflight and construction. */
import type {
  AgentDefinition,
  AgentPreset,
  AgentPresets,
  DisclaudeConfig,
  LlmConfig,
} from './types.js';
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
const BACKENDS = new Set(['claude', 'pi', 'codex', 'dsh']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Full Claude model IDs as modelOverrides keys (Issue #5410); bare aliases are rejected below. */
const CLAUDE_MODEL_ID = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/**
 * Bare Claude Code model aliases (Issue #5679). Claude resolves these to its
 * current catalog ID before the wire; DSH/Pi/Codex send `model` verbatim, so a
 * shared binding must pin the wire model and keep the alias out of `model`.
 */
const BARE_CLAUDE_ALIAS = /^(opus|sonnet|haiku|fable|default)$/i;
const mapping = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function resolveConfiguredAgents(
  config: DisclaudeConfig
): { ok: true; presets: AgentPresets } | { ok: false; errors: string[] } {
  const errors: string[] = secretConfigurationErrors(config);
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) {
      errors.push(
        `Unsupported configuration section ${key}; use agents, llms and channels (see docs/agent-configuration.md)`
      );
    }
  }
  if (
    config.env !== undefined &&
    (!mapping(config.env) ||
      Object.entries(config.env).some(
        ([key, value]) => !ENV_NAME.test(key) || typeof value !== 'string'
      ))
  ) {
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

  const llms = config.llms as Record<string, LlmConfig>;
  const credentialEnvKeys = modelSecretReferences(config);
  for (const [name, raw] of Object.entries(llms)) {
    const field = `llms.${name}`;
    if (!mapping(raw)) {
      errors.push(`${field} must be a mapping`);
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!['model', 'reasoningEffort', 'maxConcurrentSessions', 'api', 'behavesAs', 'modelOverrides', 'env'].includes(key)) {
        errors.push(`${field}.${key} is unsupported`);
      }
    }
    const llm = raw as LlmConfig;
    if (typeof llm.model !== 'string' || !llm.model.trim()) {
      errors.push(`${field}.model must be an explicit non-empty string; set this LLM model before upgrading (docs/agent-configuration.md)`);
    }
    if (llm.reasoningEffort !== undefined && !isCodexReasoningEffort(llm.reasoningEffort)) {
      errors.push(`${field}.reasoningEffort is invalid`);
    }
    if (
      llm.maxConcurrentSessions !== undefined &&
      (!Number.isSafeInteger(llm.maxConcurrentSessions) || llm.maxConcurrentSessions <= 0)
    ) {
      errors.push(`${field}.maxConcurrentSessions must be a positive integer`);
    }
    if (
      llm.env !== undefined &&
      (!mapping(llm.env) ||
        Object.entries(llm.env).some(
          ([key, value]) => !ENV_NAME.test(key) || typeof value !== 'string'
        ))
    ) {
      errors.push(`${field}.env must map environment variable names to strings`);
    }
    if (llm.behavesAs !== undefined) {
      if (typeof llm.behavesAs !== 'string' || !CLAUDE_MODEL_ID.test(llm.behavesAs)) {
        errors.push(
          /^(opus|sonnet|haiku|fable|default)$/i.test(String(llm.behavesAs))
            ? `${field}.behavesAs must be a full Claude model ID such as claude-opus-5; aliases are not auto-resolved, pin the running version's catalog ID`
            : `${field}.behavesAs must be a full Claude model ID such as claude-opus-5`
        );
      }
      if (llm.modelOverrides !== undefined) {
        errors.push(`${field}.behavesAs and modelOverrides are mutually exclusive`);
      }
    }
    if (
      llm.modelOverrides !== undefined &&
      (!mapping(llm.modelOverrides) ||
        !Object.keys(llm.modelOverrides).length ||
        Object.entries(llm.modelOverrides).some(
          ([key, value]) =>
            !CLAUDE_MODEL_ID.test(key) || typeof value !== 'string' || !value.trim()
        ))
    ) {
      errors.push(
        `${field}.modelOverrides must map full Claude model IDs to non-empty provider model IDs`
      );
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
          if (
            typeof llm.api.baseUrl !== 'string' ||
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password || url.hash || hasUrlCredential(llm.api.baseUrl)
          ) {
            throw new Error('invalid endpoint');
          }
        } catch {
          errors.push(`${field}.api.baseUrl must be an HTTP(S) URL without credentials`);
        }
      }
      const keyEnv = apiCredentialEnvName(llm.api);
      if (!keyEnv) {
        errors.push(
          `${field}.api.apiKey must be an environment reference ($VARIABLE or \u0024{VARIABLE})`
        );
      } else {
        credentialEnvKeys.add(keyEnv);
      }
    }
  }

  if (errors.length) {
    return { ok: false, errors };
  }
  const presets: AgentPresets = {};
  // Issue #5679: backends referencing each binding, for cross-harness checks.
  const backendsByLlm = new Map<string, Set<string>>();
  for (const [name, raw] of Object.entries(config.agents as Record<string, unknown>)) {
    const field = `agents.${name}`;
    if (!mapping(raw)) {
      errors.push(`${field} must be a mapping`);
      continue;
    }
    const agent = raw as unknown as AgentDefinition;
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
      'maxConcurrentTasks',
      'enableAgentTeams',
      'autoCompactWindow',
      'sdkTimeoutMs',
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) {
        errors.push(
          key === 'deepseek' || key === 'dsh'
            ? `${field}.${key} is unsupported; keep mode and dshHome on the agent and move protocol, baseUrl and credential reference to llms.${agent.llm}.api`
            : `${field}.${key} is unsupported; models and API connections belong in llms`
        );
      }
    }
    if (!BACKENDS.has(agent.backend)) {
      errors.push(
        raw.backend === 'deepseek'
          ? `${field}.backend deepseek is unsupported; use backend: dsh`
          : `${field}.backend must be claude, pi, codex or dsh`
      );
    }
    if (typeof agent.llm !== 'string' || !Object.hasOwn(llms, agent.llm)) {
      errors.push(`${field}.llm must reference a defined llms entry`);
      continue;
    }
    const referenced = backendsByLlm.get(agent.llm) ?? new Set<string>();
    referenced.add(agent.backend);
    backendsByLlm.set(agent.llm, referenced);
    for (const key of [
      'fullAccess',
      'codexNetworkAccess',
      'enableAgentTeams',
      'default',
    ] as const) {
      if (agent[key] !== undefined && typeof agent[key] !== 'boolean') {
        errors.push(`${field}.${key} must be a boolean`);
      }
    }
    for (const key of ['autoCompactWindow', 'sdkTimeoutMs'] as const) {
      if (
        agent[key] !== undefined &&
        !(key === 'autoCompactWindow' && agent[key] === 'auto') &&
        (!Number.isInteger(agent[key]) || (agent[key] as number) < 0)
      ) {
        errors.push(`${field}.${key} must be a non-negative integer${key === 'autoCompactWindow' ? ' or auto' : ''}`);
      }
    }
    if (
      agent.permissionMode !== undefined &&
      !['default', 'bypassPermissions'].includes(agent.permissionMode)
    ) {
      errors.push(`${field}.permissionMode must be default or bypassPermissions`);
    }
    if (
      agent.codexSandbox !== undefined &&
      !['read-only', 'workspace-write', 'danger-full-access'].includes(agent.codexSandbox)
    ) {
      errors.push(`${field}.codexSandbox is invalid`);
    }
    if (agent.fullAccess && agent.codexSandbox && agent.codexSandbox !== 'danger-full-access') {
      errors.push(`${field}.fullAccess conflicts with codexSandbox`);
    }
    if (agent.codex !== undefined) {
      if (!mapping(agent.codex as unknown)) {
        errors.push(`${field}.codex must be a mapping`);
        continue;
      }
      for (const key of Object.keys(agent.codex)) {
        if (!['transport', 'maxActiveSessions', 'maxConcurrentRuns'].includes(key)) {
          errors.push(`${field}.codex.${key} is unsupported`);
        }
      }
      if (
        agent.codex.transport !== undefined &&
        !['exec', 'app-server'].includes(agent.codex.transport)
      ) {
        errors.push(`${field}.codex.transport must be exec or app-server`);
      }
      for (const key of ['maxActiveSessions', 'maxConcurrentRuns'] as const) {
        if (
          agent.codex[key] !== undefined &&
          (!Number.isInteger(agent.codex[key]) || (agent.codex[key] as number) <= 0)
        ) {
          errors.push(`${field}.codex.${key} must be a positive integer`);
        }
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
    const llm = llms[agent.llm];
    if (!llm || typeof llm !== 'object') {
      continue;
    }
    if (agent.backend === 'claude' && llm.api?.protocol === 'openai') {
      errors.push(`${field}: Claude requires an Anthropic API connection`);
    }
    if (llm.reasoningEffort !== undefined && !['codex', 'dsh'].includes(agent.backend)) {
      errors.push(`llms.${agent.llm}.reasoningEffort requires a Codex or DSH native runtime`);
    }
    // Issue #5679: `model` is the wire model for every backend sharing the
    // binding; behavesAs/modelOverrides are Claude-side capability metadata
    // that simply does not apply to other runtimes. Native Codex owns its
    // model catalog and forbids bound API connections, so Claude capability
    // metadata on a Codex-bound LLM is always dead configuration.
    if (
      (llm.behavesAs !== undefined || llm.modelOverrides !== undefined) &&
      agent.backend === 'codex'
    ) {
      errors.push(
        `llms.${agent.llm}.behavesAs is Claude-side capability metadata; native Codex owns its model catalog and never applies it`
      );
    }
    if (agent.backend === 'codex' && llm.api !== undefined) {
      errors.push(
        `${field}: this native runtime owns its API connection; omit llms.${agent.llm}.api`
      );
    }
    if (agent.backend === 'dsh' && (!llm.api || !llm.api.baseUrl)) {
      errors.push(
        `llms.${agent.llm}.api with protocol, baseUrl and credential reference is required for DSH`
      );
    }
    const protocol = llm.api?.protocol;
    const keyEnv = llm.api ? apiCredentialEnvName(llm.api) : undefined;
    const { backend, ...settings } = agent;
    presets[name] = {
      ...settings,
      agentBackend: backend,
      reasoningEffort: llm.reasoningEffort,
      maxConcurrentSessions: llm.maxConcurrentSessions,
      // Issue #5410: behavesAs compiles to a single-entry map; a raw map passes through verbatim.
      modelOverrides:
        llm.behavesAs !== undefined
          ? { [llm.behavesAs]: llm.model.trim() }
          : llm.modelOverrides,
      model: llm.model.trim(),
      apiKey: keyEnv ? (process.env[keyEnv] ?? '') : '',
      apiProtocol: protocol,
      apiBaseUrl: llm.api?.baseUrl,
      env: resolveLlmEnvironment(llm.env),
      missingEnvReferences: Object.entries(llm.env ?? {}).flatMap(([key, value]) => {
        const reference = credentialEnvName(value);
        return reference && !process.env[reference]?.trim() ? [`llms.${agent.llm}.env.${key} (${reference})`] : [];
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
    const model = llm.model.trim();
    if (BARE_CLAUDE_ALIAS.test(model)) {
      const others = [...backends].filter((backend) => backend !== 'claude').join('/');
      errors.push(
        `llms.${llmName}.model "${model}" is a bare Claude alias; Claude resolves it internally while ${others} send it literally. Pin the wire model (for example group/hq-degrade) in llms.${llmName}.model and the Claude capability slot in behavesAs`
      );
    }
  }
  if (!errors.length) {
    const validation = validateAgentPresets(presets);
    if (!validation.ok) {
      errors.push(
        ...validation.errors.map((error) => {
          for (const [name, preset] of Object.entries(presets)) {
            error = error
              .replace(`agents.${name}.model`, `llms.${preset.llm}.model`)
              .replace(`agents.${name}.agentBackend`, `agents.${name}.backend`);
          }
          return error;
        })
      );
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, presets };
}

/** Validate only the selected runtime's secrets; dormant entries need no credentials. */
export function validateResolvedAgent(preset: AgentPreset): string | undefined {
  if (typeof preset.model !== 'string' || !preset.model.trim()) {
    return `llms.${preset.llm}.model must be an explicit non-empty string`;
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
