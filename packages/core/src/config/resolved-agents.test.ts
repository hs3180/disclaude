import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveConfiguredAgents, validateResolvedAgent } from './resolved-agents.js';
import { resolveAgentPreset } from './agent-presets.js';
import { validateConfig, validateRequiredConfig } from './loader.js';
import { buildSdkEnv } from '../utils/sdk.js';
import type { DisclaudeConfig, LlmConfig } from './types.js';

afterEach(() => vi.unstubAllEnvs());
const configuration = (): DisclaudeConfig => ({
  agents: {
    daily: {
      backend: 'codex',
      llm: 'daily',
      default: true,
    },
    assistant: { backend: 'claude', llm: 'proxy' },
    other: { backend: 'pi', llm: 'other' },
  },
  llms: {
    daily: { defaultModel: 'gpt-6-luna', reasoningEffort: 'max', maxConcurrentSessions: 3 },
    proxy: {
      defaultModel: 'glm-5.3',
      api: { protocol: 'anthropic', baseUrl: 'https://proxy.example', apiKey: '$PROXY_KEY' },
    },
    other: { defaultModel: 'other-model', api: { protocol: 'openai', apiKey: '$OTHER_KEY' } },
  },
  channels: { feishu: { appId: 'test-app', appSecret: '$FEISHU_APP_SECRET' } },
});

// Shared preset builders (review: deduplicate test preset configuration).
// The same named-LLM bindings recur across the suites below; construct them
// once so repeated fixtures stay in sync. Behaviour assertions are unchanged.
const nativeDshLlm = (): LlmConfig => ({
  defaultModel: 'glm-5.3',
  api: { protocol: 'openai', baseUrl: 'https://dsh.example/v1', apiKey: '$DSH_TEST_KEY' },
});
const selectedDshLlm = (protocol: 'openai' | 'anthropic', apiKeyRef = '$DSH_KEY'): LlmConfig => ({
  defaultModel: 'glm-5.3',
  api: { protocol, baseUrl: 'https://selected.example/v1', apiKey: apiKeyRef },
});
const nonDshLlmBinding = (backend: string) => (backend === 'codex' ? 'daily' : 'proxy');
const kimiTierOverrides = { 'claude-opus-5': 'kimi-k3', 'claude-sonnet-4-5': 'kimi-k3-flash' };
const tierEnv = (opus: string, sonnet = opus, haiku = opus) => ({
  ANTHROPIC_DEFAULT_OPUS_MODEL: opus,
  ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: haiku,
});

