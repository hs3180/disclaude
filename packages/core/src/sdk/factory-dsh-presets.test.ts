import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPreset } from '../config/types.js';
import type { DeepSeekHarnessProviderOptions } from './providers/deepseek/provider.js';

const state = vi.hoisted(() => ({
  environment: {} as Record<string, string>,
  defaults: {
    DSH_MODE: 'standard' as 'standard' | 'minimal',
    DSH_PROVIDER: 'default-route',
    DSH_HOME: '/default-dsh-home',
    DSH_API_KEY: 'default-test-key',
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
    name = 'dsh';
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
  agentBackend: 'dsh',
  llm: 'glm-native',
  model: 'glm-5.3',
  apiKey: '',
  dsh: {
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
    const provider = getProvider('dsh', preset());
    expect(optionsOf(provider)).toEqual({
      mode: 'minimal',
      provider: 'glm-proxy',
      dshHome: '/named-dsh-home',
      apiKey: 'named-test-key',
    });
  });

  it('keeps distinct modes, routes, homes and credentials independent', () => {
    const selected = preset();
    const first = getProvider('dsh', selected);
    for (const change of [
      { mode: 'standard' as const },
      { provider: 'other-route' },
      { dshHome: '/other-home' },
      { apiKeyEnv: 'OTHER_DSH_TEST_KEY' },
    ]) {
      state.environment.OTHER_DSH_TEST_KEY = 'other-test-key';
      expect(getProvider('dsh', { ...selected, dsh: { ...selected.dsh, ...change } }))
        .not.toBe(first);
    }
    const otherModel: AgentPreset = { ...selected, llm: 'another-model', model: 'other-model' };
    expect(getProvider('dsh', otherModel)).toBe(first);
  });

  it('prefers the selected credential in the service environment', () => {
    vi.stubEnv('NAMED_DSH_TEST_KEY', 'host-test-key');
    expect(optionsOf(getProvider('dsh', preset())).apiKey).toBe('host-test-key');
  });

  it('shares equivalent default and named connections for reset routing', () => {
    const selected = preset();
    selected.dsh = {
      mode: state.defaults.DSH_MODE,
      provider: state.defaults.DSH_PROVIDER,
      dshHome: state.defaults.DSH_HOME,
      apiKeyEnv: 'DEFAULT_DSH_TEST_KEY',
    };
    state.environment.DEFAULT_DSH_TEST_KEY = state.defaults.DSH_API_KEY;
    setDefaultProvider('dsh');
    expect(getProvider('dsh', selected)).toBe(getProvider());
  });

  it('clears every DSH connection without clearing another backend', () => {
    const selected = preset();
    const first = getProvider('dsh', selected);
    const secondSettings = { ...selected, dsh: { ...selected.dsh, mode: 'standard' as const } };
    const second = getProvider('dsh', secondSettings);
    const codex = getProvider('codex');
    clearProviderCache('dsh');
    expect(getProvider('dsh', selected)).not.toBe(first);
    expect(getProvider('dsh', secondSettings)).not.toBe(second);
    expect(getProvider('codex')).toBe(codex);
  });
});
