/**
 * Tests for DISCLAUDE_WORKSPACE_DIR env var override (Issue #3414).
 *
 * Verifies that the workspace directory can be overridden via environment
 * variable for test isolation, preventing the Scheduler from loading
 * production schedule files.
 *
 * The global test setup (tests/setup.ts) sets DISCLAUDE_WORKSPACE_DIR to
 * a temp directory. These tests verify that Config picks up that value
 * instead of the config file's workspace.dir setting.
 *
 * @see Issue #3414 - Workspace/schedule isolation for tests
 */

import { describe, it, expect, vi } from 'vitest';

// Mock loader to return a config with a specific workspace dir
const { mockGetConfigFromFile, mockGetPreloadedConfig } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    workspace: { dir: '/production/workspace' },
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

import { Config } from './index.js';

describe('Config workspace env override (Issue #3414)', () => {
  it('should use DISCLAUDE_WORKSPACE_DIR env var over config file', () => {
    // The config file mock sets workspace.dir to '/production/workspace'.
    // If the env var override works, WORKSPACE_DIR should match the env var
    // (set by tests/setup.ts) instead of the config file value.
    const envValue = process.env.DISCLAUDE_WORKSPACE_DIR;
    expect(envValue).toBeDefined();
    expect(Config.WORKSPACE_DIR).toBe(envValue);
    expect(Config.WORKSPACE_DIR).not.toBe('/production/workspace');
  });

  it('should report env-override source from getWorkspaceDir()', () => {
    const dir = Config.getWorkspaceDir();
    const envValue = process.env.DISCLAUDE_WORKSPACE_DIR;
    expect(dir).toBe(envValue);
    // Should NOT be the config file value
    expect(dir).not.toBe('/production/workspace');
  });
});
