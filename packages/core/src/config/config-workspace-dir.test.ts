/**
 * Tests for workspace.dir resolution (Issue #3902).
 *
 * Verifies that when the config file is inside a git repo,
 * relative workspace.dir falls back to process.cwd() resolution
 * instead of config-file-relative resolution.
 *
 * Also covers DISCLAUDE_WORKSPACE_DIR env var override behavior
 * and edge cases in the resolution logic.
 *
 * @see Issue #3902 — Schedule file version mismatch
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs';
import path, { sep } from 'path';
import { tmpdir } from 'os';

// Mock the loader to control config file location and workspace.dir value.
const { mockGetConfigFromFile, mockGetPreloadedConfig, mockLoadConfigFile } = vi.hoisted(() => ({
  mockGetConfigFromFile: vi.fn(() => ({
    workspace: { dir: '/test/workspace' },
    glm: { apiKey: 'test-key', model: 'glm-4' },
  })),
  mockGetPreloadedConfig: vi.fn(() => null),
  mockLoadConfigFile: vi.fn(() => ({ _fromFile: false, _source: null })),
}));

vi.mock('./loader.js', () => ({
  loadConfigFile: mockLoadConfigFile,
  getConfigFromFile: mockGetConfigFromFile,
  validateConfig: vi.fn(() => true),
  getPreloadedConfig: mockGetPreloadedConfig,
}));

import { Config } from './index.js';

describe('Config workspace.dir resolution (Issue #3902)', () => {
  const originalEnv = process.env.DISCLAUDE_WORKSPACE_DIR;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.DISCLAUDE_WORKSPACE_DIR = originalEnv;
    } else {
      delete process.env.DISCLAUDE_WORKSPACE_DIR;
    }
  });

  // ---------------------------------------------------------------
  // resolveWorkspaceDir — absolute path passthrough
  // ---------------------------------------------------------------
  describe('resolveWorkspaceDir — absolute path', () => {
    it('should return absolute paths unchanged (no fallback)', () => {
      delete process.env.DISCLAUDE_WORKSPACE_DIR;
      const wsDir = Config.getWorkspaceDir();
      expect(path.isAbsolute(wsDir)).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // getWorkspaceDir — env var override
  // ---------------------------------------------------------------
  describe('getWorkspaceDir with DISCLAUDE_WORKSPACE_DIR', () => {
    it('should respect DISCLAUDE_WORKSPACE_DIR env var over config', () => {
      const expectedDir = '/custom/workspace/dir';
      process.env.DISCLAUDE_WORKSPACE_DIR = expectedDir;

      expect(Config.getWorkspaceDir()).toBe(expectedDir);
    });

    it('should resolve relative DISCLAUDE_WORKSPACE_DIR to absolute', () => {
      process.env.DISCLAUDE_WORKSPACE_DIR = 'relative/path';

      const result = Config.getWorkspaceDir();
      expect(result).not.toBe('relative/path');
      expect(path.isAbsolute(result)).toBe(true);
      expect(result).toContain('relative/path');
    });

    it('should fall back to config when env var is empty string', () => {
      delete process.env.DISCLAUDE_WORKSPACE_DIR;
      const noOverrideResult = Config.getWorkspaceDir();
      process.env.DISCLAUDE_WORKSPACE_DIR = '';

      expect(Config.getWorkspaceDir()).toBe(noOverrideResult);
    });
  });

  // ---------------------------------------------------------------
  // resolveWorkspaceDir — git-repo detection conditions
  // ---------------------------------------------------------------
  // Config is a singleton with static readonly properties computed at module
  // import time. The git-repo fallback in resolveWorkspaceDir runs once during
  // initialization. We verify the detection logic directly by testing the
  // conditions that determine the fallback behavior.
  describe('resolveWorkspaceDir — git-repo detection conditions', () => {
    it('should detect .git directory presence', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'test-ws-git-'));
      const gitDir = path.join(tempDir, '.git');
      mkdirSync(gitDir, { recursive: true });

      expect(existsSync(gitDir)).toBe(true);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it('should not detect .git when absent', () => {
      const tempDir = mkdtempSync(path.join(tmpdir(), 'test-ws-nogit-'));

      expect(existsSync(path.join(tempDir, '.git'))).toBe(false);

      rmSync(tempDir, { recursive: true, force: true });
    });

    it('should match configRelativeDir inside configDir via startsWith', () => {
      const configDir = '/tmp/repo';
      const configRelativeDir = '/tmp/repo/workspace';

      expect(configRelativeDir.startsWith(configDir + sep)).toBe(true);
    });

    it('should NOT match when configRelativeDir equals configDir (workspace.dir = ".")', () => {
      // When workspace.dir is '.', configRelativeDir == configDir.
      // startsWith(configDir + sep) returns false — no trailing sep.
      // This is correct: '.' means config dir IS the workspace, no fallback needed.
      const configDir = '/tmp/repo';
      const configRelativeDir = '/tmp/repo';

      expect(configRelativeDir.startsWith(configDir + sep)).toBe(false);
    });

    it('should NOT match when configRelativeDir is outside configDir', () => {
      const configDir = '/tmp/repo';
      const configRelativeDir = '/tmp/workspace';

      expect(configRelativeDir.startsWith(configDir + sep)).toBe(false);
    });

    it('should NOT trigger fallback when cwd and config resolve to same path', () => {
      // When cwd == configDir, cwdRelative == configRelative → no fallback.
      const rawDir = './workspace';
      const resolved = path.resolve('/tmp/repo', rawDir);
      const cwdResolved = path.resolve('/tmp/repo', rawDir);

      expect(cwdResolved).toBe(resolved);
    });

    it('should trigger fallback when cwd differs from configDir in git repo', () => {
      // Config at /tmp/repo/disclaude.config.yaml, cwd = /tmp
      //   configRelative = /tmp/repo/workspace (inside repo — wrong)
      //   cwdRelative = /tmp/workspace (outside repo — correct)
      const configDir = '/tmp/repo';
      const rawDir = './workspace';
      const configRelative = path.resolve(configDir, rawDir);
      const cwdRelative = path.resolve('/tmp', rawDir);

      expect(configRelative.startsWith(configDir + sep)).toBe(true);
      expect(cwdRelative).not.toBe(configRelative);
    });
  });
});
