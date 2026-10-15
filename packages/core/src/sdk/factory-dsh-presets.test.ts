import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentPreset } from '../config/types.js';
import type { DeepSeekHarnessProviderOptions } from './providers/deepseek/provider.js';

const state = vi.hoisted(() => ({
  defaults: {
    agentBackend: 'dsh',
    llm: 'default',
    model: 'default-model',
    apiProtocol: 'openai',
    apiBaseUrl: 'https://default.example/v1',
    apiKey: 'default-test-key',
    mode: 'standard',
    dshHome: '/default-dsh-home',
  },
}));
vi.mock('../config/index.js', () => ({ Config: { getAgentConfig: () => state.defaults } }));
vi.mock('./providers/index.js', () => {
  class DshProvider {
    name = 'dsh';
    constructor(readonly options: DeepSeekHarnessProviderOptions) {}
  }
  return {
    DeepSeekHarnessProvider: DshProvider,
    CodexAgentProvider: class {
      name = 'codex';
    },
    ClaudeSDKProvider: class {
      name = 'claude';
    },
    PiAgentProvider: class {
      name = 'pi';
    },
  };
});
import { clearProviderCache, getProvider, setDefaultProvider } from './factory.js';

const preset = (): AgentPreset => ({
  agentBackend: 'dsh',
  llm: 'glm-openai',
  model: 'glm-5.3',
  apiKey: 'named-test-key',
  apiProtocol: 'openai',
  apiBaseUrl: 'https://named.example/v1',
  mode: 'minimal',
  dshHome: '/named-dsh-home',
});
const optionsOf = (provider: ReturnType<typeof getProvider>) =>
  (provider as unknown as { options: DeepSeekHarnessProviderOptions }).options;

beforeEach(() => {
  clearProviderCache();
  setDefaultProvider('codex');
});
afterEach(() => vi.unstubAllEnvs());

describe('DSH connections resolved from named LLMs', () => {
  it('uses the selected LLM API when Codex is the default', () => {
    expect(getProvider().name).toBe('codex');
    expect(optionsOf(getProvider('dsh', preset()))).toEqual({
      mode: 'minimal',
      dshHome: '/named-dsh-home',
      apiKey: 'named-test-key',
      api: { protocol: 'openai', baseUrl: 'https://named.example/v1', model: 'glm-5.3' },
    });
  });

  it('keeps modes, homes, protocols, endpoints, models and credentials independent', () => {
    const selected = preset();
    const first = getProvider('dsh', selected);
    for (const change of [
      { mode: 'standard' as const },
      { dshHome: '/other-home' },
      { apiProtocol: 'anthropic' as const },
      { apiBaseUrl: 'https://other.example' },
      { model: 'other-model' },
      { apiKey: 'other-test-key' },
    ]) {
      expect(getProvider('dsh', { ...selected, ...change })).not.toBe(first);
    }
    expect(getProvider('dsh', { ...selected, llm: 'equivalent' })).toBe(first);
  });

  it('defaults composition to standard without a nested runtime block', () => {
    const selected = preset();
    delete selected.mode;
    expect(optionsOf(getProvider('dsh', selected)).mode).toBe('standard');
  });

  it('prefers the selected home and uses DSH_HOME only when omitted', () => {
    vi.stubEnv('DSH_HOME', '/environment-home');
    const selected = preset();
    expect(optionsOf(getProvider('dsh', selected)).dshHome).toBe('/named-dsh-home');
    delete selected.dshHome;
    const inherited = getProvider('dsh', selected);
    expect(optionsOf(inherited).dshHome).toBe('/environment-home');
    expect(getProvider('dsh', { ...selected, dshHome: '/environment-home' })).toBe(inherited);
  });

  it('uses the resolved credential instead of an unrelated native key', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'unrelated-test-key');
    expect(optionsOf(getProvider('dsh', preset())).apiKey).toBe('named-test-key');
  });

  it('shares equivalent default and named bindings for reset routing', () => {
    setDefaultProvider('dsh');
    expect(getProvider('dsh', state.defaults as AgentPreset)).toBe(getProvider());
  });

  it('clears every DSH connection without clearing another backend', () => {
    const selected = preset();
    const first = getProvider('dsh', selected);
    const second = getProvider('dsh', { ...selected, mode: 'standard' });
    const codex = getProvider('codex');
    clearProviderCache('dsh');
    expect(getProvider('dsh', selected)).not.toBe(first);
    expect(getProvider('dsh', { ...selected, mode: 'standard' })).not.toBe(second);
    expect(getProvider('codex')).toBe(codex);
  });
});
