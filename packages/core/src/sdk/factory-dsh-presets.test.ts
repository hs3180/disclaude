import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPreset } from '../config/types.js';
import type { DeepSeekHarnessProviderOptions } from './providers/deepseek/provider.js';

const state = vi.hoisted(() => ({
  environment: {} as Record<string, string>,
  defaults: {
    DSH_MODE: 'standard' as 'standard' | 'minimal',
    DSH_PROVIDER: 'default-route',
    DSH_HOME: '/default-dsh-home',
    DEEPSEEK_API_KEY: 'default-test-key',
  },
}));
vi.mock('../config/index.js', () => ({
  Config: {
    ...state.defaults,
    getGlobalEnv: () => state.environment,
  },
}));
vi.mock('./providers/index.js', () => {
  class DshProvider {
    name = 'deepseek';
    constructor(readonly options: DeepSeekHarnessProviderOptions) {}
  }
  return {
    DeepSeekHarnessProvider: DshProvider,
    CodexAgentProvider: class { name = 'codex'; },
    ClaudeSDKProvider: class { name = 'claude'; },
    PiAgentProvider: class { name = 'pi'; },
  };
});

import { clearProviderCache, getProvider, setDefaultProvider } from './factory.js';

const preset = (): AgentPreset => ({
  agentBackend: 'deepseek',
  llm: 'glm-native',
  model: 'glm-5.3',
  apiKey: '',
  deepseek: {
    mode: 'minimal',
    provider: 'glm-proxy',
    dshHome: '/named-dsh-home',
    apiKeyEnv: 'NAMED_DSH_TEST_KEY',
  },
});
const optionsOf = (provider: ReturnType<typeof getProvider>) =>
  (provider as unknown as { options: DeepSeekHarnessProviderOptions }).options;

beforeEach(() => {
  clearProviderCache();
  setDefaultProvider('codex');
  state.environment = { NAMED_DSH_TEST_KEY: 'named-test-key' };
  vi.stubEnv('NAMED_DSH_TEST_KEY', undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe('named DSH connections', () => {
  it('uses the selected DSH settings when Codex is the default', () => {
    expect(getProvider().name).toBe('codex');
    const provider = getProvider('deepseek', preset());
    expect(optionsOf(provider)).toEqual({
      mode: 'minimal',
      provider: 'glm-proxy',
      dshHome: '/named-dsh-home',
      apiKey: 'named-test-key',
    });
  });

  it('keeps distinct modes, routes, homes and credentials independent', () => {
    const selected = preset();
    const first = getProvider('deepseek', selected);
    for (const change of [
      { mode: 'standard' as const },
      { provider: 'other-route' },
      { dshHome: '/other-home' },
      { apiKeyEnv: 'OTHER_DSH_TEST_KEY' },
    ]) {
      state.environment.OTHER_DSH_TEST_KEY = 'other-test-key';
      expect(getProvider('deepseek', { ...selected, deepseek: { ...selected.deepseek, ...change } }))
        .not.toBe(first);
    }
    const otherModel: AgentPreset = { ...selected, llm: 'another-model', model: 'other-model' };
    expect(getProvider('deepseek', otherModel)).toBe(first);
  });

  it('prefers the selected credential in the service environment', () => {
    vi.stubEnv('NAMED_DSH_TEST_KEY', 'host-test-key');
    expect(optionsOf(getProvider('deepseek', preset())).apiKey).toBe('host-test-key');
  });

  it('shares equivalent default and named connections for reset routing', () => {
    const selected = preset();
    selected.deepseek = {
      mode: state.defaults.DSH_MODE,
      provider: state.defaults.DSH_PROVIDER,
      dshHome: state.defaults.DSH_HOME,
      apiKeyEnv: 'DEFAULT_DSH_TEST_KEY',
    };
    state.environment.DEFAULT_DSH_TEST_KEY = state.defaults.DEEPSEEK_API_KEY;
    setDefaultProvider('deepseek');
    expect(getProvider('deepseek', selected)).toBe(getProvider());
  });

  it('clears every DSH connection without clearing another backend', () => {
    const selected = preset();
    const first = getProvider('deepseek', selected);
    const secondSettings = { ...selected, deepseek: { ...selected.deepseek, mode: 'standard' as const } };
    const second = getProvider('deepseek', secondSettings);
    const codex = getProvider('codex');
    clearProviderCache('deepseek');
    expect(getProvider('deepseek', selected)).not.toBe(first);
    expect(getProvider('deepseek', secondSettings)).not.toBe(second);
    expect(getProvider('codex')).toBe(codex);
  });
});
