import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisclaudeConfig } from '../config/types.js';

const fixture = vi.hoisted(() => ({ value: {} as DisclaudeConfig }));

// Exercise real Config and SDK environment resolution without developer files.
vi.mock('../config/loader.js', async importOriginal => ({
  ...await importOriginal<typeof import('../config/loader.js')>(),
  loadConfigFile: () => ({ _fromFile: false }),
  getPreloadedConfig: () => null,
  getConfigFromFile: () => fixture.value,
  validateConfig: () => true,
}));
vi.mock('../sdk/index.js', () => ({ getProvider: () => ({ name: 'claude' }) }));
vi.mock('../config/runtime-env.js', () => ({ loadRuntimeEnv: () => ({}) }));

beforeEach(() => {
  vi.resetModules();
  for (const key of ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL']) {
    vi.stubEnv(key, undefined);
  }
  fixture.value = {
    workspace: { dir: '/owned-selected-model-test' },
    agent: { agentBackend: 'codex', provider: 'anthropic', codex: { model: 'gpt-6-luna' } },
    anthropic: { apiKey: 'owned-anthropic-key', model: 'service-anthropic-model' },
    glm: { apiKey: 'owned-glm-key', model: 'service-glm-model' },
    logging: { sdkDebug: false },
  };
});
afterEach(() => { vi.unstubAllEnvs(); });

async function selectedOptions(provider: 'anthropic' | 'glm', model: string) {
  const { BaseAgent } = await import('./base-agent.js');
  class SelectedAgent extends BaseAgent {
    protected getAgentName() { return 'OwnedSelectedModel'; }
    options() { return this.createSdkOptions(); }
  }
  const agent = new SelectedAgent({ apiKey: `owned-${provider}-key`, provider, model, agentBackend: 'claude' });
  return agent.options();
}

describe('Claude model aliases after selecting an API preset from Codex', () => {
  it.each(['glm', 'anthropic'] as const)('keeps %s sub-agent aliases on the selected model', async provider => {
    const model = `${provider}/selected-preset-model`;
    const options = await selectedOptions(provider, model);
    expect(options.model).toBe(model);
    expect(options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(model);
    expect(options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe(model);
    expect(options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe(model);
  });

  it('keeps explicit GLM tiers and user alias overrides when the main preset differs', async () => {
    fixture.value.glm = { ...fixture.value.glm, highModel: 'glm/large', lowModel: 'glm/small' };
    fixture.value.env = { ANTHROPIC_DEFAULT_SONNET_MODEL: 'user/multimodal' };
    const options = await selectedOptions('glm', 'glm/selected-preset-model');
    expect(options.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm/large');
    expect(options.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm/small');
    expect(options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('user/multimodal');
  });
});
