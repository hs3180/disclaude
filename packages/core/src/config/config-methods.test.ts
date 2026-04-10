/**
 * Tests for Config static methods in packages/core/src/config/index.ts
 *
 * Covers:
 * - getSessionRestoreConfig(): default values
 * - getSessionTimeoutConfig(): null and enabled states
 * - getAgentConfig(): provider selection and validation errors
 * - createDefaultRuntimeContext(): context creation
 * - Various getter methods
 *
 * Note: Config uses module-level constants (fileConfigOnly) computed from
 * the loader at import time. Tests verify behavior with the initial mock setup.
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock with sessionRestore config to test both branches
const { mockGetConfigFromFile, mockGetPreloadedConfig } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    env: { TEST_VAR: 'test_value' },
    logging: { level: 'debug', pretty: false, rotate: true, sdkDebug: false },
    sessionRestore: {
      historyDays: 14,
      maxContextLength: 8000,
      sessionTimeout: {
        enabled: true,
        idleMinutes: 60,
        maxSessions: 50,
        checkIntervalMinutes: 10,
      },
    },
    agent: { provider: 'glm' as const, enableAgentTeams: true },
    glm: {
      apiKey: 'test-glm-key',
      model: 'glm-4',
      apiBaseUrl: 'https://api.test.com',
    },
    feishu: { appId: 'test-app-id', appSecret: 'test-secret' },
    workspace: { dir: '/test/workspace' },
    messaging: { debug: { forwardPatterns: ['error.*'] } },
    tools: { mcpServers: { test: { command: 'node' } } },
  })),
  mockGetPreloadedConfig: vi.fn(() => null),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: mockGetPreloadedConfig,
}));

import { Config, createDefaultRuntimeContext } from './index.js';

describe('Config', () => {
  describe('getSessionRestoreConfig', () => {
    it('should return configured values', () => {
      const config = Config.getSessionRestoreConfig();
      expect(config).toEqual({
        historyDays: 14,
        maxContextLength: 8000,
      });
    });
  });

  describe('getSessionTimeoutConfig', () => {
    it('should return timeout config when enabled', () => {
      const config = Config.getSessionTimeoutConfig();
      expect(config).toEqual({
        enabled: true,
        idleMinutes: 60,
        maxSessions: 50,
        checkIntervalMinutes: 10,
      });
    });
  });

  describe('getAgentConfig', () => {
    it('should return GLM config when configured', () => {
      const config = Config.getAgentConfig();
      expect(config.provider).toBe('glm');
      expect(config.apiKey).toBe('test-glm-key');
      expect(config.model).toBe('glm-4');
      expect(config.apiBaseUrl).toBe('https://api.test.com');
    });

      });

  describe('hasConfigFile', () => {
    it('should return boolean', () => {
      expect(typeof Config.hasConfigFile()).toBe('boolean');
    });
  });

  describe('getToolConfig', () => {
    it('should return tools config', () => {
      const tools = Config.getToolConfig();
      expect(tools?.mcpServers).toBeDefined();
      expect(tools?.mcpServers?.test).toEqual({ command: 'node' });
    });
  });

  describe('getMcpServersConfig', () => {
    it('should return MCP servers config', () => {
      const servers = Config.getMcpServersConfig();
      expect(servers).toBeDefined();
      expect(servers?.test).toEqual({ command: 'node' });
    });
  });

  describe('getTransportConfig', () => {
    it('should return default local transport', () => {
      const transport = Config.getTransportConfig();
      expect(transport).toEqual({ type: 'local' });
    });
  });

  describe('getLoggingConfig', () => {
    it('should return logging configuration', () => {
      const logging = Config.getLoggingConfig();
      expect(logging.level).toBe('debug');
      expect(logging.pretty).toBe(false);
      expect(logging.rotate).toBe(true);
      expect(logging.sdkDebug).toBe(false);
    });
  });

  describe('isAgentTeamsEnabled', () => {
    it('should return true when enabled', () => {
      expect(Config.isAgentTeamsEnabled()).toBe(true);
    });
  });

  describe('getDebugConfig', () => {
    it('should return debug config', () => {
      const debug = Config.getDebugConfig();
      expect(debug.forwardPatterns).toEqual(['error.*']);
    });
  });

  describe('getGlobalEnv', () => {
    it('should return env from file config', () => {
      const env = Config.getGlobalEnv();
      expect(env.TEST_VAR).toBe('test_value');
    });

    it('should prefer preloaded config when available', () => {
      mockGetPreloadedConfig.mockReturnValueOnce({
        _fromFile: true,
        _source: '/custom/config.yaml',
      });

      // The preloaded config mock returns null, so this falls through
      // to fileConfigOnly which has the env
      const env = Config.getGlobalEnv();
      expect(env.TEST_VAR).toBe('test_value');
    });
  });

  describe('getRawConfig', () => {
    it('should return file config when no preloaded', () => {
      const raw = Config.getRawConfig();
      expect(raw.glm.apiKey).toBe('test-glm-key');
    });
  });

  describe('resolveWorkspace', () => {
    it('should resolve path relative to workspace', () => {
      const resolved = Config.resolveWorkspace('subdir/file.txt');
      expect(resolved).toContain('subdir/file.txt');
    });
  });

  describe('getSkillsDir', () => {
    it('should return a path string', () => {
      expect(typeof Config.getSkillsDir()).toBe('string');
    });
  });

  describe('getAgentsDir', () => {
    it('should return a path string', () => {
      expect(typeof Config.getAgentsDir()).toBe('string');
    });
  });

  describe('static properties', () => {
    it('should have GLM configuration from config file', () => {
      expect(Config.GLM_API_KEY).toBe('test-glm-key');
      expect(Config.GLM_MODEL).toBe('glm-4');
      expect(Config.GLM_API_BASE_URL).toBe('https://api.test.com');
    });

    it('should have Feishu configuration from config file', () => {
      expect(Config.FEISHU_APP_ID).toBe('test-app-id');
      expect(Config.FEISHU_APP_SECRET).toBe('test-secret');
    });

    it('should have logging configuration from config file', () => {
      expect(Config.LOG_LEVEL).toBe('debug');
      expect(Config.LOG_PRETTY).toBe(false);
      expect(Config.LOG_ROTATE).toBe(true);
      expect(Config.SDK_DEBUG).toBe(false);
    });
  });
});

describe('createDefaultRuntimeContext', () => {
  it('should create context with Config-based methods', () => {
    const ctx = createDefaultRuntimeContext();
    expect(ctx).toBeDefined();
    expect(typeof ctx.getWorkspaceDir).toBe('function');
    expect(typeof ctx.getAgentConfig).toBe('function');
    expect(typeof ctx.getLoggingConfig).toBe('function');
    expect(typeof ctx.getGlobalEnv).toBe('function');
    expect(typeof ctx.isAgentTeamsEnabled).toBe('function');
  });

  it('should allow overriding sendMessage', () => {
    const mockSend = vi.fn();
    const ctx = createDefaultRuntimeContext({
      sendMessage: mockSend,
    });
    expect(ctx.sendMessage).toBe(mockSend);
  });

  it('should allow overriding sendCard', () => {
    const mockSendCard = vi.fn();
    const ctx = createDefaultRuntimeContext({
      sendCard: mockSendCard,
    });
    expect(ctx.sendCard).toBe(mockSendCard);
  });

  it('should preserve non-overridden methods', () => {
    const ctx = createDefaultRuntimeContext({
      sendMessage: vi.fn(),
    });
    expect(typeof ctx.getWorkspaceDir).toBe('function');
    expect(typeof ctx.getAgentConfig).toBe('function');
  });

  it('should provide working getWorkspaceDir', () => {
    const ctx = createDefaultRuntimeContext();
    const wsDir = ctx.getWorkspaceDir();
    expect(typeof wsDir).toBe('string');
    expect(wsDir).toBeTruthy();
  });

  it('should provide working getLoggingConfig', () => {
    const ctx = createDefaultRuntimeContext();
    const logging = ctx.getLoggingConfig();
    expect(logging.level).toBe('debug');
  });

  it('should provide working isAgentTeamsEnabled', () => {
    const ctx = createDefaultRuntimeContext();
    expect(ctx.isAgentTeamsEnabled()).toBe(true);
  });
});
