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
import { apiCredentialEnvName } from './env-reference.js';

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
const BACKENDS = new Set(['claude', 'pi', 'codex', 'deepseek']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const mapping = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export function resolveConfiguredAgents(
  config: DisclaudeConfig
): { ok: true; presets: AgentPresets } | { ok: false; errors: string[] } {
  const errors: string[] = [];
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
  const credentialEnvKeys = new Set<string>();
  for (const [name, raw] of Object.entries(llms)) {
    const field = `llms.${name}`;
    if (!mapping(raw)) {
      errors.push(`${field} must be a mapping`);
      continue;
    }
    for (const key of Object.keys(raw)) {
      if (!['model', 'reasoningEffort', 'maxConcurrentSessions', 'api', 'env'].includes(key)) {
        errors.push(`${field}.${key} is unsupported`);
      }
    }
    const llm = raw as LlmConfig;
    if (llm.model !== undefined && (typeof llm.model !== 'string' || !llm.model.trim())) {
      errors.push(`${field}.model must be a non-empty string`);
    }
    if (llm.reasoningEffort !== undefined && !isCodexReasoningEffort(llm.reasoningEffort)) {
      errors.push(`${field}.reasoningEffort is invalid`);
    }
    if (llm.maxConcurrentSessions !== undefined &&
        (!Number.isSafeInteger(llm.maxConcurrentSessions) || llm.maxConcurrentSessions <= 0)) {
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
            url.password
          ) {
            throw new Error('invalid endpoint');
          }
        } catch {
          errors.push(`${field}.api.baseUrl must be an HTTP(S) URL without credentials`);
        }
      }
      const keyEnv = apiCredentialEnvName(llm.api);
      if (!keyEnv) {
        errors.push(`${field}.api.apiKey must be an environment reference ($VARIABLE or \u0024{VARIABLE})`);
      } else {
        credentialEnvKeys.add(keyEnv);
      }
    }
  }

  if (errors.length) {
    return { ok: false, errors };
  }
  const presets: AgentPresets = {};
  for (const [name, raw] of Object.entries(config.agents as Record<string, AgentDefinition>)) {
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
      'permissionMode',
      'fullAccess',
      'codexSandbox',
      'codexNetworkAccess',
      'codex',
      'maxConcurrentTasks',
      'enableAgentTeams',
      'autoCompactWindow',
      'sdkTimeoutMs',
      'deepseek',
    ]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) {
        errors.push(`${field}.${key} is unsupported; models and API connections belong in llms`);
      }
    }
    if (!BACKENDS.has(agent.backend)) {
      errors.push(`${field}.backend must be claude, pi, codex or deepseek`);
    }
    if (typeof agent.llm !== 'string' || !Object.hasOwn(llms, agent.llm)) {
      errors.push(`${field}.llm must reference a defined llms entry`);
      continue;
    }
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
        (!Number.isInteger(agent[key]) || (agent[key] as number) < 0)
      ) {
        errors.push(`${field}.${key} must be a non-negative integer`);
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
        if (
          !['transport', 'maxActiveSessions', 'maxConcurrentRuns'].includes(key)
        ) {
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
    if (
      agent.deepseek?.mode !== undefined &&
      !['minimal', 'standard'].includes(agent.deepseek.mode)
    ) {
      errors.push(`${field}.deepseek.mode must be minimal or standard`);
    }
    const llm = llms[agent.llm];
    if (!llm || typeof llm !== 'object') {
      continue;
    }
    if (agent.backend === 'claude' && llm.api?.protocol === 'openai') {
      errors.push(`${field}: Claude requires an Anthropic API connection`);
    }
    if (llm.reasoningEffort !== undefined && !['codex', 'deepseek'].includes(agent.backend)) {
      errors.push(`llms.${agent.llm}.reasoningEffort requires a Codex or DSH native runtime`);
    }
    if (['codex', 'deepseek'].includes(agent.backend) && llm.api !== undefined) {
      errors.push(
        `${field}: this native runtime owns its API connection; omit llms.${agent.llm}.api`
      );
    }
    const protocol = llm.api?.protocol;
    const keyEnv = llm.api ? apiCredentialEnvName(llm.api) : undefined;
    const environmentModel = protocol === 'openai' ? 'OPENAI_MODEL' : 'ANTHROPIC_MODEL';
    const { backend, ...settings } = agent;
    presets[name] = {
      ...settings,
      agentBackend: backend,
      reasoningEffort: llm.reasoningEffort,
      maxConcurrentSessions: llm.maxConcurrentSessions,
      model:
        llm.model?.trim() ||
        (protocol
          ? process.env[environmentModel]?.trim() || config.env?.[environmentModel]?.trim()
          : '') ||
        '',
      apiKey: keyEnv ? (process.env[keyEnv] ?? config.env?.[keyEnv] ?? '') : '',
      apiProtocol: protocol,
      apiBaseUrl: llm.api?.baseUrl,
      env: llm.env,
      credentialEnvKeys: [...credentialEnvKeys],
    };
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
  if (preset.agentBackend === 'codex' || preset.agentBackend === 'deepseek') {
    return undefined;
  }
  if (!preset.apiProtocol) {
    return `llms.${preset.llm}.api is required for this runtime`;
  }
  if (!preset.apiKey.trim()) {
    return `The credential referenced by llms.${preset.llm}.api.apiKey is missing`;
  }
  if (!preset.model.trim()) {
    return `llms.${preset.llm}.model or the matching API model environment variable is required`;
  }
  return undefined;
}
