/**
 * Tests for OpenAI provider configuration (Issue #1333).
 *
 * Covers:
 * - OpenAI config section parsing (apiKey, model, apiBaseUrl, acpCommand)
 * - Config.getAgentConfig() with explicit openai provider
 * - createDefaultRuntimeContext() with OpenAI provider env vars
 *
 * Uses a single mock setup with openai provider explicitly configured.
 *
 * @see Issue #1333
 */

import { describe, it, expect, vi } from 'vitest';

// vi.hoisted ensures mock references are available before vi.mock hoisting
const { mockGetConfigFromFile } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    env: { TEST_VAR: 'test_value' },
    logging: { level: 'info', pretty: false, rotate: false, sdkDebug: false },
    agent: {
      provider: 'openai' as const,
      acpCommand: 'generic-acp-server', // agent-level fallback
    },
    openai: {
      apiKey: 'sk-test-openai-key',
      model: 'gpt-4o',
      apiBaseUrl: 'https://api.openai.com/v1',
      acpCommand: 'openai-acp-server', // provider-specific override
    },
    // GLM is also configured but should be ignored since provider=openai
    glm: {
      apiKey: 'test-glm-key',
      model: 'glm-4',
      apiBaseUrl: 'https://api.test.com',
    },
    feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
    workspace: { dir: '/test/workspace' },
  })),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: vi.fn(() => null),
}));

// Mock child_process for resolveAcpCommand()
vi.mock('child_process', () => ({
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === 'which' && args[0] === 'claude-agent-acp') {
      return '/usr/local/bin/claude-agent-acp';
    }
    return '';
  }),
}));

import { Config, createDefaultRuntimeContext } from './index.js';

describe('OpenAI provider configuration (Issue #1333)', () => {
  // --------------------------------------------------------------------------
  // Static properties
  // --------------------------------------------------------------------------
  describe('static properties', () => {
    it('should have OpenAI API key from config file', () => {
      expect(Config.OPENAI_API_KEY).toBe('sk-test-openai-key');
    });

    it('should have OpenAI model from config file', () => {
      expect(Config.OPENAI_MODEL).toBe('gpt-4o');
    });

    it('should have OpenAI API base URL from config file', () => {
      expect(Config.OPENAI_API_BASE_URL).toBe('https://api.openai.com/v1');
    });

    it('should have OpenAI ACP command from config file', () => {
      expect(Config.OPENAI_ACP_COMMAND).toBe('openai-acp-server');
    });

    it('should still have GLM config available (for mixed setups)', () => {
      expect(Config.GLM_API_KEY).toBe('test-glm-key');
      expect(Config.GLM_MODEL).toBe('glm-4');
    });
  });

  // --------------------------------------------------------------------------
  // getAgentConfig()
  // --------------------------------------------------------------------------
  describe('getAgentConfig', () => {
    it('should return OpenAI provider when explicitly configured', () => {
      const config = Config.getAgentConfig();
      expect(config.provider).toBe('openai');
    });

    it('should return OpenAI API key', () => {
      const config = Config.getAgentConfig();
      expect(config.apiKey).toBe('sk-test-openai-key');
    });

    it('should return OpenAI model', () => {
      const config = Config.getAgentConfig();
      expect(config.model).toBe('gpt-4o');
    });

    it('should return OpenAI API base URL', () => {
      const config = Config.getAgentConfig();
      expect(config.apiBaseUrl).toBe('https://api.openai.com/v1');
    });

    it('should prefer OpenAI over GLM when provider is explicitly openai', () => {
      const config = Config.getAgentConfig();
      // Even though GLM is configured, explicit provider=openai wins
      expect(config.provider).toBe('openai');
      expect(config.apiKey).toContain('sk-');
    });
  });

  // --------------------------------------------------------------------------
  // createDefaultRuntimeContext()
  // --------------------------------------------------------------------------
  describe('createDefaultRuntimeContext', () => {
    it('should create context with OpenAI provider', () => {
      const ctx = createDefaultRuntimeContext();
      expect(ctx).toBeDefined();
      expect(ctx.getAgentConfig().provider).toBe('openai');
    });

    it('should provide getAcpClient function', () => {
      const ctx = createDefaultRuntimeContext();
      expect(typeof ctx.getAcpClient).toBe('function');
    });

    it('should provide working getAgentConfig', () => {
      const ctx = createDefaultRuntimeContext();
      const agentConfig = ctx.getAgentConfig();
      expect(agentConfig.provider).toBe('openai');
      expect(agentConfig.model).toBe('gpt-4o');
    });

    it('should provide working getWorkspaceDir', () => {
      const ctx = createDefaultRuntimeContext();
      const wsDir = ctx.getWorkspaceDir();
      expect(typeof wsDir).toBe('string');
      expect(wsDir).toBeTruthy();
    });
  });
});
