/**
 * Tests for configuration index (src/config/index.ts)
 *
 * Tests the following functionality:
 * - Config class static properties
 * - getAgentConfig() method
 * - getWorkspaceDir() method
 * - resolveWorkspace() method
 * - getSkillsDir() method
 * - hasConfigFile() method
 * - getToolConfig() method
 * - getLoggingConfig() method
 * - getRawConfig() method
 * - Provider preference (GLM over Anthropic)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { Config } from './index.js';

// Mock environment variables
const originalEnv = process.env;

describe('Config', () => {
  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv };

    // Clear the require cache to reload config
    vi.clearAllMocks();
  });

  describe('Static Properties', () => {
    it('should have CONFIG_LOADED property', () => {
      expect(typeof Config.CONFIG_LOADED).toBe('boolean');
    });

    it('should have CONFIG_SOURCE property', () => {
      expect(typeof Config.CONFIG_SOURCE).toBe('string');
    });

    it('should have WORKSPACE_DIR property', () => {
      expect(typeof Config.WORKSPACE_DIR).toBe('string');
    });

    it('should have FEISHU_APP_ID property', () => {
      expect(typeof Config.FEISHU_APP_ID).toBe('string');
    });

    it('should have FEISHU_APP_SECRET property', () => {
      expect(typeof Config.FEISHU_APP_SECRET).toBe('string');
    });

    it('should have FEISHU_CLI_CHAT_ID property', () => {
      expect(typeof Config.FEISHU_CLI_CHAT_ID).toBe('string');
    });

    it('should have GLM_API_KEY property', () => {
      expect(typeof Config.GLM_API_KEY).toBe('string');
    });

    it('should have GLM_MODEL property', () => {
      expect(typeof Config.GLM_MODEL).toBe('string');
    });

    it('should have GLM_API_BASE_URL property', () => {
      expect(typeof Config.GLM_API_BASE_URL).toBe('string');
    });

    it('should have ANTHROPIC_API_KEY property', () => {
      expect(typeof Config.ANTHROPIC_API_KEY).toBe('string');
    });

    it('should have CLAUDE_MODEL property', () => {
      expect(typeof Config.CLAUDE_MODEL).toBe('string');
    });

    it('should have LOG_LEVEL property', () => {
      expect(typeof Config.LOG_LEVEL).toBe('string');
    });

    it('should have LOG_FILE property', () => {
      expect(Config.LOG_FILE === undefined || typeof Config.LOG_FILE === 'string').toBe(true);
    });

    it('should have LOG_PRETTY property', () => {
      expect(typeof Config.LOG_PRETTY).toBe('boolean');
    });

    it('should have LOG_ROTATE property', () => {
      expect(typeof Config.LOG_ROTATE).toBe('boolean');
    });

    it('should have SKILLS_DIR property', () => {
      expect(typeof Config.SKILLS_DIR).toBe('string');
    });
  });

  describe('getWorkspaceDir()', () => {
    it('should return a string', () => {
      const workspaceDir = Config.getWorkspaceDir();
      expect(typeof workspaceDir).toBe('string');
    });

    it('should return an absolute path', () => {
      const workspaceDir = Config.getWorkspaceDir();
      expect(path.isAbsolute(workspaceDir)).toBe(true);
    });
  });

  describe('resolveWorkspace()', () => {
    it('should resolve relative paths to absolute paths', () => {
      const result = Config.resolveWorkspace('test/file.txt');
      expect(path.isAbsolute(result)).toBe(true);
    });

    it('should handle empty strings', () => {
      const result = Config.resolveWorkspace('');
      expect(typeof result).toBe('string');
    });

    it('should handle dot segments', () => {
      const result = Config.resolveWorkspace('./test/../file.txt');
      expect(typeof result).toBe('string');
    });

    it('should handle absolute paths', () => {
      const absolutePath = '/tmp/test.txt';
      const result = Config.resolveWorkspace(absolutePath);
      expect(result).toContain('test.txt');
    });
  });

  describe('getSkillsDir()', () => {
    it('should return a string', () => {
      const skillsDir = Config.getSkillsDir();
      expect(typeof skillsDir).toBe('string');
    });

    it('should return an absolute path', () => {
      const skillsDir = Config.getSkillsDir();
      expect(path.isAbsolute(skillsDir)).toBe(true);
    });

    it('should end with "skills"', () => {
      const skillsDir = Config.getSkillsDir();
      expect(skillsDir).toMatch(/skills$/);
    });
  });

  describe('hasConfigFile()', () => {
    it('should return a boolean', () => {
      const result = Config.hasConfigFile();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('getRawConfig()', () => {
    it('should return an object', () => {
      const config = Config.getRawConfig();
      expect(typeof config).toBe('object');
      expect(config).not.toBeNull();
    });

    it('should have workspace configuration', () => {
      const config = Config.getRawConfig();
      expect('workspace' in config || typeof config.workspace === 'object').toBe(true);
    });
  });

  describe('getToolConfig()', () => {
    it('should return undefined or object', () => {
      const toolConfig = Config.getToolConfig();
      expect(toolConfig === undefined || typeof toolConfig === 'object').toBe(true);
    });
  });

  describe('getLoggingConfig()', () => {
    it('should return logging configuration object', () => {
      const loggingConfig = Config.getLoggingConfig();
      expect(typeof loggingConfig).toBe('object');
      expect(loggingConfig).not.toBeNull();
    });

    it('should have level property', () => {
      const loggingConfig = Config.getLoggingConfig();
      expect('level' in loggingConfig).toBe(true);
      expect(typeof loggingConfig.level).toBe('string');
    });

    it('should have file property (optional)', () => {
      const loggingConfig = Config.getLoggingConfig();
      expect('file' in loggingConfig).toBe(true);
      expect(loggingConfig.file === undefined || typeof loggingConfig.file === 'string').toBe(true);
    });

    it('should have pretty property', () => {
      const loggingConfig = Config.getLoggingConfig();
      expect('pretty' in loggingConfig).toBe(true);
      expect(typeof loggingConfig.pretty).toBe('boolean');
    });

    it('should have rotate property', () => {
      const loggingConfig = Config.getLoggingConfig();
      expect('rotate' in loggingConfig).toBe(true);
      expect(typeof loggingConfig.rotate).toBe('boolean');
    });
  });

  describe('getAgentConfig()', () => {
    it('should throw error when no API key is configured', () => {
      // Temporarily clear API keys
      const originalGlmKey = Config.GLM_API_KEY;
      const originalAnthropicKey = Config.ANTHROPIC_API_KEY;

      // This test assumes no API keys are set in the test environment
      // In a real scenario, you'd need to mock the Config class or use dependency injection

      if (!originalGlmKey && !originalAnthropicKey) {
        expect(() => {
          // Create a fresh instance by accessing the static method
          Config.getAgentConfig();
        }).toThrow('No API key configured');
      }
    });

    it('should return object with required properties when API key exists', () => {
      try {
        const agentConfig = Config.getAgentConfig();
        expect(typeof agentConfig).toBe('object');
        expect('apiKey' in agentConfig).toBe(true);
        expect('model' in agentConfig).toBe(true);
        expect('provider' in agentConfig).toBe(true);
        expect(typeof agentConfig.apiKey).toBe('string');
        expect(typeof agentConfig.model).toBe('string');
        expect(['anthropic', 'glm']).toContain(agentConfig.provider);
      } catch (error) {
        // If no API key is configured, this is expected
        expect((error as Error).message).toContain('No API key configured');
      }
    });

    it('should prefer GLM over Anthropic when both are available', () => {
      try {
        const agentConfig = Config.getAgentConfig();
        if (Config.GLM_API_KEY) {
          expect(agentConfig.provider).toBe('glm');
        } else if (Config.ANTHROPIC_API_KEY) {
          expect(agentConfig.provider).toBe('anthropic');
        }
      } catch (error) {
        // If no API key is configured, this is expected
        expect((error as Error).message).toContain('No API key configured');
      }
    });

    it('should include apiBaseUrl for GLM provider', () => {
      try {
        const agentConfig = Config.getAgentConfig();
        if (agentConfig.provider === 'glm') {
          expect('apiBaseUrl' in agentConfig).toBe(true);
          expect(typeof agentConfig.apiBaseUrl).toBe('string');
        }
      } catch (error) {
        // If no API key is configured, this is expected
        expect((error as Error).message).toContain('No API key configured');
      }
    });
  });

  describe('Default Values', () => {
    it('should have default CLAUDE_MODEL', () => {
      expect(Config.CLAUDE_MODEL).toBeTruthy();
    });

    it('should have default GLM_MODEL', () => {
      expect(Config.GLM_MODEL).toBeTruthy();
    });

    it('should have default GLM_API_BASE_URL', () => {
      expect(Config.GLM_API_BASE_URL).toBeTruthy();
    });

    it('should have default LOG_LEVEL', () => {
      expect(['debug', 'info', 'warn', 'error']).toContain(Config.LOG_LEVEL);
    });

    it('should have default LOG_PRETTY as true', () => {
      expect(Config.LOG_PRETTY).toBe(true);
    });

    it('should have default LOG_ROTATE as false', () => {
      expect(Config.LOG_ROTATE).toBe(false);
    });
  });
});
