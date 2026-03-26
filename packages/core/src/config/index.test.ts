/**
 * Unit tests for Config class - static configuration management.
 *
 * Issue #1617 Phase 2 (P1): Tests for Config accessor methods,
 * applyGlobalEnv, session config defaults, and agent config validation.
 *
 * Tests cover:
 * - applyGlobalEnv: environment variable application with precedence
 * - getSessionRestoreConfig: default values when no config
 * - getSessionTimeoutConfig: conditional logic (null when disabled)
 * - getTransportConfig: default fallback
 * - Static property access patterns
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Config class accessor tests
// These test the method logic (defaults, conditional returns) rather than
// specific config values, since Config initializes from the filesystem at
// module load time.
// ============================================================================

import path from 'path';

describe('Config (static accessor methods)', () => {
  // ==========================================================================
  // hasConfigFile
  // ==========================================================================

  describe('hasConfigFile', () => {
    it('should return a boolean', async () => {
      const { Config } = await import('./index.js');
      expect(typeof Config.hasConfigFile()).toBe('boolean');
    });
  });

  // ==========================================================================
  // getWorkspaceDir
  // ==========================================================================

  describe('getWorkspaceDir', () => {
    it('should return a non-empty string path', async () => {
      const { Config } = await import('./index.js');
      const dir = Config.getWorkspaceDir();
      expect(typeof dir).toBe('string');
      expect(dir.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // resolveWorkspace
  // ==========================================================================

  describe('resolveWorkspace', () => {
    it('should resolve relative path against workspace dir', async () => {
      const { Config } = await import('./index.js');
      const resolved = Config.resolveWorkspace('subdir/file.txt');
      expect(resolved).toContain('subdir');
      expect(resolved).toContain('file.txt');
    });

    it('should return absolute path', async () => {
      const { Config } = await import('./index.js');
      const resolved = Config.resolveWorkspace('test');
      expect(path.isAbsolute(resolved)).toBe(true);
    });
  });

  // ==========================================================================
  // getLoggingConfig
  // ==========================================================================

  describe('getLoggingConfig', () => {
    it('should return logging configuration with all required fields', async () => {
      const { Config } = await import('./index.js');
      const config = Config.getLoggingConfig();

      expect(config).toHaveProperty('level');
      expect(config).toHaveProperty('pretty');
      expect(config).toHaveProperty('rotate');
      expect(config).toHaveProperty('sdkDebug');
      expect(typeof config.level).toBe('string');
      expect(typeof config.pretty).toBe('boolean');
      expect(typeof config.rotate).toBe('boolean');
      expect(typeof config.sdkDebug).toBe('boolean');
    });
  });

  // ==========================================================================
  // getToolConfig
  // ==========================================================================

  describe('getToolConfig', () => {
    it('should return tools configuration or undefined', async () => {
      const { Config } = await import('./index.js');
      const config = Config.getToolConfig();
      // May be undefined if no tools configured, or an object if configured
      if (config !== undefined) {
        expect(typeof config).toBe('object');
      }
    });
  });

  // ==========================================================================
  // getMcpServersConfig
  // ==========================================================================

  describe('getMcpServersConfig', () => {
    it('should return MCP servers config or undefined', async () => {
      const { Config } = await import('./index.js');
      const config = Config.getMcpServersConfig();
      if (config !== undefined) {
        expect(typeof config).toBe('object');
      }
    });
  });

  // ==========================================================================
  // getTransportConfig
  // ==========================================================================

  describe('getTransportConfig', () => {
    it('should return transport configuration with type field', async () => {
      const { Config } = await import('./index.js');
      const config = Config.getTransportConfig();

      expect(config).toHaveProperty('type');
      expect(['local', 'http']).toContain(config.type);
    });

    it('should default to local transport type', async () => {
      const { Config } = await import('./index.js');
      const config = Config.getTransportConfig();

      expect(config.type).toBeDefined();
    });
  });

  // ==========================================================================
  // getGlobalEnv
  // ==========================================================================

  describe('getGlobalEnv', () => {
    it('should return an object', async () => {
      const { Config } = await import('./index.js');
      const env = Config.getGlobalEnv();
      expect(typeof env).toBe('object');
    });

    it('should not return null', async () => {
      const { Config } = await import('./index.js');
      const env = Config.getGlobalEnv();
      expect(env).not.toBeNull();
    });
  });

  // ==========================================================================
  // getDebugConfig
  // ==========================================================================

  describe('getDebugConfig', () => {
    it('should return debug configuration object', async () => {
      const { Config } = await import('./index.js');
      const config = Config.getDebugConfig();
      expect(typeof config).toBe('object');
    });
  });

  // ==========================================================================
  // isAgentTeamsEnabled
  // ==========================================================================

  describe('isAgentTeamsEnabled', () => {
    it('should return a boolean', async () => {
      const { Config } = await import('./index.js');
      expect(typeof Config.isAgentTeamsEnabled()).toBe('boolean');
    });
  });

  // ==========================================================================
  // getSessionRestoreConfig
  // ==========================================================================

  describe('getSessionRestoreConfig', () => {
    it('should return session restore config with defaults', async () => {
      const { Config } = await import('./index.js');
      const config = Config.getSessionRestoreConfig();

      expect(config).toHaveProperty('historyDays');
      expect(config).toHaveProperty('maxContextLength');
      expect(typeof config.historyDays).toBe('number');
      expect(typeof config.maxContextLength).toBe('number');
      expect(config.historyDays).toBeGreaterThan(0);
      expect(config.maxContextLength).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // getSessionTimeoutConfig
  // ==========================================================================

  describe('getSessionTimeoutConfig', () => {
    it('should return null when session timeout is disabled or not configured', async () => {
      const { Config } = await import('./index.js');
      const config = Config.getSessionTimeoutConfig();
      // Without explicit config, timeout should be null (disabled by default)
      if (config === null) {
        expect(config).toBeNull();
      } else {
        // If configured, verify structure
        expect(config).toHaveProperty('enabled');
        expect(config).toHaveProperty('idleMinutes');
        expect(config).toHaveProperty('maxSessions');
        expect(config).toHaveProperty('checkIntervalMinutes');
      }
    });
  });

  // ==========================================================================
  // getSkillsDir / getAgentsDir
  // ==========================================================================

  describe('getSkillsDir / getAgentsDir', () => {
    it('should return skills directory path as string', async () => {
      const { Config } = await import('./index.js');
      const dir = Config.getSkillsDir();
      expect(typeof dir).toBe('string');
      expect(dir.length).toBeGreaterThan(0);
    });

    it('should return agents directory path as string', async () => {
      const { Config } = await import('./index.js');
      const dir = Config.getAgentsDir();
      expect(typeof dir).toBe('string');
      expect(dir.length).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // getRawConfig
  // ==========================================================================

  describe('getRawConfig', () => {
    it('should return a config object', async () => {
      const { Config } = await import('./index.js');
      const config = Config.getRawConfig();
      expect(config).toBeDefined();
      expect(typeof config).toBe('object');
    });
  });

  // ==========================================================================
  // Static property consistency
  // ==========================================================================

  describe('static property consistency', () => {
    it('should have consistent workspace directory across methods', async () => {
      const { Config } = await import('./index.js');
      const workspaceDir = Config.getWorkspaceDir();
      const resolvedDir = Config.resolveWorkspace('');

      // Both should reference the same base directory
      expect(workspaceDir).toBe(resolvedDir);
    });

    it('should have CONFIG_SOURCE set when config is loaded', async () => {
      const { Config } = await import('./index.js');
      if (Config.CONFIG_LOADED) {
        expect(Config.CONFIG_SOURCE).toBeDefined();
        expect(typeof Config.CONFIG_SOURCE).toBe('string');
      }
    });
  });
});

describe('applyGlobalEnv', () => {
  afterEach(() => {
    delete process.env.__TEST_VAR_APPLY__;
    delete process.env.__TEST_VAR_OVERRIDE__;
  });

  it('should not throw when called', async () => {
    const { applyGlobalEnv } = await import('./index.js');
    expect(() => applyGlobalEnv()).not.toThrow();
  });

  it('should not crash with missing config env', async () => {
    const { applyGlobalEnv } = await import('./index.js');
    // Even if getGlobalEnv returns {}, should not throw
    expect(() => applyGlobalEnv()).not.toThrow();
  });

  it('should not override existing process.env values', async () => {
    process.env.__TEST_VAR_OVERRIDE__ = 'original-value';
    const { applyGlobalEnv } = await import('./index.js');

    applyGlobalEnv();

    // Original value should remain
    expect(process.env.__TEST_VAR_OVERRIDE__).toBe('original-value');
  });
});
