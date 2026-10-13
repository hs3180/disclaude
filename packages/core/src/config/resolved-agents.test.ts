import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfiguredAgents, validateResolvedAgent } from './resolved-agents.js';
import { resolveAgentPreset } from './agent-presets.js';
import { validateConfig, validateRequiredConfig } from './loader.js';
import { buildSdkEnv } from '../utils/sdk.js';
import type { DisclaudeConfig } from './types.js';

afterEach(() => vi.unstubAllEnvs());
const configuration = (): DisclaudeConfig => ({
  agents: {
    daily: {
      backend: 'codex',
      llm: 'daily',
      default: true,
      codex: { reasoningEffort: 'max' },
    },
    assistant: { backend: 'claude', llm: 'proxy' },
    other: { backend: 'pi', llm: 'other' },
  },
  llms: {
    daily: { model: 'gpt-6-luna' },
    proxy: {
      model: 'glm-5.3',
      api: { protocol: 'anthropic', baseUrl: 'https://proxy.example', apiKeyEnv: 'PROXY_KEY' },
    },
    other: { model: 'other-model', api: { protocol: 'openai', apiKeyEnv: 'OTHER_KEY' } },
  },
  channels: { feishu: { appId: 'test-app', appSecretEnv: 'FEISHU_APP_SECRET' } },
});

describe('named runtime and LLM configuration', () => {
  it('resolves model vendors through API formats and independently binds native agents', () => {
    vi.stubEnv('PROXY_KEY', 'proxy-secret');
    const result = resolveConfiguredAgents(configuration());
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.presets.assistant).toMatchObject({
      model: 'glm-5.3',
      apiProtocol: 'anthropic',
      apiKey: 'proxy-secret',
    });
    expect(result.presets.other.apiProtocol).toBe('openai');
    expect(result.presets.daily).toMatchObject({
      apiKey: '',
      model: 'gpt-6-luna',
      codex: { reasoningEffort: 'max' },
    });
    expect(resolveAgentPreset(result.presets)).toMatchObject({ ok: true, name: 'daily' });
  });
  it('validates only selected credentials and permits a native default with dormant API bindings', () => {
    vi.stubEnv('PROXY_KEY', '');
    vi.stubEnv('OTHER_KEY', '');
    const config = configuration();
    expect(validateRequiredConfig(config).valid).toBe(true);
    const result = resolveConfiguredAgents(config);
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }
    expect(validateResolvedAgent(result.presets.assistant)).toContain('llms.proxy.api.apiKeyEnv');
  });
  it('prefers the service environment over defaults and injects only selected API credentials', () => {
    vi.stubEnv('PROXY_KEY', 'selected-secret');
    vi.stubEnv('OTHER_KEY', 'other-secret');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'host-bearer');
    vi.stubEnv('OPENAI_API_KEY', 'host-openai');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://host.example');
    const config = configuration();
    config.env = { PROXY_KEY: 'default-secret' };
    const result = resolveConfiguredAgents(config);
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }
    const preset = result.presets.assistant;
    const env = buildSdkEnv(preset.apiKey, preset.apiBaseUrl, {}, false, undefined, {
      protocol: preset.apiProtocol,
      credentialEnvKeys: preset.credentialEnvKeys,
    });
    expect(env.ANTHROPIC_API_KEY).toBe('selected-secret');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example');
    for (const key of ['PROXY_KEY', 'OTHER_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
      expect(env[key]).toBeUndefined();
    }
    expect(process.env.OTHER_KEY).toBe('other-secret');
  });
  it('projects an OpenAI connection without inherited Anthropic credentials or endpoint', () => {
    vi.stubEnv('OTHER_KEY', 'openai-secret'); vi.stubEnv('ANTHROPIC_API_KEY', 'host-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://host-openai.example');
    const result = resolveConfiguredAgents(configuration());
    if (!result.ok) { throw new Error(result.errors.join('\n')); }
    const preset = result.presets.other;
    const env = buildSdkEnv(preset.apiKey, preset.apiBaseUrl, {}, false, undefined,
      { protocol: preset.apiProtocol, credentialEnvKeys: preset.credentialEnvKeys });
    expect(env.OPENAI_API_KEY).toBe('openai-secret');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
  it('uses API model environment fallback without overriding explicit model identifiers', () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'environment-model');
    const config = configuration();
    delete config.llms!.proxy.model;
    let result = resolveConfiguredAgents(config);
    expect(result).toMatchObject({
      ok: true,
      presets: { assistant: { model: 'environment-model' } },
    });
    config.llms!.proxy.model = 'explicit-model';
    result = resolveConfiguredAgents(config);
    expect(result).toMatchObject({ ok: true, presets: { assistant: { model: 'explicit-model' } } });
  });
  it('rejects old sections with migration guidance and no credential values', () => {
    const legacy = {
      agent: { model: 'old' },
      glm: { apiKey: 'canary-secret' },
    } as unknown as DisclaudeConfig;
    const result = resolveConfiguredAgents(legacy);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain('docs/agent-configuration.md');
    expect(JSON.stringify(result)).not.toContain('canary-secret');
  });
  it.each([
    (c: DisclaudeConfig) => {
      c.agents!.assistant.llm = 'undefined';
    },
    (c: DisclaudeConfig) => {
      c.agents!.assistant.default = true;
    },
    (c: DisclaudeConfig) => {
      c.llms!.proxy.api!.protocol = 'vendor' as never;
    },
    (c: DisclaudeConfig) => {
      c.llms!.proxy.api!.baseUrl = 'file:///invalid';
    },
    (c: DisclaudeConfig) => {
      c.llms!.proxy.api!.baseUrl = 'https://user:canary-secret@example.com';
    },
    (c: DisclaudeConfig) => {
      c.llms!.proxy.api!.apiKeyEnv = 'literal key';
    },
    (c: DisclaudeConfig) => {
      c.llms!.daily.api = { protocol: 'anthropic' };
    },
    (c: DisclaudeConfig) => {
      c.llms!.daily.model = 'claude-sonnet';
    },
    (c: DisclaudeConfig) => {
      c.agents!.daily.codex!.maxConcurrentRuns = 0;
    },
    (c: DisclaudeConfig) => {
      c.agents!.daily.fullAccess = true;
      c.agents!.daily.codexSandbox = 'read-only';
    },
    (c: DisclaudeConfig) => {
      c.agents!.assistant.autoCompactWindow = -1;
    },
    (c: DisclaudeConfig) => {
      c.agents!.assistant.sdkTimeoutMs = 1.5;
    },
  ])('rejects invalid references, formats, endpoints and runtime settings', (mutate) => {
    const config = configuration();
    mutate(config);
    expect(validateConfig(config)).toBe(false);
    expect(JSON.stringify(resolveConfiguredAgents(config))).not.toContain('canary-secret');
  });
});
