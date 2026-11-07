import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisclaudeConfig, AgentConfig } from '../config/types.js';

const fixture = vi.hoisted(() => ({ value: {} as DisclaudeConfig }));

// Exercise real Config and SDK environment resolution without developer files.
vi.mock('../config/loader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config/loader.js')>()),
  loadConfigFile: () => ({ _fromFile: false }),
  getPreloadedConfig: () => null,
  getConfigFromFile: () => fixture.value,
  validateConfig: () => true,
}));
vi.mock('../sdk/index.js', () => ({ getProvider: () => ({ name: 'claude' }) }));
vi.mock('../config/runtime-env.js', () => ({ loadRuntimeEnv: () => ({}) }));

beforeEach(() => {
  vi.resetModules();
  for (const key of [
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  ]) {
    vi.stubEnv(key, undefined);
  }
  fixture.value = {
    workspace: { dir: '/owned-selected-model-test' },
    logging: { sdkDebug: false },
    agents: { default: { backend: 'codex', llm: 'default' } },
    llms: { default: { defaultModel: 'gpt-6-luna' } },
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('../sdk/providers/claude/version.js');
});

async function selectedOptions(
  model: string,
  env?: Record<string, string>,
  settings?: AgentConfig,
  modelOverrides?: Record<string, string>
) {
  const { BaseAgent } = await import('./base-agent.js');
  class SelectedAgent extends BaseAgent {
    protected getAgentName() {
      return 'OwnedSelectedModel';
    }
    options() {
      return this.createSdkOptions();
    }
  }
  return new SelectedAgent({
    apiKey: 'selected-key',
    apiProtocol: 'anthropic',
    model,
    env,
    settings,
    modelOverrides,
    agentBackend: 'claude',
  }).options();
}

describe('Claude native model aliases', () => {
  it('passes reasoning and the shared session budget from the selected LLM to native queries', async () => {
    fixture.value.agents!.secondary = { backend: 'codex', llm: 'default' };
    fixture.value.agents!.independent = { backend: 'codex', llm: 'other' };
    fixture.value.llms!.default.reasoningEffort = 'max';
    fixture.value.llms!.default.maxConcurrentSessions = 3;
    fixture.value.llms!.other = { defaultModel: 'gpt-6-luna', reasoningEffort: 'low', maxConcurrentSessions: 1 };
    const { BaseAgent } = await import('./base-agent.js');
    const { Config } = await import('../config/index.js');
    class BoundAgent extends BaseAgent {
      protected getAgentName() { return 'BoundAgent'; }
      options() { return this.createSdkOptions(); }
    }
    const presets = Config.getAgentPresets()!;
    for (const [name, llm, effort, cap] of [
      ['secondary', 'default', 'max', 3], ['independent', 'other', 'low', 1],
    ] as const) {
      const preset = presets[name];
      expect(new BoundAgent({ ...preset, settings: preset }).options()).toMatchObject({
        model: 'gpt-6-luna', reasoningEffort: effort,
        llmSessionLimit: { name: llm, maxConcurrentSessions: cap },
      });
    }
  });
  it('leaves unspecified subagent aliases to the native CLI', async () => {
    const options = await selectedOptions('glm-5.3');
    expect(options.model).toBe('glm-5.3');
    for (const alias of ['OPUS', 'SONNET', 'HAIKU']) {
      expect(options.env?.[`ANTHROPIC_DEFAULT_${alias}_MODEL`]).toBeUndefined();
    }
  });
  it('uses the selected agent defaults without inheriting another agent runtime policy', async () => {
    fixture.value.agents!.default.enableAgentTeams = true;
    fixture.value.agents!.default.autoCompactWindow = 80000;
    fixture.value.agents!.default.sdkTimeoutMs = 1000;
    vi.stubEnv('ANTHROPIC_TIMEOUT', undefined);
    const options = await selectedOptions('sonnet', undefined, {});
    expect(options.teammateMode).toBeUndefined();
    expect(options.autoCompactWindow).toBeUndefined();
    expect(options.env?.ANTHROPIC_TIMEOUT).toBe('300000');
  });
  it('passes the selected LLM native aliases through and overrides inherited aliases', async () => {
    vi.stubEnv('ANTHROPIC_DEFAULT_SONNET_MODEL', 'host-model');
    const options = await selectedOptions('sonnet', {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'endpoint-large',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'endpoint-main',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'endpoint-fast',
    });
    expect(options.env).toMatchObject({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'endpoint-large',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'endpoint-main',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'endpoint-fast',
    });
  });
});


describe('Claude modelOverrides identity (Issue #5410)', () => {
  it('passes the resolved map to native queries with the current bundled CLI', async () => {
    const options = await selectedOptions('kimi-k3', undefined, undefined, {
      'claude-opus-5': 'kimi-k3',
    });
    expect(options.modelOverrides).toEqual({ 'claude-opus-5': 'kimi-k3' });
    expect(options.model).toBe('kimi-k3');
  });
  it('fails agent startup when the bundled Claude Code predates modelOverrides', async () => {
    vi.doMock('../sdk/providers/claude/version.js', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      bundledClaudeCodeVersion: () => '2.1.199',
    }));
    const { BaseAgent } = await import('./base-agent.js');
    class GateAgent extends BaseAgent {
      protected getAgentName() { return 'GateAgent'; }
    }
    expect(() => new GateAgent({
      apiKey: 'selected-key',
      apiProtocol: 'anthropic',
      model: 'kimi-k3',
      llm: 'gateway',
      modelOverrides: { 'claude-opus-5': 'kimi-k3' },
      agentBackend: 'claude',
    })).toThrow(/requires Claude Code >= 2\.1\.200.*claude\.modelOverrides/);
  });
  it('keeps overrides working when the bundled CLI version cannot be resolved', async () => {
    vi.doMock('../sdk/providers/claude/version.js', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      bundledClaudeCodeVersion: () => undefined,
    }));
    const options = await selectedOptions('kimi-k3', undefined, undefined, {
      'claude-opus-4-7': 'kimi-k3',
    });
    expect(options.modelOverrides).toEqual({ 'claude-opus-4-7': 'kimi-k3' });
  });
});

