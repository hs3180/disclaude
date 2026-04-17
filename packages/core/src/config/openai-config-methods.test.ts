/**
 * Tests for OpenAI provider configuration in Config static methods.
 *
 * Covers:
 * - getAgentConfig(): OpenAI provider selection and API key resolution
 * - Config.OPENAI_API_KEY, Config.OPENAI_MODEL statics
 *
 * Note: Config uses module-level constants computed from the loader at import time.
 * This test file mocks the loader with OpenAI-specific config.
 *
 * @see Issue #1333
 */

import { describe, it, expect, vi } from 'vitest';

// Mock with OpenAI config to test OpenAI-specific behavior
const { mockGetConfigFromFile, mockGetPreloadedConfig } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: false, rotate: false, sdkDebug: false },
    agent: { provider: 'openai' as const },
    openai: {
      apiKey: 'test-openai-key',
      model: 'gpt-4o',
    },
    feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
    workspace: { dir: '/test/workspace' },
  })),
  mockGetPreloadedConfig: vi.fn(() => null),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: mockGetPreloadedConfig,
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => {
    throw new Error('not found');
  }),
}));

import { Config } from './index.js';

describe('OpenAI Config', () => {
  describe('static fields', () => {
    it('should have OPENAI_API_KEY from config', () => {
      expect(Config.OPENAI_API_KEY).toBe('test-openai-key');
    });

    it('should have OPENAI_MODEL from config', () => {
      expect(Config.OPENAI_MODEL).toBe('gpt-4o');
    });
  });

  describe('getAgentConfig', () => {
    it('should return OpenAI config when provider is openai', () => {
      const config = Config.getAgentConfig();
      expect(config.provider).toBe('openai');
      expect(config.apiKey).toBe('test-openai-key');
      expect(config.model).toBe('gpt-4o');
    });

    it('should return undefined apiBaseUrl when not configured', () => {
      const config = Config.getAgentConfig();
      expect(config.apiBaseUrl).toBeUndefined();
    });
  });
});
