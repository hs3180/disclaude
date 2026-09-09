import { describe, expect, it, vi } from 'vitest';

const { mockGetConfigFromFile } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    agent: { provider: 'glm' as const },
    glm: { apiKey: 'test-glm-key', model: 'glm-test' },
    feishu: {},
    workspace: { dir: '/test/workspace' },
  })),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

import { Config } from './index.js';

describe('explicit GLM endpoint migration (#4735)', () => {
  it('rejects GLM selection when the removed legacy endpoint was not replaced', () => {
    expect(() => Config.getAgentConfig()).toThrow(/glm\.apiBaseUrl is required/);
  });
});