describe('Claude behavesAs bare alias (Issue #5422)', () => {
  async function aliasOptions(behavesAsAlias?: string, agentBackend: 'claude' | 'dsh' = 'claude') {
    const { BaseAgent } = await import('./base-agent.js');
    class AliasAgent extends BaseAgent {
      protected getAgentName() { return 'AliasAgent'; }
      options() { return this.createSdkOptions(); }
    }
    return new AliasAgent({
      apiKey: 'selected-key',
      apiProtocol: 'anthropic',
      model: 'kimi-k3',
      llm: 'gateway',
      behavesAsAlias,
      agentBackend,
    }).options();
  }
  it('threads the alias and its LLM identity to native queries without compiling modelOverrides', async () => {
    const options = await aliasOptions('opus');
    expect(options.behavesAsAlias).toBe('opus');
    expect(options.llm).toBe('gateway');
    expect(options.modelOverrides).toBeUndefined();
  });
  it('drops the alias for non-Claude runtimes', async () => {
    const options = await aliasOptions('opus', 'dsh');
    expect(options.behavesAsAlias).toBeUndefined();
    expect(options.llm).toBeUndefined();
  });
  it('fails agent startup when the bundled Claude Code predates the resolution APIs', async () => {
    vi.doMock('../sdk/providers/claude/version.js', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      bundledClaudeCodeVersion: () => '2.1.199',
    }));
    const { BaseAgent } = await import('./base-agent.js');
    class GateAliasAgent extends BaseAgent {
      protected getAgentName() { return 'GateAliasAgent'; }
    }
    expect(() => new GateAliasAgent({
      apiKey: 'selected-key',
      apiProtocol: 'anthropic',
      model: 'kimi-k3',
      llm: 'gateway',
      behavesAsAlias: 'opus',
      agentBackend: 'claude',
    })).toThrow(/behavesAs alias resolution requires Claude Code >= 2\.1\.200/);
  });
});

describe('shared bindings across harnesses (Issue #5679)', () => {
  beforeEach(() => {
    vi.stubEnv('SHARED_GATEWAY_KEY', 'shared-test-key');
    fixture.value = {
      workspace: { dir: '/shared-binding-test' },
      logging: { sdkDebug: false },
      agents: {
        assistant: {
          backend: 'claude', llm: 'shared', default: true,
          claude: { behavesAs: 'claude-sonnet-4-5' },
        },
        research: { backend: 'dsh', llm: 'shared', mode: 'minimal' },
      },
      llms: {
        shared: {
          defaultModel: 'group/hq-degrade',
          api: {
            protocol: 'anthropic',
            baseUrl: 'https://gateway.example',
            apiKey: '$SHARED_GATEWAY_KEY',
          },
        },
      },
    };
  });

  it('passes the identical wire model to both harness option paths', async () => {
    const { BaseAgent } = await import('./base-agent.js');
    const { Config } = await import('../config/index.js');
    class BoundAgent extends BaseAgent {
      protected getAgentName() {
        return 'SharedBoundAgent';
      }
      options() {
        return this.createSdkOptions();
      }
    }
    const presets = Config.getAgentPresets()!;
    // Claude gets the wire model plus the capability mapping.
    const claude = new BoundAgent({ ...presets.assistant, settings: presets.assistant }).options();
    expect(claude.model).toBe('group/hq-degrade');
    expect(claude.modelOverrides).toEqual({ 'claude-sonnet-4-5': 'group/hq-degrade' });
    // DSH gets the same wire model verbatim and no Claude-side mapping.
    const dsh = new BoundAgent({ ...presets.research, settings: presets.research }).options();
    expect(dsh.model).toBe('group/hq-degrade');
    expect(dsh.modelOverrides).toBeUndefined();
  });
});
