/**
 * Tests for Config.getProjectTemplatesConfig() method.
 *
 * Verifies that project templates can be loaded from disclaude.config.yaml
 * and passed to ProjectManager for initialization.
 *
 * @see Issue #2227 (Sub-Issue E — config integration)
 */

import { describe, it, expect, vi } from 'vitest';

// Use vi.hoisted to ensure mocks are available before module import
const { mockGetConfigFromFile, mockGetPreloadedConfig } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    projectTemplates: {
      research: {
        displayName: '研究模式',
        description: '专注研究的独立空间',
      },
      writing: {
        displayName: '写作模式',
        description: '长文写作空间',
      },
    },
    env: {},
    logging: { level: 'info', pretty: true, rotate: false, sdkDebug: false },
    agent: { provider: 'glm' as const },
    glm: { apiKey: 'test-key', model: 'glm-4' },
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
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === 'which' && args[0] === 'claude-agent-acp') {
      return '/usr/local/bin/claude-agent-acp';
    }
    return '';
  }),
}));

import { Config } from './index.js';

describe('Config.getProjectTemplatesConfig (Issue #2227)', () => {
  it('should return project templates from config', () => {
    const templates = Config.getProjectTemplatesConfig();
    expect(templates).toBeDefined();
    expect(templates?.research).toEqual({
      displayName: '研究模式',
      description: '专注研究的独立空间',
    });
    expect(templates?.writing).toEqual({
      displayName: '写作模式',
      description: '长文写作空间',
    });
  });

  it('should return all configured template names', () => {
    const templates = Config.getProjectTemplatesConfig();
    expect(Object.keys(templates ?? {})).toEqual(['research', 'writing']);
  });

  it('should return templates compatible with ProjectManager.init()', () => {
    const templates = Config.getProjectTemplatesConfig();
    expect(templates).toBeDefined();

    // Verify it matches the ProjectTemplatesConfig format
    for (const [name, meta] of Object.entries(templates ?? {})) {
      expect(typeof name).toBe('string');
      expect(typeof meta).toBe('object');
      if (meta.displayName !== undefined) {
        expect(typeof meta.displayName).toBe('string');
      }
      if (meta.description !== undefined) {
        expect(typeof meta.description).toBe('string');
      }
    }
  });
});
