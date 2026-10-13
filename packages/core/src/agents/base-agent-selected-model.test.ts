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
    llms: { default: { model: 'gpt-6-luna' } },
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function selectedOptions(model: string, env?: Record<string, string>, settings?: AgentConfig) {
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
    agentBackend: 'claude',
  }).options();
}

describe('Claude native model aliases', () => {
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
    expect(options.autoCompactWindow).toBe('auto');
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
