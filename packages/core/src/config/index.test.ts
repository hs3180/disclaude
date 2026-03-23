/**
 * Tests for Config class (packages/core/src/config/index.ts)
 *
 * Tests the following functionality:
 * - Static configuration properties
 * - getRawConfig() method
 * - getWorkspaceDir() method
 * - resolveWorkspace() method
 * - getSkillsDir() method
 * - getAgentConfig() with all validation branches
 * - hasConfigFile() method
 * - getToolConfig() method
 * - getMcpServersConfig() method
 * - getTransportConfig() method
 * - getLoggingConfig() method
 * - getGlobalEnv() method
 * - getDebugConfig() method
 * - isAgentTeamsEnabled() method
 * - getSessionRestoreConfig() method
 * - validateRequiredConfig() private method branches
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';

// Mock the logger before importing Config
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

// Mock the config loader to control what Config sees
const mockValidateConfig = vi.fn().mockReturnValue(true);
const mockGetConfigFromFile = vi.fn().mockReturnValue({});
const mockLoadConfigFile = vi.fn().mockReturnValue({ _fromFile: false });
const mockGetPreloadedConfig = vi.fn().mockReturnValue(null);

vi.mock('./loader.js', () => ({
  loadConfigFile: mockLoadConfigFile,
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: mockValidateConfig,
  getPreloadedConfig: mockGetPreloadedConfig,
}));

// Mock fs for getBuiltinSkillsDir
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
}));

// We need to import Config dynamically so mocks are applied first
let Config: typeof import('./index.js').Config;

/**
 * Helper to reload the Config module with fresh mocks.
 * This resets module cache and re-imports Config so that static
 * properties are re-initialized with the current mock values.
 */
async function reloadConfig() {
  vi.resetModules();
  const mod = await import('./index.js');
  Config = mod.Config;
}

