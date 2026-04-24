/**
 * Tests for Config Anthropic fallback paths in packages/core/src/config/index.ts
 *
 * Covers the uncovered Anthropic provider fallback in getAgentConfig()
 * (lines 358-363) and getSessionTimeoutConfig() with disabled state
 * (lines 489-490).
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi } from 'vitest';

// Mock with Anthropic config (no GLM) to test fallback path
const { mockGetConfigFromFile } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    env: {},
    logging: { level: 'info', pretty: true, rotate: false, sdkDebug: true },
    agent: {
      provider: 'anthropic' as const,
      model: 'claude-sonnet-4-20250514',
      enableAgentTeams: false,
    },
    // No GLM config — forces Anthropic fallback
    glm: {},
    feishu: {},
    workspace: { dir: '/test/workspace' },
    sessionRestore: {
      historyDays: 7,
      maxContextLength: 4000,
      // sessionTimeout is disabled (enabled: false)
      sessionTimeout: {
        enabled: false,
      },
    },
    tools: {},
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

import { Config } from './index.js';

describe('Config - Anthropic fallback paths', () => {
  describe('getAgentConfig', () => {
    it('should return Anthropic config when provider is "anthropic"', () => {
      const config = Config.getAgentConfig();
      expect(config.provider).toBe('anthropic');
      expect(config.model).toBe('claude-sonnet-4-20250514');
      // Anthropic fallback should NOT have apiBaseUrl
      expect(config.apiBaseUrl).toBeUndefined();
    });
  });

  describe('getSessionTimeoutConfig', () => {
    it('should return null when sessionTimeout is disabled', () => {
      const config = Config.getSessionTimeoutConfig();
      expect(config).toBeNull();
    });
  });

  describe('isAgentTeamsEnabled', () => {
    it('should return false when not configured', () => {
      expect(Config.isAgentTeamsEnabled()).toBe(false);
    });
  });

  describe('getSessionRestoreConfig', () => {
    it('should return default values when partially configured', () => {
      const config = Config.getSessionRestoreConfig();
      expect(config.historyDays).toBe(7);
      expect(config.maxContextLength).toBe(4000);
    });
  });

  describe('getAgentConfig validation', () => {
    it('should return correct provider type for Anthropic', () => {
      const config = Config.getAgentConfig();
      expect(config.provider).toBe('anthropic');
    });
  });
});
