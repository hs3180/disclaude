import { describe, it, expect, vi } from 'vitest';

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: vi.fn(() => ({
    agent: {
      agentBackend: 'deepseek',
      provider: 'anthropic',
      model: 'deepseek-v4.1-flash-expires-on-0910',
    },
    anthropic: { apiKey: '' },
    workspace: { dir: '/test/workspace' },
  })),
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

import { Config } from './index.js';

describe('DeepSeek primary-node configuration', () => {
  it('boots without unrelated Anthropic credentials and preserves the selected model', () => {
    expect(Config.getAgentConfig()).toEqual({
      apiKey: '',
      model: 'deepseek-v4.1-flash-expires-on-0910',
      provider: 'anthropic',
    });
  });
});
