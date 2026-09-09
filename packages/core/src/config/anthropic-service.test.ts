import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisclaudeConfig } from './types.js';
import { validateRequiredConfig } from './loader.js';

async function loadService(config: DisclaudeConfig) {
  vi.resetModules();
  const loader = await import('./loader.js');
  loader.setLoadedConfig({ ...config, _fromFile: true });
  return (await import('./index.js')).Config;
}

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('Anthropic API service configuration', () => {
  it('carries a compatible service key, arbitrary model and endpoint into Agent configuration', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-test-key');
    const service = { apiKey: 'file-test-key', model: 'vendor-model', apiBaseUrl: 'https://compatible.example' };
    expect(validateRequiredConfig({ anthropic: service }).valid).toBe(true);
    const Config = await loadService({ anthropic: service });
    expect(Config.getAgentConfig()).toEqual({ ...service, provider: 'anthropic' });
  });

  it('does not mix the canonical service with legacy GLM credentials or tiers', async () => {
    const Config = await loadService({
      anthropic: { apiKey: 'canonical-test-key', model: 'canonical-model', apiBaseUrl: 'https://canonical.example', lowModel: 'canonical-small' },
      glm: { apiKey: 'legacy-test-key', model: 'legacy-model', apiBaseUrl: 'https://legacy.example', lowModel: 'legacy-small' },
    });
    expect(Config.getAgentConfig()).toMatchObject({ apiKey: 'canonical-test-key', model: 'canonical-model', apiBaseUrl: 'https://canonical.example', provider: 'anthropic' });
    expect(Config.getModelForTier('low')).toBe('canonical-small');
  });

  it('supports Anthropic defaults and environment credentials with an explicit agent model override', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'env-test-key');
    const Config = await loadService({ anthropic: { model: 'service-default' }, agent: { provider: 'anthropic', model: 'agent-override' } });
    expect(Config.getAgentConfig()).toMatchObject({ apiKey: 'env-test-key', model: 'agent-override', provider: 'anthropic' });
    expect(Config.getAgentConfig().apiBaseUrl).toBeUndefined();
  });

  it('reports missing canonical credentials and model without silently using GLM', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const config = { anthropic: {}, glm: { apiKey: 'legacy-key', model: 'legacy', apiBaseUrl: 'https://legacy.example' } };
    expect(validateRequiredConfig(config).errors.map(error => error.field)).toEqual(['anthropic.apiKey', 'anthropic.model']);
    const Config = await loadService(config);
    expect(() => Config.getAgentConfig()).toThrow(/anthropic.apiKey/);
  });

  it('keeps a named preset provider consistent across validation, credentials and tiers', async () => {
    const config: DisclaudeConfig = {
      agent: { provider: 'glm' },
      agents: { default: { agentBackend: 'claude', model: 'preset-model', provider: 'anthropic' } },
      anthropic: { apiKey: 'canonical-key', apiBaseUrl: 'https://canonical.example', lowModel: 'canonical-small' },
    };
    expect(validateRequiredConfig(config)).toEqual({ valid: true, errors: [] });
    const Config = await loadService(config);
    expect(Config.getAgentConfig()).toMatchObject({ apiKey: 'canonical-key', model: 'preset-model', apiBaseUrl: 'https://canonical.example', provider: 'anthropic' });
    expect(Config.getModelForTier('low')).toBe('canonical-small');
  });

  it('keeps legacy glm configurations readable during migration', async () => {
    const service = { apiKey: 'legacy-key', model: 'legacy-model', apiBaseUrl: 'https://legacy.example' };
    const Config = await loadService({ glm: service });
    expect(Config.getAgentConfig()).toEqual({ ...service, provider: 'glm' });
  });

  it('keeps Codex authentication independent of API service credentials', async () => {
    const Config = await loadService({ anthropic: {}, agent: { agentBackend: 'codex', model: 'gpt-5.6' } });
    expect(Config.getAgentConfig()).toMatchObject({ apiKey: '', model: 'gpt-5.6' });
  });

  it('allows a default Codex preset without credentials for an unused API service', async () => {
    const config: DisclaudeConfig = {
      anthropic: {},
      agents: { default: { agentBackend: 'codex', model: 'gpt-5.6' } },
    };
    expect(validateRequiredConfig(config)).toEqual({ valid: true, errors: [] });
    const Config = await loadService(config);
    expect(Config.getAgentConfig()).toMatchObject({ apiKey: '', model: 'gpt-5.6' });
  });
});
