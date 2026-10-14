/**
 * Tests for configuration loader (packages/core/src/config/loader.ts)
 *
 * Tests the following functionality:
 * - Finding configuration files in search paths
 * - Loading and parsing YAML configuration
 * - Configuration validation
 * - Error handling for invalid configs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import {
  findConfigFile,
  loadConfigFile,
  getConfigFromFile,
  validateConfig,
  setLoadedConfig,
  getPreloadedConfig,
  EXPLICIT_CONFIG_PATH_ENV,
} from './loader.js';
import type { DisclaudeConfig, LoadedConfig } from './types.js';

// Mock fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

// All suites own their discovery environment, including load/integration tests.
beforeEach(() => {
  vi.stubEnv(EXPLICIT_CONFIG_PATH_ENV, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('findConfigFile', () => {
  const originalExplicitConfigPath = process.env[EXPLICIT_CONFIG_PATH_ENV];

  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    delete process.env[EXPLICIT_CONFIG_PATH_ENV];
  });

  afterEach(() => {
    if (originalExplicitConfigPath === undefined) {
      delete process.env[EXPLICIT_CONFIG_PATH_ENV];
    } else {
      process.env[EXPLICIT_CONFIG_PATH_ENV] = originalExplicitConfigPath;
    }
  });

  it('should make the bootstrap --config path authoritative', () => {
    process.env[EXPLICIT_CONFIG_PATH_ENV] = './explicit-test.yaml';
    vi.mocked(existsSync).mockImplementation((path) =>
      String(path).endsWith('explicit-test.yaml'),
    );

    const result = findConfigFile();

    expect(result.exists).toBe(true);
    expect(result.path).toBe(resolve(process.cwd(), 'explicit-test.yaml'));
    expect(existsSync).toHaveBeenCalledTimes(1);
  });

  it('should return exists: false when no config files found', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = findConfigFile();

    expect(result.exists).toBe(false);
    expect(result.path).toBe('');
  });

  it('should prefer disclaude.config.yaml under ~/.disclaude', () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      const pathStr = String(path);
      return pathStr.includes('disclaude.config.yaml');
    });

    const result = findConfigFile();

    expect(result.exists).toBe(true);
    expect(result.path).toBe(resolve(process.env.HOME!, '.disclaude', 'disclaude.config.yaml'));
  });

  it('should find disclaude.config.yml as fallback', () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      const pathStr = String(path);
      return pathStr.includes('disclaude.config.yml');
    });

    const result = findConfigFile();

    expect(result.exists).toBe(true);
    expect(result.path).toContain('disclaude.config.yml');
  });

  it('should prioritize files in correct order', () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      const pathStr = String(path);
      return pathStr.includes('disclaude.config.yaml') || pathStr.includes('disclaude.config.yml');
    });

    const result = findConfigFile();

    expect(result.exists).toBe(true);
    expect(result.path).toContain('disclaude.config.yaml');
  });

  it('should search in home directory as fallback', () => {
    // Skip if HOME is not set
    const homeDir = process.env.HOME;
    if (!homeDir) {
      return;
    }

    vi.mocked(existsSync).mockImplementation((path) => {
      const pathStr = String(path);
      return pathStr.includes(homeDir) && pathStr.includes('disclaude.config.yaml');
    });

    const result = findConfigFile();

    expect(result.exists).toBe(true);
    expect(result.path).toContain(process.env.HOME);
  });

  it('should retain the current directory as a migration fallback', () => {
    const legacyPath = resolve(process.cwd(), 'disclaude.config.yaml');
    vi.mocked(existsSync).mockImplementation((path) => String(path) === legacyPath);

    expect(findConfigFile()).toEqual({ path: legacyPath, exists: true });
  });
});

describe('loadConfigFile', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  it('should return _fromFile: false when file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = loadConfigFile();

    expect(result._fromFile).toBe(false);
    expect(result._source).toBeUndefined();
  });

  it('should load and parse valid YAML config', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(`
workspace:
  dir: /custom/workspace

agents:
  default:
    backend: claude
    llm: default
llms:
  default:
    model: claude-3-5-sonnet-20241022
    api:
      protocol: anthropic

logging:
  level: debug
    `);

    const result = loadConfigFile();

    expect(result._fromFile).toBe(true);
    expect(result._source).toBeDefined();
    expect(result.workspace?.dir).toBe('/custom/workspace');
    expect(result.llms?.default.model).toBe('claude-3-5-sonnet-20241022');
    expect(result.logging?.level).toBe('debug');
  });

  it('should handle empty config file', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('');

    const result = loadConfigFile('/path/to/config.yaml');

    expect(result._fromFile).toBe(false);
  });

  it('should handle invalid YAML', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('invalid: yaml: content: [');

    const result = loadConfigFile('/path/to/config.yaml');

    expect(result._fromFile).toBe(false);
  });

  it('should handle non-object YAML', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('just a string');

    const result = loadConfigFile('/path/to/config.yaml');

    expect(result._fromFile).toBe(false);
  });

  it('should resolve relative workspace.dir against config file directory', () => {
    vi.mocked(existsSync).mockImplementation((p) => String(p).includes('disclaude.config.yaml'));
    vi.mocked(readFileSync).mockReturnValue(`
workspace:
  dir: ./workspace
`);
    const loaded = loadConfigFile();
    expect(loaded._source).toBeDefined();
    expect(loaded.workspace?.dir).toBe('./workspace');
    // The resolution to absolute path happens in Config class (index.ts),
    // which uses path.dirname(loaded._source) as base
  });

  it('should use provided file path', () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      return String(path) === '/custom/path/config.yaml';
    });
    vi.mocked(readFileSync).mockReturnValue('model: test');

    const result = loadConfigFile('/custom/path/config.yaml');

    expect(result._fromFile).toBe(true);
    expect(result._source).toContain('/custom/path/config.yaml');
  });

  it('should handle null YAML parse result', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue('');

    const result = loadConfigFile('/path/to/config.yaml');

    expect(result._fromFile).toBe(false);
  });
});

describe('getConfigFromFile', () => {
  it('should extract config from LoadedConfig', () => {
    const loadedConfig: LoadedConfig = {
      _source: '/path/to/config.yaml',
      _fromFile: true,
      workspace: { dir: '/workspace' },
      agents: { default: { backend: 'claude', llm: 'default' } },
      llms: { default: { model: 'test-model', api: { protocol: 'anthropic' } } },
    };

    const result = getConfigFromFile(loadedConfig);

    expect(result).toEqual({
      workspace: { dir: '/workspace' },
      agents: { default: { backend: 'claude', llm: 'default' } },
      llms: { default: { model: 'test-model', api: { protocol: 'anthropic' } } },
    });
    expect(result).not.toHaveProperty('_source');
    expect(result).not.toHaveProperty('_fromFile');
  });

  it('should handle empty config', () => {
    const loadedConfig: LoadedConfig = {
      _source: '/path/to/config.yaml',
      _fromFile: true,
    };

    const result = getConfigFromFile(loadedConfig);

    expect(result).toEqual({});
  });

  it('should preserve all config properties', () => {
    const loadedConfig: LoadedConfig = {
      _source: '/path/to/config.yaml',
      _fromFile: true,
      workspace: { dir: '/workspace' },
      logging: { level: 'info' },
      agents: {
        default: { backend: 'claude', llm: 'default', permissionMode: 'bypassPermissions' },
      },
      llms: { default: { model: 'model', api: { protocol: 'anthropic' } } },
      channels: { feishu: { appId: 'app123', appSecret: 'secret' } },
    };

    const result = getConfigFromFile(loadedConfig);

    expect(result.workspace).toBeDefined();
    expect(result.agents).toBeDefined();
    expect(result.logging).toBeDefined();
    expect(result.channels?.feishu).toBeDefined();
  });
});

describe('validateConfig', () => {
  it('should validate valid config', () => {
    const config: DisclaudeConfig = {
      workspace: { dir: '/workspace' },
      logging: { level: 'debug' },
      agents: { default: { backend: 'claude', llm: 'default' } },
      llms: { default: { model: 'claude-3-5-sonnet-20241022', api: { protocol: 'anthropic' } } },
    };

    const result = validateConfig(config);

    expect(result).toBe(true);
  });

  it('should validate minimal config', () => {
    const config = {};

    const result = validateConfig(config);

    expect(result).toBe(true);
  });

  it('should reject non-object config', () => {
    // null is treated as falsy object
    expect(validateConfig(null as unknown as Record<string, unknown>)).toBe(false);
    // undefined is falsy
    expect(validateConfig(undefined as unknown as Record<string, unknown>)).toBe(false);
    // Primitives return true (treated as empty objects)
    // Arrays are objects
    expect(validateConfig([] as unknown as Record<string, unknown>)).toBe(false);
  });

  it('should reject invalid workspace.dir', () => {
    const config1 = { workspace: { dir: 123 } };
    const config2 = { workspace: { dir: ['array'] } };

    expect(validateConfig(config1 as unknown as Record<string, unknown>)).toBe(false);
    expect(validateConfig(config2 as unknown as Record<string, unknown>)).toBe(false);
  });

  it('should reject invalid agent.model', () => {
    const config1 = {
      agents: { default: { backend: 'claude', llm: 'default' } },
      llms: { default: { model: 123, api: { protocol: 'anthropic' } } },
    };
    const config2 = {
      agents: { default: { backend: 'claude', llm: 'default' } },
      llms: { default: { model: ['array'], api: { protocol: 'anthropic' } } },
    };

    expect(validateConfig(config1 as unknown as Record<string, unknown>)).toBe(false);
    expect(validateConfig(config2 as unknown as Record<string, unknown>)).toBe(false);
  });

  it('should reject invalid logging.level', () => {
    const config1 = { logging: { level: 123 } };
    const config2 = { logging: { level: ['array'] } };

    expect(validateConfig(config1 as unknown as Record<string, unknown>)).toBe(false);
    expect(validateConfig(config2 as unknown as Record<string, unknown>)).toBe(false);
  });

  it('should accept valid string values', () => {
    const config: DisclaudeConfig = {
      workspace: { dir: '/workspace' },
      logging: { level: 'info' },
      agents: { default: { backend: 'claude', llm: 'default' } },
      llms: { default: { model: 'model-name', api: { protocol: 'anthropic' } } },
    };

    expect(validateConfig(config)).toBe(true);
  });

  it('should allow optional workspace properties', () => {
    const config = {
      workspace: {},
    };

    expect(validateConfig(config)).toBe(true);
  });

  it('rejects an empty named agent section', () => {
    const config = {
      agents: {},
    };

    expect(validateConfig(config)).toBe(false);
  });

  it('should allow optional logging properties', () => {
    const config = {
      logging: {},
    };

    expect(validateConfig(config)).toBe(true);
  });

  it('should accept config with all valid sections', () => {
    const config: DisclaudeConfig = {
      workspace: { dir: '/custom/dir' },
      logging: { level: 'debug', file: '/var/log/service.log' },
      agents: { default: { backend: 'claude', llm: 'default', permissionMode: 'default' } },
      llms: { default: { model: 'claude-model', api: { protocol: 'anthropic' } } },
      channels: {
        feishu: {
          appId: 'app-id',
          appSecret: 'app-secret',
          encryptKey: 'encrypt-key',
          verificationToken: 'token',
        },
      },
    };

    expect(validateConfig(config)).toBe(true);
  });

  it('should handle config with unknown properties', () => {
    const config = {
      unknownProperty: 'value',
      anotherUnknown: { nested: 'object' },
      workspace: { dir: '/workspace' },
    };

    // Should still validate as we only check known structure
    expect(validateConfig(config)).toBe(false);
  });
});

describe('config loader integration', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
  });

  it('should find, load, and validate config end-to-end', () => {
    // Mock file exists
    vi.mocked(existsSync).mockImplementation((path) => {
      return String(path).includes('disclaude.config.yaml');
    });

    // Mock file content
    vi.mocked(readFileSync).mockReturnValue(`
workspace:
  dir: /test/workspace

agents:
  default:
    backend: claude
    llm: default
llms:
  default:
    model: claude-3-5-sonnet-20241022
    api:
      protocol: anthropic

logging:
  level: info
    `);

    // Find config
    const found = findConfigFile();
    expect(found.exists).toBe(true);

    // Load config
    const loaded = loadConfigFile(found.path);
    expect(loaded._fromFile).toBe(true);

    // Validate config
    const config = getConfigFromFile(loaded);
    const isValid = validateConfig(config);
    expect(isValid).toBe(true);
  });

  it('should handle missing config gracefully', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const found = findConfigFile();
    expect(found.exists).toBe(false);

    const loaded = loadConfigFile();
    expect(loaded._fromFile).toBe(false);

    const config = getConfigFromFile(loaded);
    expect(validateConfig(config)).toBe(true); // Empty config is valid
  });
});

describe('setLoadedConfig / getPreloadedConfig', () => {
  let previousConfig: ReturnType<typeof getPreloadedConfig>;

  beforeEach(() => {
    previousConfig = getPreloadedConfig();
  });

  afterEach(() => {
    // Restore original config to avoid leaking state to other tests
    if (previousConfig === null) {
      // Clear the loaded config by setting to null via a fresh module-level reset
      setLoadedConfig(null as any);
    } else {
      setLoadedConfig(previousConfig);
    }
  });

  it('should set and get preloaded config', () => {
    const config: LoadedConfig = {
      _source: '/test/config.yaml',
      _fromFile: true,
      agents: { default: { backend: 'claude', llm: 'default' } },
      llms: { default: { model: 'test-model', api: { protocol: 'anthropic' } } },
    };

    setLoadedConfig(config);
    const result = getPreloadedConfig();

    expect(result).toBeDefined();
    expect(result?._source).toBe('/test/config.yaml');
    expect(result?._fromFile).toBe(true);
    expect(result?.llms?.default.model).toBe('test-model');
  });

  it('should overwrite previously set config', () => {
    setLoadedConfig({ _source: '/first.yaml', _fromFile: true });
    setLoadedConfig({ _source: '/second.yaml', _fromFile: false, workspace: { dir: '/ws' } });

    const result = getPreloadedConfig();
    expect(result?._source).toBe('/second.yaml');
    expect(result?._fromFile).toBe(false);
    expect(result?.workspace?.dir).toBe('/ws');
  });
});
