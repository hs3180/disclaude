import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DisclaudeConfig } from './types.js';
import { validateRequiredConfig } from './loader.js';

const state = vi.hoisted(() => ({ config: {} as DisclaudeConfig }));
vi.mock('./loader.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./loader.js')>(),
  loadConfigFile: () => ({ ...state.config, _fromFile: true, _source: 'test.yaml' }),
  getPreloadedConfig: () => null,
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('ANTHROPIC_MODEL', '');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  state.config = {
    agent: { agentBackend: 'claude', provider: 'glm' },
    glm: { apiKey: 'test-key', apiBaseUrl: 'http://127.0.0.1:1' },
  };
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('API model environment fallback', () => {
  it('accepts a host environment model in runtime and early GLM paired validation', async () => {
    vi.stubEnv('ANTHROPIC_MODEL', '  host-model  ');
    const { Config } = await import('./index.js');
    expect(Config.getAgentConfig().model).toBe('host-model');
    expect(validateRequiredConfig(state.config)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['file-model', 'host-model', 'config-env-model', 'file-model'],
    [undefined, 'host-model', 'config-env-model', 'host-model'],
    [undefined, '', 'config-env-model', 'config-env-model'],
  ])('keeps explicit GLM model ahead of host/config env', async (file, host, configEnv, expected) => {
    state.config.glm!.model = file;
    state.config.env = { ANTHROPIC_MODEL: configEnv };
    vi.stubEnv('ANTHROPIC_MODEL', host);
    const { Config } = await import('./index.js');
    expect(Config.getAgentConfig().model).toBe(expected);
    expect(validateRequiredConfig(state.config).valid).toBe(true);
  });

  it.each(['', '   '])('still rejects an absent/blank model (%j)', async (model) => {
    vi.stubEnv('ANTHROPIC_MODEL', model);
    const { Config } = await import('./index.js');
    expect(() => Config.getAgentConfig()).toThrow('glm.model');
    expect(validateRequiredConfig(state.config).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'glm.model' }),
    ]));
  });

  it('requires a GLM key when only the model comes from the environment', async () => {
    delete state.config.glm!.apiKey;
    vi.stubEnv('ANTHROPIC_MODEL', 'host-model');
    const { Config } = await import('./index.js');
    expect(() => Config.getAgentConfig()).toThrow('glm.apiKey');
    expect(validateRequiredConfig(state.config).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'glm.apiKey' }),
    ]));
  });

  it.each([
    [undefined, undefined, undefined, 'host-model'],
    [undefined, undefined, 'anthropic-model', 'anthropic-model'],
    [undefined, 'agent-model', 'anthropic-model', 'agent-model'],
    ['preset-model', 'agent-model', 'anthropic-model', 'preset-model'],
  ])('resolves Anthropic preset/agent/service/env priority', async (preset, agent, service, expected) => {
    state.config = {
      agent: { agentBackend: 'claude', provider: 'anthropic', model: agent },
      anthropic: { apiKey: 'test-key', model: service },
      ...(preset ? { agents: { selected: { default: true, agentBackend: 'claude', provider: 'anthropic', model: preset } } } : {}),
    };
    vi.stubEnv('ANTHROPIC_MODEL', 'host-model');
    const { Config } = await import('./index.js');
    expect(Config.getAgentConfig().model).toBe(expected);
    expect(validateRequiredConfig(state.config).valid).toBe(true);
  });

  it('does not let ANTHROPIC_MODEL change the Codex model contract', async () => {
    state.config = { agent: { agentBackend: 'codex', codex: { model: 'gpt-6-luna' } } };
    vi.stubEnv('CODEX_MODEL', '');
    vi.stubEnv('ANTHROPIC_MODEL', 'unrelated-model');
    const { Config } = await import('./index.js');
    expect(Config.getAgentConfig().model).toBe('gpt-6-luna');
  });
});