describe('Config', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    // Default: no config file loaded, empty config
    mockLoadConfigFile.mockReturnValue({ _fromFile: false, _source: undefined });
    mockGetConfigFromFile.mockReturnValue({});
    mockValidateConfig.mockReturnValue(true);
    mockGetPreloadedConfig.mockReturnValue(null);

    await reloadConfig();
  });

  describe('static properties - defaults', () => {
    it('should have CONFIG_LOADED as false when no config file found', () => {
      expect(Config.CONFIG_LOADED).toBe(false);
    });

    it('should have FEISHU_APP_ID as empty string by default', () => {
      expect(Config.FEISHU_APP_ID).toBe('');
    });

    it('should have FEISHU_APP_SECRET as empty string by default', () => {
      expect(Config.FEISHU_APP_SECRET).toBe('');
    });

    it('should have FEISHU_CLI_CHAT_ID as empty string by default', () => {
      expect(Config.FEISHU_CLI_CHAT_ID).toBe('');
    });

    it('should have GLM_API_KEY as empty string by default', () => {
      expect(Config.GLM_API_KEY).toBe('');
    });

    it('should have GLM_MODEL as empty string by default', () => {
      expect(Config.GLM_MODEL).toBe('');
    });

    it('should have GLM_API_BASE_URL with default value', () => {
      expect(Config.GLM_API_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
    });

    it('should have ANTHROPIC_API_KEY from environment or empty', () => {
      // Value comes from process.env.ANTHROPIC_API_KEY
      expect(Config.ANTHROPIC_API_KEY).toBe(process.env.ANTHROPIC_API_KEY || '');
    });

    it('should have CLAUDE_MODEL as empty string by default', () => {
      expect(Config.CLAUDE_MODEL).toBe('');
    });

    it('should have LOG_LEVEL as "info" by default', () => {
      expect(Config.LOG_LEVEL).toBe('info');
    });

    it('should have LOG_PRETTY as true by default', () => {
      expect(Config.LOG_PRETTY).toBe(true);
    });

    it('should have LOG_ROTATE as false by default', () => {
      expect(Config.LOG_ROTATE).toBe(false);
    });

    it('should have SDK_DEBUG as true by default', () => {
      expect(Config.SDK_DEBUG).toBe(true);
    });

    it('should have LOG_FILE as undefined by default', () => {
      expect(Config.LOG_FILE).toBeUndefined();
    });
  });

  describe('static properties - from config file', () => {
    it('should read feishu config from file', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });
      mockGetConfigFromFile.mockReturnValue({
        feishu: { appId: 'test-app-id', appSecret: 'test-secret', cliChatId: 'chat-123' },
      });

      await reloadConfig();

      expect(Config.FEISHU_APP_ID).toBe('test-app-id');
      expect(Config.FEISHU_APP_SECRET).toBe('test-secret');
      expect(Config.FEISHU_CLI_CHAT_ID).toBe('chat-123');
    });

    it('should read GLM config from file', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });
      mockGetConfigFromFile.mockReturnValue({
        glm: { apiKey: 'glm-key-123', model: 'glm-5', apiBaseUrl: 'https://custom.api.com' },
      });

      await reloadConfig();

      expect(Config.GLM_API_KEY).toBe('glm-key-123');
      expect(Config.GLM_MODEL).toBe('glm-5');
      expect(Config.GLM_API_BASE_URL).toBe('https://custom.api.com');
    });

    it('should read agent model from file', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });
      mockGetConfigFromFile.mockReturnValue({
        agent: { model: 'claude-3-5-sonnet-20241022' },
      });

      await reloadConfig();

      expect(Config.CLAUDE_MODEL).toBe('claude-3-5-sonnet-20241022');
    });

    it('should read logging config from file', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });
      mockGetConfigFromFile.mockReturnValue({
        logging: { level: 'debug', file: '/var/log/app.log', pretty: false, rotate: true, sdkDebug: false },
      });

      await reloadConfig();

      expect(Config.LOG_LEVEL).toBe('debug');
      expect(Config.LOG_FILE).toBe('/var/log/app.log');
      expect(Config.LOG_PRETTY).toBe(false);
      expect(Config.LOG_ROTATE).toBe(true);
      expect(Config.SDK_DEBUG).toBe(false);
    });

    it('should set CONFIG_LOADED to true when config file is found', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });

      await reloadConfig();

      expect(Config.CONFIG_LOADED).toBe(true);
    });

    it('should use workspace.dir from config file', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });
      mockGetConfigFromFile.mockReturnValue({
        workspace: { dir: '/custom/workspace' },
      });

      await reloadConfig();

      expect(Config.WORKSPACE_DIR).toBe('/custom/workspace');
    });

    it('should resolve relative workspace.dir against config file directory', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/project/config.yaml' });
      mockGetConfigFromFile.mockReturnValue({
        workspace: { dir: './workspace' },
      });

      await reloadConfig();

      // Relative path should be resolved against config file directory
      expect(Config.WORKSPACE_DIR).toBe('/test/project/workspace');
    });

    it('should handle absolute workspace.dir from config file', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });
      mockGetConfigFromFile.mockReturnValue({
        workspace: { dir: '/absolute/workspace' },
      });

      await reloadConfig();

      expect(Config.WORKSPACE_DIR).toBe('/absolute/workspace');
    });
  });

  describe('getRawConfig()', () => {
    it('should return fileConfigOnly when no preloaded config is available', async () => {
      const fileOnlyConfig = { agent: { model: 'test' } };
      mockGetConfigFromFile.mockReturnValue(fileOnlyConfig);
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });

      await reloadConfig();

      const raw = Config.getRawConfig();
      expect(raw).toEqual(fileOnlyConfig);
    });

    it('should return preloaded config when available and valid', async () => {
      const preloadedConfig = { _fromFile: true, _source: '/cli/config.yaml' };
      mockGetPreloadedConfig.mockReturnValue(preloadedConfig);
      mockValidateConfig.mockImplementation((c) => c === preloadedConfig);
      mockGetConfigFromFile.mockImplementation((c) => {
        if (c === preloadedConfig) return { agent: { model: 'preloaded' } };
        return { agent: { model: 'from-file' } };
      });
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });

      await reloadConfig();

      const raw = Config.getRawConfig();
      expect(raw).toEqual({ agent: { model: 'preloaded' } });
    });

    it('should fall back to fileConfigOnly when preloaded config is invalid', async () => {
      const preloadedConfig = { _fromFile: true, _source: '/cli/config.yaml' };
      mockGetPreloadedConfig.mockReturnValue(preloadedConfig);
      // validateConfig returns false for preloaded, true for fileConfig
      mockValidateConfig.mockImplementation((c) => c !== preloadedConfig);
      // When validateConfig returns false at module init, fileConfigOnly becomes {}
      // because getConfigFromFile is never called for the preloaded config
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });
      mockGetConfigFromFile.mockReturnValue({ agent: { model: 'from-file' } });

      await reloadConfig();

      // At module init: fileConfig = preloadedConfig (since getPreloadedConfig returns it)
      // validateConfig(preloadedConfig) returns false => fileConfigOnly = {}
      // getRawConfig(): getPreloadedConfig() returns preloadedConfig,
      //   validateConfig(preloadedConfig) returns false => returns fileConfigOnly which is {}
      const raw = Config.getRawConfig();
      expect(raw).toEqual({});
    });

    it('should return fileConfigOnly when preloaded config is null', async () => {
      mockGetPreloadedConfig.mockReturnValue(null);
      mockGetConfigFromFile.mockReturnValue({ logging: { level: 'debug' } });
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });

      await reloadConfig();

      const raw = Config.getRawConfig();
      expect(raw).toEqual({ logging: { level: 'debug' } });
    });
  });

  describe('getWorkspaceDir()', () => {
    it('should return the workspace directory', () => {
      const dir = Config.getWorkspaceDir();
      expect(typeof dir).toBe('string');
      expect(dir.length).toBeGreaterThan(0);
    });

    it('should return absolute path', () => {
      const dir = Config.getWorkspaceDir();
      expect(path.isAbsolute(dir)).toBe(true);
    });
  });

  describe('resolveWorkspace()', () => {
    it('should resolve a relative path against workspace directory', () => {
      const resolved = Config.resolveWorkspace('subdir/file.txt');
      expect(resolved).toContain('subdir');
      expect(resolved).toContain('file.txt');
      expect(resolved).not.toContain('..');
    });

    it('should return absolute path', () => {
      const resolved = Config.resolveWorkspace('test.txt');
      expect(path.isAbsolute(resolved)).toBe(true);
    });

    it('should resolve nested relative paths', () => {
      const resolved = Config.resolveWorkspace('a/b/c/d.txt');
      expect(resolved).toContain('a');
      expect(resolved).toContain('b');
      expect(resolved).toContain('c');
      expect(resolved).toContain('d.txt');
    });
  });

  describe('getSkillsDir()', () => {
    it('should return skills directory path', () => {
      const dir = Config.getSkillsDir();
      expect(typeof dir).toBe('string');
    });
  });

  describe('hasConfigFile()', () => {
    it('should return false when no config file was loaded', () => {
      expect(Config.hasConfigFile()).toBe(false);
    });

    it('should return true when config file was loaded', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });

      await reloadConfig();

      expect(Config.hasConfigFile()).toBe(true);
    });
  });

  describe('getToolConfig()', () => {
    it('should return undefined when no tools configured', () => {
      mockGetConfigFromFile.mockReturnValue({});
      const tools = Config.getToolConfig();
      expect(tools).toBeUndefined();
    });

    it('should return tools config when configured', async () => {
      const toolsConfig = { enabled: ['Read', 'Write'], disabled: ['Bash'] };
      mockGetConfigFromFile.mockReturnValue({ tools: toolsConfig });

      await reloadConfig();

      const tools = Config.getToolConfig();
      expect(tools).toEqual(toolsConfig);
    });
  });

  describe('getMcpServersConfig()', () => {
    it('should return undefined when no mcpServers configured', () => {
      mockGetConfigFromFile.mockReturnValue({});
      const mcp = Config.getMcpServersConfig();
      expect(mcp).toBeUndefined();
    });

    it('should return mcpServers config when configured', async () => {
      const mcpConfig = {
        playwright: {
          command: 'npx',
          args: ['playwright-mcp-server'],
        },
      };
      mockGetConfigFromFile.mockReturnValue({ tools: { mcpServers: mcpConfig } });

      await reloadConfig();

      const mcp = Config.getMcpServersConfig();
      expect(mcp).toEqual(mcpConfig);
    });
  });

  describe('getTransportConfig()', () => {
    it('should return default local transport when not configured', () => {
      mockGetConfigFromFile.mockReturnValue({});
      const transport = Config.getTransportConfig();
      expect(transport).toEqual({ type: 'local' });
    });

    it('should return configured transport', async () => {
      const transportConfig = {
        type: 'http' as const,
        http: {
          execution: { host: '0.0.0.0', port: 3000 },
          communication: { callbackHost: '0.0.0.0', callbackPort: 3001 },
        },
      };
      mockGetConfigFromFile.mockReturnValue({ transport: transportConfig });

      await reloadConfig();

      const transport = Config.getTransportConfig();
      expect(transport).toEqual(transportConfig);
    });
  });

  describe('getLoggingConfig()', () => {
    it('should return default logging config', () => {
      const config = Config.getLoggingConfig();
      expect(config).toEqual({
        level: 'info',
        file: undefined,
        pretty: true,
        rotate: false,
        sdkDebug: true,
      });
    });

    it('should return configured logging values', async () => {
      mockGetConfigFromFile.mockReturnValue({
        logging: { level: 'trace', file: 'app.log', pretty: false, rotate: true, sdkDebug: false },
      });

      await reloadConfig();

      const config = Config.getLoggingConfig();
      expect(config).toEqual({
        level: 'trace',
        file: 'app.log',
        pretty: false,
        rotate: true,
        sdkDebug: false,
      });
    });
  });

  describe('getGlobalEnv()', () => {
    it('should return empty object when no env configured', () => {
      mockGetConfigFromFile.mockReturnValue({});
      const env = Config.getGlobalEnv();
      expect(env).toEqual({});
    });

    it('should return global env when configured', async () => {
      const envConfig = { NODE_ENV: 'production', FEATURE_FLAG: 'enabled' };
      mockGetConfigFromFile.mockReturnValue({ env: envConfig });

      await reloadConfig();

      const env = Config.getGlobalEnv();
      expect(env).toEqual(envConfig);
    });
  });

  describe('getDebugConfig()', () => {
    it('should return empty object when no debug config', () => {
      mockGetConfigFromFile.mockReturnValue({});
      const debug = Config.getDebugConfig();
      expect(debug).toEqual({});
    });

    it('should return debug config when configured', async () => {
      const debugConfig = {
        enabled: true,
        filterForwardChatId: 'chat-123',
        includeReasons: ['duplicate', 'bot'] as const,
      };
      mockGetConfigFromFile.mockReturnValue({
        messaging: { debug: debugConfig },
      });

      await reloadConfig();

      const debug = Config.getDebugConfig();
      expect(debug).toEqual(debugConfig);
    });
  });

  describe('isAgentTeamsEnabled()', () => {
    it('should return false by default', () => {
      mockGetConfigFromFile.mockReturnValue({});
      expect(Config.isAgentTeamsEnabled()).toBe(false);
    });

    it('should return true when explicitly enabled', async () => {
      mockGetConfigFromFile.mockReturnValue({
        agent: { enableAgentTeams: true },
      });

      await reloadConfig();

      expect(Config.isAgentTeamsEnabled()).toBe(true);
    });

    it('should return false when explicitly disabled', async () => {
      mockGetConfigFromFile.mockReturnValue({
        agent: { enableAgentTeams: false },
      });

      await reloadConfig();

      expect(Config.isAgentTeamsEnabled()).toBe(false);
    });
  });

  describe('getSessionRestoreConfig()', () => {
    it('should return default values when not configured', () => {
      mockGetConfigFromFile.mockReturnValue({});
      const config = Config.getSessionRestoreConfig();
      expect(config).toEqual({
        historyDays: 7,
        maxContextLength: 4000,
      });
    });

    it('should return configured values', async () => {
      mockGetConfigFromFile.mockReturnValue({
        sessionRestore: { historyDays: 30, maxContextLength: 8000 },
      });

      await reloadConfig();

      const config = Config.getSessionRestoreConfig();
      expect(config).toEqual({
        historyDays: 30,
        maxContextLength: 8000,
      });
    });

    it('should handle partial sessionRestore config with only historyDays', async () => {
      mockGetConfigFromFile.mockReturnValue({
        sessionRestore: { historyDays: 14 },
      });

      await reloadConfig();

      const config = Config.getSessionRestoreConfig();
      expect(config.historyDays).toBe(14);
      expect(config.maxContextLength).toBe(4000); // default
    });

    it('should handle partial sessionRestore config with only maxContextLength', async () => {
      mockGetConfigFromFile.mockReturnValue({
        sessionRestore: { maxContextLength: 2000 },
      });

      await reloadConfig();

      const config = Config.getSessionRestoreConfig();
      expect(config.historyDays).toBe(7); // default
      expect(config.maxContextLength).toBe(2000);
    });

    it('should handle empty sessionRestore object', async () => {
      mockGetConfigFromFile.mockReturnValue({
        sessionRestore: {},
      });

      await reloadConfig();

      const config = Config.getSessionRestoreConfig();
      expect(config).toEqual({
        historyDays: 7,
        maxContextLength: 4000,
      });
    });
  });

  describe('getAgentConfig()', () => {
    it('should throw when no API key is configured at all', () => {
      mockGetConfigFromFile.mockReturnValue({});

      expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    });

    it('should throw when GLM apiKey is set but model is missing', async () => {
      mockGetConfigFromFile.mockReturnValue({
        glm: { apiKey: 'glm-key' },
      });

      await reloadConfig();

      expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    });

    it('should throw when Anthropic API key is set but model is missing', async () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';

      try {
        // Reload module with the env var set
        await reloadConfig();

        expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
      } finally {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    });

    it('should return GLM config when GLM is fully configured', async () => {
      mockGetConfigFromFile.mockReturnValue({
        glm: { apiKey: 'glm-key', model: 'glm-5' },
      });

      await reloadConfig();

      const config = Config.getAgentConfig();
      expect(config.provider).toBe('glm');
      expect(config.apiKey).toBe('glm-key');
      expect(config.model).toBe('glm-5');
      expect(config.apiBaseUrl).toBe('https://open.bigmodel.cn/api/anthropic');
    });

    it('should return Anthropic config when Anthropic env is set and model configured', async () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';

      try {
        mockGetConfigFromFile.mockReturnValue({
          agent: { model: 'claude-3-5-sonnet-20241022' },
        });

        // Reload module with the env var set
        await reloadConfig();

        const config = Config.getAgentConfig();
        expect(config.provider).toBe('anthropic');
        expect(config.apiKey).toBe('anthropic-key');
        expect(config.model).toBe('claude-3-5-sonnet-20241022');
      } finally {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    });

    it('should validate GLM when provider is explicitly set to glm', async () => {
      mockGetConfigFromFile.mockReturnValue({
        agent: { provider: 'glm' },
        glm: {},
      });

      await reloadConfig();

      expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    });

    it('should validate Anthropic when provider is explicitly set to anthropic', async () => {
      mockGetConfigFromFile.mockReturnValue({
        agent: { provider: 'anthropic' },
      });

      await reloadConfig();

      expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    });

    it('should prefer GLM over Anthropic when both are configured', async () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';

      try {
        mockGetConfigFromFile.mockReturnValue({
          glm: { apiKey: 'glm-key', model: 'glm-5' },
          agent: { model: 'claude-3-5-sonnet' },
        });

        // Reload module with the env var set so ANTHROPIC_API_KEY is captured
        await reloadConfig();

        const config = Config.getAgentConfig();
        expect(config.provider).toBe('glm');
      } finally {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    });

    it('should throw when GLM provider set but apiKey missing', async () => {
      mockGetConfigFromFile.mockReturnValue({
        agent: { provider: 'glm' },
      });

      await reloadConfig();

      expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    });

    it('should throw when GLM provider set but model missing', async () => {
      mockGetConfigFromFile.mockReturnValue({
        agent: { provider: 'glm' },
        glm: { apiKey: 'glm-key' },
      });

      await reloadConfig();

      expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
    });

    it('should throw when Anthropic provider set but model missing', async () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';

      try {
        mockGetConfigFromFile.mockReturnValue({
          agent: { provider: 'anthropic' },
        });

        await reloadConfig();

        expect(() => Config.getAgentConfig()).toThrow('Configuration validation failed');
      } finally {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    });

    it('should return Anthropic config when Anthropic provider set and both configured', async () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'anthropic-key';

      try {
        mockGetConfigFromFile.mockReturnValue({
          agent: { provider: 'anthropic', model: 'claude-3-5-sonnet' },
        });

        await reloadConfig();

        const config = Config.getAgentConfig();
        expect(config.provider).toBe('anthropic');
        expect(config.apiKey).toBe('anthropic-key');
        expect(config.model).toBe('claude-3-5-sonnet');
      } finally {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    });

    it('should use custom GLM apiBaseUrl when configured', async () => {
      mockGetConfigFromFile.mockReturnValue({
        glm: { apiKey: 'glm-key', model: 'glm-5', apiBaseUrl: 'https://custom.api.com' },
      });

      await reloadConfig();

      const config = Config.getAgentConfig();
      expect(config.apiBaseUrl).toBe('https://custom.api.com');
    });
  });

  describe('validateConfig integration', () => {
    it('should use empty config when validateConfig returns false', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/test/config.yaml' });
      mockValidateConfig.mockReturnValue(false);

      await reloadConfig();

      // Config should still work but with empty config
      expect(Config.FEISHU_APP_ID).toBe('');
      expect(Config.GLM_API_KEY).toBe('');
    });
  });

  describe('CONFIG_SOURCE', () => {
    it('should be undefined when no config file loaded', () => {
      expect(Config.CONFIG_SOURCE).toBeUndefined();
    });

    it('should be set to source path when config file is loaded', async () => {
      mockLoadConfigFile.mockReturnValue({ _fromFile: true, _source: '/path/to/disclaude.config.yaml' });

      await reloadConfig();

      expect(Config.CONFIG_SOURCE).toBe('/path/to/disclaude.config.yaml');
    });
  });

  describe('getToolConfig - additional', () => {
    it('should return tools with mcpServers when configured', async () => {
      const toolsConfig = {
        enabled: ['Read', 'Write'],
        mcpServers: {
          test: { command: 'test-cmd', args: ['--arg'] },
        },
      };
      mockGetConfigFromFile.mockReturnValue({ tools: toolsConfig });

      await reloadConfig();

      const tools = Config.getToolConfig();
      expect(tools).toEqual(toolsConfig);
      expect(tools?.mcpServers).toBeDefined();
    });
  });

  describe('getTransportConfig - additional', () => {
    it('should return transport with http config and auth token', async () => {
      const transportConfig = {
        type: 'http' as const,
        http: {
          execution: { host: '0.0.0.0', port: 3000 },
          authToken: 'secret-token',
        },
      };
      mockGetConfigFromFile.mockReturnValue({ transport: transportConfig });

      await reloadConfig();

      const transport = Config.getTransportConfig();
      expect(transport.type).toBe('http');
      expect(transport.http?.authToken).toBe('secret-token');
    });
  });

  describe('getDebugConfig - additional', () => {
    it('should return partial debug config', async () => {
      mockGetConfigFromFile.mockReturnValue({
        messaging: { debug: { enabled: true } },
      });

      await reloadConfig();

      const debug = Config.getDebugConfig();
      expect(debug.enabled).toBe(true);
      expect(debug.filterForwardChatId).toBeUndefined();
      expect(debug.includeReasons).toBeUndefined();
    });
  });
});
