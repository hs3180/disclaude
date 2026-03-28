/**
 * Tests for configuration loader (packages/core/src/config/loader.ts)
 *
 * Tests the following functionality:
 * - Finding configuration files in search paths
 * - Loading and parsing YAML configuration
 * - Configuration validation
 * - Error handling for invalid configs
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import {
  findConfigFile,
  loadConfigFile,
  getConfigFromFile,
  validateConfig,
  validateRequiredConfig,
  setLoadedConfig,
  getPreloadedConfig,
} from './loader.js';

// Mock fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
}));

describe('findConfigFile', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
  });

  it('should return exists: false when no config files found', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = findConfigFile();

    expect(result.exists).toBe(false);
    expect(result.path).toBe('');
  });

  it('should find disclaude.config.yaml in current directory', () => {
    vi.mocked(existsSync).mockImplementation((path) => {
      const pathStr = String(path);
      return pathStr.includes('disclaude.config.yaml');
    });

    const result = findConfigFile();

    expect(result.exists).toBe(true);
    expect(result.path).toContain('disclaude.config.yaml');
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

agent:
  model: claude-3-5-sonnet-20241022

logging:
  level: debug
    `);

    const result = loadConfigFile();

    expect(result._fromFile).toBe(true);
    expect(result._source).toBeDefined();
    expect(result.workspace?.dir).toBe('/custom/workspace');
    expect(result.agent?.model).toBe('claude-3-5-sonnet-20241022');
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
    const loadedConfig = {
      _source: '/path/to/config.yaml',
      _fromFile: true,
      workspace: { dir: '/workspace' },
      agent: { model: 'test-model' },
    };

    const result = getConfigFromFile(loadedConfig);

    expect(result).toEqual({
      workspace: { dir: '/workspace' },
      agent: { model: 'test-model' },
    });
    expect(result).not.toHaveProperty('_source');
    expect(result).not.toHaveProperty('_fromFile');
  });

  it('should handle empty config', () => {
    const loadedConfig = {
      _source: '/path/to/config.yaml',
      _fromFile: true,
    };

    const result = getConfigFromFile(loadedConfig);

    expect(result).toEqual({});
  });

  it('should preserve all config properties', () => {
    const loadedConfig = {
      _source: '/path/to/config.yaml',
      _fromFile: true,
      workspace: { dir: '/workspace' },
      agent: { model: 'model', permission: 'bypass' },
      logging: { level: 'info' },
      feishu: { appId: 'app123', appSecret: 'secret' },
    };

    const result = getConfigFromFile(loadedConfig);

    expect(result.workspace).toBeDefined();
    expect(result.agent).toBeDefined();
    expect(result.logging).toBeDefined();
    expect(result.feishu).toBeDefined();
  });
});

describe('validateConfig', () => {
  it('should validate valid config', () => {
    const config = {
      workspace: { dir: '/workspace' },
      agent: { model: 'claude-3-5-sonnet-20241022' },
      logging: { level: 'debug' },
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
    expect(validateConfig([] as unknown as Record<string, unknown>)).toBe(true);
  });

  it('should reject invalid workspace.dir', () => {
    const config1 = { workspace: { dir: 123 } };
    const config2 = { workspace: { dir: ['array'] } };

    expect(validateConfig(config1 as unknown as Record<string, unknown>)).toBe(false);
    expect(validateConfig(config2 as unknown as Record<string, unknown>)).toBe(false);
  });

  it('should reject invalid agent.model', () => {
    const config1 = { agent: { model: 123 } };
    const config2 = { agent: { model: ['array'] } };

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
    const config = {
      workspace: { dir: '/workspace' },
      agent: { model: 'model-name' },
      logging: { level: 'info' },
    };

    expect(validateConfig(config)).toBe(true);
  });

  it('should allow optional workspace properties', () => {
    const config = {
      workspace: {},
    };

    expect(validateConfig(config)).toBe(true);
  });

  it('should allow optional agent properties', () => {
    const config = {
      agent: {},
    };

    expect(validateConfig(config)).toBe(true);
  });

  it('should allow optional logging properties', () => {
    const config = {
      logging: {},
    };

    expect(validateConfig(config)).toBe(true);
  });

  it('should accept config with all valid sections', () => {
    const config = {
      workspace: { dir: '/custom/dir' },
      agent: { model: 'claude-model', permission: 'default' },
      logging: { level: 'debug', dir: '/var/log' },
      feishu: {
        appId: 'app-id',
        appSecret: 'app-secret',
        encryptKey: 'encrypt-key',
        verificationToken: 'token',
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
    expect(validateConfig(config)).toBe(true);
  });
});

describe('validateRequiredConfig', () => {
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    // Ensure ANTHROPIC_API_KEY is not set for these tests
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalAnthropicKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('should return valid for config with both glm apiKey and model', () => {
    const config = {
      glm: { apiKey: 'glm-key', model: 'glm-5' },
    };

    const result = validateRequiredConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return error when glm apiKey is set without model', () => {
    const config = {
      glm: { apiKey: 'glm-key' },
    };

    const result = validateRequiredConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('glm.model');
    expect(result.errors[0].message).toContain('glm.model is required');
  });

  it('should return error when glm model is set without apiKey', () => {
    const config = {
      glm: { model: 'glm-5' },
    };

    const result = validateRequiredConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('glm.apiKey');
    expect(result.errors[0].message).toContain('glm.apiKey is required');
  });

  it('should return error when ANTHROPIC_API_KEY is set without agent.model', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    const config = {};

    const result = validateRequiredConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('agent.model');
  });

  it('should return valid when ANTHROPIC_API_KEY is set with agent.model', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    const config = {
      agent: { model: 'claude-sonnet-4-20250514' },
    };

    const result = validateRequiredConfig(config);
    expect(result.valid).toBe(true);
  });

  it('should return valid for minimal config without API keys', () => {
    const config = {};

    const result = validateRequiredConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should return multiple errors for multiple validation failures', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';

    const config = {
      glm: { apiKey: 'glm-key' },
    };

    const result = validateRequiredConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('setLoadedConfig / getPreloadedConfig', () => {
  it('should return null initially', () => {
    expect(getPreloadedConfig()).toBeNull();
  });

  it('should store and retrieve preloaded config', () => {
    const config = {
      _source: '/path/to/config.yaml',
      _fromFile: true,
      agent: { model: 'test-model' },
    };

    setLoadedConfig(config);

    const retrieved = getPreloadedConfig();
    expect(retrieved).toEqual(config);
  });

  it('should allow overwriting preloaded config', () => {
    const config1 = {
      _source: '/path/1.yaml',
      _fromFile: true,
    };
    const config2 = {
      _source: '/path/2.yaml',
      _fromFile: true,
      workspace: { dir: '/new-workspace' },
    };

    setLoadedConfig(config1);
    expect(getPreloadedConfig()).toEqual(config1);

    setLoadedConfig(config2);
    expect(getPreloadedConfig()).toEqual(config2);
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

agent:
  model: claude-3-5-sonnet-20241022
  permission: bypass

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