describe('named runtime and LLM configuration', () => {
  it('accepts explicit auto metadata discovery as an opt-in', () => {
    const config = configuration();
    config.agents!.assistant.autoCompactWindow = 'auto';
    expect(validateConfig(config)).toBe(true);
    const result = resolveConfiguredAgents(config);
    expect(result.ok && result.presets.assistant.autoCompactWindow).toBe('auto');
  });
  it.each(['openai', 'anthropic'] as const)(
    'resolves a DSH %s connection from its LLM',
    (protocol) => {
      vi.stubEnv('DSH_KEY', 'selected-test-key');
      const config = configuration();
      config.agents!.dsh = { backend: 'dsh', llm: 'selected', mode: 'minimal' };
      config.llms!.selected = selectedDshLlm(protocol, '${DSH_KEY}');
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.presets.dsh).toMatchObject({
        apiProtocol: protocol,
        apiBaseUrl: 'https://selected.example/v1',
        apiKey: 'selected-test-key',
      });
      expect(validateResolvedAgent(result.presets.dsh)).toBeUndefined();
    }
  );

  it.each([undefined, { protocol: 'openai', apiKey: '$DSH_KEY' }])(
    'requires an explicit DSH connection and address (%j)',
    (api) => {
      const config = configuration();
      config.agents!.dsh = { backend: 'dsh', llm: 'selected' };
      config.llms!.selected = { defaultModel: 'glm-5.3', api: api as never };
      expect(resolveConfiguredAgents(config)).toEqual({
        ok: false,
        errors: [
          'llms.selected.api with protocol, baseUrl and credential reference is required for DSH',
        ],
      });
    }
  );

  it('requires the selected DSH credential without blocking a dormant binding', () => {
    vi.stubEnv('DSH_KEY', '');
    const config = configuration();
    config.agents!.dsh = { backend: 'dsh', llm: 'selected' };
    config.llms!.selected = selectedDshLlm('openai');
    expect(validateRequiredConfig(config).valid).toBe(true);
    const result = resolveConfiguredAgents(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validateResolvedAgent(result.presets.dsh)).toContain('credential');
    }
  });

  it('keeps minimal DSH settings on a named DSH agent with a Codex default', () => {
    const config = configuration();
    config.llms!.native = nativeDshLlm();
    config.agents!.dsh = {
      backend: 'dsh',
      llm: 'native',
      mode: 'minimal',
      dshHome: '/dsh-home',
    };
    expect(resolveConfiguredAgents(config)).toMatchObject({
      ok: true,
      presets: {
        dsh: {
          agentBackend: 'dsh',
          mode: 'minimal',
          dshHome: '/dsh-home',
          apiProtocol: 'openai',
          apiBaseUrl: 'https://dsh.example/v1',
        },
      },
    });
  });

  it('rejects the legacy backend with migration guidance', () => {
    const config = configuration();
    config.llms!.native = nativeDshLlm();
    config.agents!.dsh = { backend: 'deepseek' as never, llm: 'native' };
    expect(resolveConfiguredAgents(config)).toEqual({
      ok: false,
      errors: ['agents.dsh.backend deepseek is unsupported; use backend: dsh'],
    });
  });

  it.each(['dsh', 'codex', 'pi', 'claude'] as const)(
    'rejects a deepseek block under %s with migration guidance',
    (backend) => {
      const config = configuration();
      config.llms!.native = nativeDshLlm();
      const binding = backend === 'codex' ? 'daily' : backend === 'dsh' ? 'native' : 'proxy';
      config.agents!.legacy = { backend, llm: binding, deepseek: { mode: 'minimal' } } as never;
      expect(resolveConfiguredAgents(config)).toEqual({
        ok: false,
        errors: [
          `agents.legacy.deepseek is unsupported; keep mode and dshHome on the agent and move protocol, baseUrl and credential reference to llms.${binding}.api`,
        ],
      });
    }
  );

  it.each(['codex', 'pi', 'claude'] as const)('rejects DSH settings under %s', (backend) => {
    const config = configuration();
    config.agents!.misplaced = {
      backend,
      llm: nonDshLlmBinding(backend),
      dsh: { provider: 'native-route' },
    } as never;
    expect(resolveConfiguredAgents(config)).toMatchObject({
      ok: false,
      errors: [
        `agents.misplaced.dsh is unsupported; keep mode and dshHome on the agent and move protocol, baseUrl and credential reference to llms.${nonDshLlmBinding(backend)}.api`,
      ],
    });
  });

  it.each(['minimal', 'standard'] as const)(
    'accepts %s mode and home without a dsh connection block',
    (mode) => {
      const config = configuration();
      config.llms!.native = nativeDshLlm();
      config.agents!.dsh = { backend: 'dsh', llm: 'native', mode, dshHome: '/selected-home' };
      expect(resolveConfiguredAgents(config)).toMatchObject({
        ok: true,
        presets: {
          dsh: { agentBackend: 'dsh', mode, dshHome: '/selected-home' },
        },
      });
    }
  );

  it.each(['codex', 'pi', 'claude'] as const)('rejects unsupported mode on %s', (backend) => {
    const config = configuration();
    config.agents!.misplaced = {
      backend,
      llm: nonDshLlmBinding(backend),
      mode: 'minimal',
    };
    expect(resolveConfiguredAgents(config)).toEqual({
      ok: false,
      errors: ['agents.misplaced.mode requires backend: dsh'],
    });
  });

  it.each([null, false, 42, '', 'typo', {}])('rejects malformed mode (%j)', (mode) => {
    const config = configuration();
    config.llms!.native = nativeDshLlm();
    config.agents!.dsh = { backend: 'dsh', llm: 'native', mode: mode as never };
    expect(resolveConfiguredAgents(config)).toEqual({
      ok: false,
      errors: ['agents.dsh.mode must be minimal or standard'],
    });
  });

  it.each([undefined, 'standard'] as const)(
    'rejects nested mode with migration guidance (flat mode: %s)',
    (mode) => {
      const config = configuration();
      config.llms!.native = nativeDshLlm();
      config.agents!.dsh = {
        backend: 'dsh',
        llm: 'native',
        mode,
        dsh: { mode: 'minimal' },
      } as never;
      expect(resolveConfiguredAgents(config)).toEqual({
        ok: false,
        errors: [
          'agents.dsh.dsh is unsupported; keep mode and dshHome on the agent and move protocol, baseUrl and credential reference to llms.native.api',
        ],
      });
    }
  );

  it.each(['codex', 'pi', 'claude'] as const)('rejects unsupported dshHome on %s', (backend) => {
    const config = configuration();
    config.agents!.misplaced = {
      backend,
      llm: nonDshLlmBinding(backend),
      dshHome: '/selected-home',
    };
    expect(resolveConfiguredAgents(config)).toEqual({
      ok: false,
      errors: ['agents.misplaced.dshHome requires backend: dsh'],
    });
  });

  it.each([null, false, 42, '', '   ', {}])('rejects malformed dshHome (%j)', (dshHome) => {
    const config = configuration();
    config.llms!.native = nativeDshLlm();
    config.agents!.dsh = { backend: 'dsh', llm: 'native', dshHome: dshHome as never };
    expect(resolveConfiguredAgents(config)).toEqual({
      ok: false,
      errors: ['agents.dsh.dshHome must be a non-empty string'],
    });
  });

  it.each([undefined, '/selected-home'])(
    'rejects nested home with migration guidance (flat home: %s)',
    (dshHome) => {
      const config = configuration();
      config.llms!.native = nativeDshLlm();
      config.agents!.dsh = {
        backend: 'dsh',
        llm: 'native',
        dshHome,
        dsh: { dshHome: '/legacy-home' },
      } as never;
      expect(resolveConfiguredAgents(config)).toEqual({
        ok: false,
        errors: [
          'agents.dsh.dsh is unsupported; keep mode and dshHome on the agent and move protocol, baseUrl and credential reference to llms.native.api',
        ],
      });
    }
  );

  it.each([
    null,
    'minimal',
    { mode: 'typo' },
    { provider: '' },
    { dshHome: 42 },
    { apiKeyEnv: '$DSH_TEST_KEY' },
    { ignoredSetting: true },
  ])('rejects malformed or ignored DSH settings (%j)', (dsh) => {
    const config = configuration();
    config.llms!.native = nativeDshLlm();
    config.agents!.dsh = { backend: 'dsh', llm: 'native', dsh } as never;
    expect(resolveConfiguredAgents(config).ok).toBe(false);
  });

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
      reasoningEffort: 'max',
      maxConcurrentSessions: 3,
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
    expect(validateResolvedAgent(result.presets.assistant)).toContain('llms.proxy.api.apiKey');
  });
  it('injects only the selected external API credentials and endpoint', () => {
    vi.stubEnv('PROXY_KEY', 'selected-secret');
    vi.stubEnv('OTHER_KEY', 'other-secret');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'host-bearer');
    vi.stubEnv('OPENAI_API_KEY', 'host-openai');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://host.example');
    const config = configuration();
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
    vi.stubEnv('OTHER_KEY', 'openai-secret');
    vi.stubEnv('ANTHROPIC_API_KEY', 'host-key');
    vi.stubEnv('OPENAI_BASE_URL', 'https://host-openai.example');
    const result = resolveConfiguredAgents(configuration());
    if (!result.ok) {
      throw new Error(result.errors.join('\n'));
    }
    const preset = result.presets.other;
    const env = buildSdkEnv(preset.apiKey, preset.apiBaseUrl, {}, false, undefined, {
      protocol: preset.apiProtocol,
      credentialEnvKeys: preset.credentialEnvKeys,
    });
    expect(env.OPENAI_API_KEY).toBe('openai-secret');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_BASE_URL).toBeUndefined();
  });
  it('allows an omitted provider default model without environment fallback', () => {
    vi.stubEnv('CODEX_MODEL', 'gpt-6-luna');
    const config = configuration();
    delete config.llms!.daily.defaultModel;
    expect(resolveConfiguredAgents(config)).toMatchObject({ ok: true, presets: { daily: { model: '' } } });
  });
  it.each(['', '   '])('rejects a blank provider default model (%j)', (model) => {
    const config = configuration();
    config.llms!.daily.defaultModel = model;
    expect(resolveConfiguredAgents(config)).toEqual({ ok: false, errors: [
      'llms.daily.defaultModel must be a non-empty string when set',
    ] });
  });
  it('rejects the pre-rename provider model key with migration guidance', () => {
    const config = configuration();
    (config.llms!.proxy as unknown as Record<string, unknown>).model = 'glm-5.3';
    expect(resolveConfiguredAgents(config)).toEqual({ ok: false, errors: [
      'llms.proxy.model has been renamed to llms.proxy.defaultModel; agents can use any model of this provider and defaultModel only sets the default',
    ] });
  });
  it.each([
    ['proxy', 'ANTHROPIC_MODEL'],
    ['other', 'OPENAI_MODEL'],
  ])('does not fill an omitted llms.%s.defaultModel from %s', (name, variable) => {
    vi.stubEnv(variable, 'inherited-model');
    const config = configuration();
    config.env = { [variable]: 'global-model' };
    delete config.llms![name].defaultModel;
    const result = resolveConfiguredAgents(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.presets[name === 'proxy' ? 'assistant' : 'other'].model).toBe('');
    }
  });
  it('keeps explicit models independent for two agents on the same backend', () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'unrelated-global-model');
    const config = configuration();
    config.agents!.second = { backend: 'claude', llm: 'second' };
    config.llms!.second = {
      defaultModel: 'second-explicit-model',
      api: { protocol: 'anthropic', baseUrl: 'https://second.example', apiKey: '$SECOND_KEY' },
    };
    expect(resolveConfiguredAgents(config)).toMatchObject({ ok: true, presets: {
      assistant: { agentBackend: 'claude', model: 'glm-5.3', apiBaseUrl: 'https://proxy.example' },
      second: { agentBackend: 'claude', model: 'second-explicit-model', apiBaseUrl: 'https://second.example' },
    } });
  });
  it('accepts an empty resolved model as the runtime default', () => {
    const result = resolveConfiguredAgents(configuration());
    if (!result.ok) { throw new Error(result.errors.join('\n')); }
    result.presets.daily.model = '';
    expect(validateResolvedAgent(result.presets.daily)).toBeUndefined();
  });
  it('resolves braced references and never expands embedded or shell expressions', () => {
    const config = configuration();
    config.llms!.proxy.api!.apiKey = '${PROXY_KEY}';
    vi.stubEnv('PROXY_KEY', 'selected-secret');
    expect(resolveConfiguredAgents(config)).toMatchObject({
      ok: true,
      presets: { assistant: { apiKey: 'selected-secret' } },
    });
    for (const value of [
      'PROXY_KEY',
      'canary-secret',
      '$PROXY_KEY suffix',
      '${PROXY_KEY:-fallback}',
      '$(PROXY_KEY)',
    ]) {
      config.llms!.proxy.api!.apiKey = value;
      const resolved = resolveConfiguredAgents(config);
      expect(resolved.ok).toBe(false);
      expect(JSON.stringify(resolved)).not.toContain(value);
    }
  });
  it('binds shared model settings independently of the default agent', () => {
    const config = configuration();
    config.agents!.secondary = { backend: 'codex', llm: 'daily' };
    config.agents!.independent = { backend: 'codex', llm: 'independent' };
    config.llms!.independent = {
      defaultModel: 'gpt-6-luna',
      reasoningEffort: 'low',
      maxConcurrentSessions: 1,
    };
    expect(resolveConfiguredAgents(config)).toMatchObject({
      ok: true,
      presets: {
        secondary: { llm: 'daily', reasoningEffort: 'max', maxConcurrentSessions: 3 },
        independent: { llm: 'independent', reasoningEffort: 'low', maxConcurrentSessions: 1 },
      },
    });
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
      c.llms!.proxy.api!.apiKey = 'literal key';
    },
    (c: DisclaudeConfig) => {
      c.llms!.daily.api = { protocol: 'anthropic' };
    },
    (c: DisclaudeConfig) => {
      c.llms!.daily.defaultModel = 'claude-sonnet';
    },
    (c: DisclaudeConfig) => {
      c.agents!.daily.codex = { maxConcurrentRuns: 0 };
    },
    (c: DisclaudeConfig) => {
      c.llms!.daily.maxConcurrentSessions = 0;
    },
    (c: DisclaudeConfig) => {
      c.llms!.daily.maxConcurrentSessions = 1.5;
    },
    (c: DisclaudeConfig) => {
      c.llms!.daily.reasoningEffort = 'invalid' as never;
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
  it('compiles behavesAs into a single-entry modelOverrides map (Issue #5410)', () => {
    const config = configuration();
    config.agents!.assistant.claude = { ...config.agents!.assistant.claude, behavesAs: 'claude-opus-5' };
    const result = resolveConfiguredAgents(config);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.presets.assistant.modelOverrides).toEqual({ 'claude-opus-5': 'glm-5.3' });
  });
  it('projects a raw multi-slot modelOverrides map verbatim', () => {
    const config = configuration();
    config.agents!.assistant.claude = { ...config.agents!.assistant.claude, modelOverrides: { ...kimiTierOverrides } };
    const result = resolveConfiguredAgents(config);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.presets.assistant.modelOverrides).toEqual(kimiTierOverrides);
  });
  it.each([
    (c: DisclaudeConfig) => {
      c.agents!.assistant.claude = { behavesAs: 'claude_OPUS' };
    },
    (c: DisclaudeConfig) => {
      c.agents!.assistant.claude = { behavesAs: '' };
    },
    (c: DisclaudeConfig) => {
      c.agents!.assistant.claude = { behavesAs: 'claude-opus-5', modelOverrides: { 'claude-opus-5': 'kimi-k3' } };
    },
    (c: DisclaudeConfig) => {
      c.agents!.assistant.claude = { modelOverrides: { opus: 'kimi-k3' } };
    },
    (c: DisclaudeConfig) => {
      c.agents!.assistant.claude = { modelOverrides: { 'claude-opus-5': '  ' } };
    },
    (c: DisclaudeConfig) => {
      c.agents!.assistant.claude = { modelOverrides: {} };
    },
    (c: DisclaudeConfig) => {
      c.agents!.assistant.claude = { modelOverrides: 'claude-opus-5' as unknown as Record<string, string> };
    },
    (c: DisclaudeConfig) => {
      (c.llms!.daily as unknown as Record<string, unknown>).behavesAs = 'claude-opus-5';
    },
  ])('rejects malformed or mis-scoped model override declarations', (mutate) => {
    const config = configuration();
    mutate(config);
    const result = resolveConfiguredAgents(config);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.errors.length).toBe(1);
    expect(result.errors.join('\n')).toMatch(/behavesAs|modelOverrides/);
  });
  it('defers a bare alias to runtime catalog resolution instead of compiling it (Issue #5422)', () => {
    const config = configuration();
    config.agents!.assistant.claude = { ...config.agents!.assistant.claude, behavesAs: 'opus' };
    const result = resolveConfiguredAgents(config);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.presets.assistant.behavesAsAlias).toBe('opus');
    expect(result.presets.assistant.modelOverrides).toBeUndefined();
  });
  it('normalizes a mixed-case bare alias to the catalog lookup form', () => {
    const config = configuration();
    config.agents!.assistant.claude = { ...config.agents!.assistant.claude, behavesAs: ' Opus ' };
    const result = resolveConfiguredAgents(config);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.presets.assistant.behavesAsAlias).toBe('opus');
  });

  describe('shared bindings across harnesses (Issue #5679)', () => {
    it('serves one wire model to Claude and DSH from a single binding', () => {
      const config = configuration();
      config.llms!.proxy.defaultModel = 'group/hq-degrade';
      config.agents!.assistant.claude = { ...config.agents!.assistant.claude, behavesAs: 'claude-sonnet-4-5' };
      config.agents!.research = { backend: 'dsh', llm: 'proxy' };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      // The wire model is identical for both providers; only the Claude
      // preset carries the capability mapping.
      expect(result.presets.assistant).toMatchObject({
        agentBackend: 'claude',
        model: 'group/hq-degrade',
        modelOverrides: { 'claude-sonnet-4-5': 'group/hq-degrade' },
      });
      expect(result.presets.research).toMatchObject({
        agentBackend: 'dsh',
        model: 'group/hq-degrade',
      });
    });

    it('keeps Claude mappings off a Pi-only agent', () => {
      const config = configuration();
      config.agents!.assistant.claude = { behavesAs: 'claude-sonnet-4-5' };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.presets.other).toMatchObject({
        agentBackend: 'pi',
        model: 'other-model',
        modelOverrides: undefined,
      });
    });

    it('rejects the old provider-level Claude mapping with migration guidance', () => {
      const config = configuration();
      (config.llms!.daily as unknown as Record<string, unknown>).behavesAs = 'claude-opus-5';
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors.join('\n')).toContain(
        'has moved to agents.<name>.claude.behavesAs'
      );
    });

    it('projects Claude model-name settings from the agent, not the provider', () => {
      const config = configuration();
      config.agents!.assistant.claude = {
        modelOverrides: { ...kimiTierOverrides },
        env: tierEnv('endpoint-large', 'endpoint-main', 'endpoint-fast'),
      };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.presets.assistant).toMatchObject({
        modelOverrides: { ...kimiTierOverrides },
        env: tierEnv('endpoint-large', 'endpoint-main', 'endpoint-fast'),
      });
      expect(result.presets.other.modelOverrides).toBeUndefined();
    });

    it('rejects the old Claude alias environment placement with migration guidance', () => {
      const config = configuration();
      config.llms!.proxy.env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'endpoint-main' };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors.join('\n')).toContain(
        'llms.proxy.env.ANTHROPIC_DEFAULT_SONNET_MODEL has moved to agents.<name>.claude.models or agents.<name>.claude.env.ANTHROPIC_DEFAULT_SONNET_MODEL'
      );
    });

    it('rejects a bare Claude alias shared across the harness boundary', () => {
      const config = configuration();
      config.llms!.proxy.defaultModel = 'sonnet';
      config.agents!.research = { backend: 'dsh', llm: 'proxy' };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors.join('\n')).toContain(
        'llms.proxy.defaultModel "sonnet" is a bare Claude alias'
      );
      expect(result.errors.join('\n')).toContain('dsh');
    });

    it('keeps a bare alias model on a DSH-only binding', () => {
      const config = configuration();
      config.agents!.research = { backend: 'dsh', llm: 'aliasonly' };
      config.llms!.aliasonly = {
        defaultModel: 'sonnet',
        api: { protocol: 'anthropic', baseUrl: 'https://gateway.example', apiKey: '$GW_KEY' },
      };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
    });

    it('passes explicit canonical model IDs through unchanged without mappings', () => {
      const config = configuration();
      config.llms!.proxy.defaultModel = 'claude-sonnet-4-5';
      config.agents!.research = { backend: 'dsh', llm: 'proxy' };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.presets.assistant.model).toBe('claude-sonnet-4-5');
      expect(result.presets.assistant.modelOverrides).toBeUndefined();
      expect(result.presets.research.model).toBe('claude-sonnet-4-5');
      expect(result.presets.research.modelOverrides).toBeUndefined();
    });

    it('rejects Claude model settings on a non-Claude agent', () => {
      const config = configuration();
      config.agents!.other.claude = { behavesAs: 'claude-opus-5' };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors.join('\n')).toContain('agents.other.claude requires backend: claude');
    });

    it('rejects a malformed or unknown Claude settings block', () => {
      const config = configuration();
      config.agents!.assistant.claude = 'claude-opus-5' as never;
      const malformed = resolveConfiguredAgents(config);
      expect(malformed.ok).toBe(false);
      if (malformed.ok) {
        return;
      }
      expect(malformed.errors.join('\n')).toContain('agents.assistant.claude must be a mapping');

      const unknown = configuration();
      unknown.agents!.assistant.claude = { tiers: { opus: 'kimi-k3' } } as never;
      const rejected = resolveConfiguredAgents(unknown);
      expect(rejected.ok).toBe(false);
      if (rejected.ok) {
        return;
      }
      expect(rejected.errors.join('\n')).toContain('agents.assistant.claude.tiers is unsupported');
    });

    it('rejects combining behavesAs with modelOverrides and malformed mappings', () => {
      const config = configuration();
      config.agents!.assistant.claude = {
        behavesAs: 'claude-opus-5',
        modelOverrides: { 'claude-opus-5': 'kimi-k3' },
      };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors.join('\n')).toContain(
        'agents.assistant.claude.behavesAs and modelOverrides are mutually exclusive'
      );

      const aliased = configuration();
      aliased.agents!.assistant.claude = { modelOverrides: { sonnet: 'kimi-k3' } };
      const aliasResult = resolveConfiguredAgents(aliased);
      expect(aliasResult.ok).toBe(false);
      if (aliasResult.ok) {
        return;
      }
      expect(aliasResult.errors.join('\n')).toContain(
        'agents.assistant.claude.modelOverrides must map full Claude model IDs to non-empty provider model IDs'
      );
    });

    it('requires a provider default model when behavesAs carries the capability slot', () => {
      const config = configuration();
      delete config.llms!.proxy.defaultModel;
      config.agents!.assistant.claude = { behavesAs: 'claude-opus-5' };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors.join('\n')).toContain(
        'agents.assistant.claude.behavesAs requires a provider default model at llms.proxy.defaultModel'
      );
    });
  });

  describe('Claude three-tier model mapping (review 2026-11-06)', () => {
    it('compiles explicit tiers into the native tier environment', () => {
      const config = configuration();
      config.agents!.assistant.claude = {
        models: { opus: 'kimi-k3', sonnet: 'kimi-k3-flash', haiku: 'kimi-k3-air' },
      };
      config.agents!.research = { backend: 'dsh', llm: 'proxy' };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.presets.assistant.env).toEqual(tierEnv('kimi-k3', 'kimi-k3-flash', 'kimi-k3-air'));
      // Tier metadata rides the Claude preset only; the DSH agent sharing the
      // binding keeps the wire model without Claude environment.
      expect(result.presets.research.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
    });

    it('falls back to the provider default for omitted tiers', () => {
      const config = configuration();
      config.agents!.assistant.claude = { models: { haiku: 'kimi-k3-air' } };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.presets.assistant.env).toEqual(tierEnv('glm-5.3', 'glm-5.3', 'kimi-k3-air'));
    });

    it('points all three tiers at the only configured model by default', () => {
      const config = configuration();
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.presets.assistant.env).toEqual(tierEnv('glm-5.3'));
      // Non-Claude runtimes never receive the tier environment.
      expect(result.presets.other.env).toEqual({});
    });

    it('keeps native tiers when neither models nor a default model is configured', () => {
      const config = configuration();
      delete config.llms!.proxy.defaultModel;
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.presets.assistant.env).toEqual({});
    });

    it('lets an explicit claude.env tier override the computed default', () => {
      const config = configuration();
      config.agents!.assistant.claude = {
        env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'endpoint-large' },
      };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.presets.assistant.env).toEqual(tierEnv('endpoint-large', 'glm-5.3', 'glm-5.3'));
    });

    it('rejects double-configuring one tier in models and env', () => {
      const config = configuration();
      config.agents!.assistant.claude = {
        models: { haiku: 'kimi-k3-air' },
        env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'small-model' },
      };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors.join('\n')).toContain(
        'agents.assistant.claude.models.haiku conflicts with agents.assistant.claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL; configure the tier in one place'
      );
    });

    it.each([
      {},
      { opus: '' },
      { sonnet: '   ' },
      { turbo: 'kimi-k3' },
      'kimi-k3',
    ])('rejects malformed tier declarations (%j)', (models) => {
      const config = configuration();
      config.agents!.assistant.claude = { models: models as never };
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.errors.length).toBe(1);
      expect(result.errors.join('\n')).toMatch(/agents\.assistant\.claude\.models/);
    });

    it('applies a provider reasoning effort to any runtime without a harness gate', () => {
      const config = configuration();
      config.llms!.proxy.reasoningEffort = 'high';
      const result = resolveConfiguredAgents(config);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.presets.assistant.reasoningEffort).toBe('high');
    });
  });
});
