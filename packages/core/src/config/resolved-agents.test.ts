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
    },
    assistant: { backend: 'claude', llm: 'proxy' },
    other: { backend: 'pi', llm: 'other' },
  },
  llms: {
    daily: { model: 'gpt-6-luna', reasoningEffort: 'max', maxConcurrentSessions: 3 },
    proxy: {
      model: 'glm-5.3',
      api: { protocol: 'anthropic', baseUrl: 'https://proxy.example', apiKey: '$PROXY_KEY' },
    },
    other: { model: 'other-model', api: { protocol: 'openai', apiKey: '$OTHER_KEY' } },
  },
  channels: { feishu: { appId: 'test-app', appSecret: '$FEISHU_APP_SECRET' } },
});

describe('named runtime and LLM configuration', () => {
  it.each(['steer', 'stream', 'queue'] as const)('preserves busy input policy %s on its named agent', busyInput => {
    const config = configuration();
    config.agents!.assistant.busyInput = busyInput;
    const result = resolveConfiguredAgents(config);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.presets.assistant.busyInput).toBe(busyInput); }
  });

  it('rejects unknown busy input policies', () => {
    const config = configuration();
    config.agents!.assistant.busyInput = 'interrupt' as never;
    const result = resolveConfiguredAgents(config);
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.errors).toContain('agents.assistant.busyInput must be steer, stream or queue'); }
  });

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
      config.llms!.selected = {
        model: 'glm-5.3',
        api: { protocol, baseUrl: 'https://selected.example/v1', apiKey: '${DSH_KEY}' },
      };
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
      config.llms!.selected = { model: 'glm-5.3', api: api as never };
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
    config.llms!.selected = {
      model: 'glm-5.3',
      api: { protocol: 'openai', baseUrl: 'https://selected.example/v1', apiKey: '$DSH_KEY' },
    };
    expect(validateRequiredConfig(config).valid).toBe(true);
    const result = resolveConfiguredAgents(config);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(validateResolvedAgent(result.presets.dsh)).toContain('credential');
    }
  });

  it('keeps minimal DSH settings on a named DSH agent with a Codex default', () => {
    const config = configuration();
    config.llms!.native = {
      model: 'glm-5.3',
      api: { protocol: 'openai', baseUrl: 'https://dsh.example/v1', apiKey: '$DSH_TEST_KEY' },
    };
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
    config.llms!.native = {
      model: 'glm-5.3',
      api: { protocol: 'openai', baseUrl: 'https://dsh.example/v1', apiKey: '$DSH_TEST_KEY' },
    };
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
      config.llms!.native = {
        model: 'glm-5.3',
        api: { protocol: 'openai', baseUrl: 'https://dsh.example/v1', apiKey: '$DSH_TEST_KEY' },
      };
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
      llm: backend === 'codex' ? 'daily' : 'proxy',
      dsh: { provider: 'native-route' },
    } as never;
    expect(resolveConfiguredAgents(config)).toMatchObject({
      ok: false,
      errors: [
        `agents.misplaced.dsh is unsupported; keep mode and dshHome on the agent and move protocol, baseUrl and credential reference to llms.${backend === 'codex' ? 'daily' : 'proxy'}.api`,
      ],
    });
  });

  it.each(['minimal', 'standard'] as const)(
    'accepts %s mode and home without a dsh connection block',
    (mode) => {
      const config = configuration();
      config.llms!.native = {
        model: 'glm-5.3',
        api: { protocol: 'openai', baseUrl: 'https://dsh.example/v1', apiKey: '$DSH_TEST_KEY' },
      };
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
      llm: backend === 'codex' ? 'daily' : 'proxy',
      mode: 'minimal',
    };
    expect(resolveConfiguredAgents(config)).toEqual({
      ok: false,
      errors: ['agents.misplaced.mode requires backend: dsh'],
    });
  });

  it.each([null, false, 42, '', 'typo', {}])('rejects malformed mode (%j)', (mode) => {
    const config = configuration();
    config.llms!.native = {
      model: 'glm-5.3',
      api: { protocol: 'openai', baseUrl: 'https://dsh.example/v1', apiKey: '$DSH_TEST_KEY' },
    };
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
      config.llms!.native = {
        model: 'glm-5.3',
        api: { protocol: 'openai', baseUrl: 'https://dsh.example/v1', apiKey: '$DSH_TEST_KEY' },
      };
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
      llm: backend === 'codex' ? 'daily' : 'proxy',
      dshHome: '/selected-home',
    };
    expect(resolveConfiguredAgents(config)).toEqual({
      ok: false,
      errors: ['agents.misplaced.dshHome requires backend: dsh'],
    });
  });

  it.each([null, false, 42, '', '   ', {}])('rejects malformed dshHome (%j)', (dshHome) => {
    const config = configuration();
    config.llms!.native = {
      model: 'glm-5.3',
      api: { protocol: 'openai', baseUrl: 'https://dsh.example/v1', apiKey: '$DSH_TEST_KEY' },
    };
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
      config.llms!.native = {
        model: 'glm-5.3',
        api: { protocol: 'openai', baseUrl: 'https://dsh.example/v1', apiKey: '$DSH_TEST_KEY' },
      };
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
    config.llms!.native = {
      model: 'glm-5.3',
      api: { protocol: 'openai', baseUrl: 'https://dsh.example/v1', apiKey: '$DSH_TEST_KEY' },
    };
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
      model: 'gpt-6-luna',
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
      c.llms!.daily.model = 'claude-sonnet';
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
});
