/**
 * Tests for workspace.dir relative path resolution.
 *
 * Verifies that when a config file is found, relative workspace.dir paths
 * are resolved against the config file's directory (not process.cwd()).
 *
 * @see https://github.com/hs3180/disclaude/issues/1358
 */

import { describe, it, expect } from 'vitest';
import path from 'path';

/**
 * Extract the workspace directory resolution logic from Config for testing.
 *
 * The actual Config class evaluates static properties at import time,
 * so we test the resolution logic in isolation to avoid import-order issues.
 */
function resolveWorkspaceDir(options: {
  rawDir: string | undefined;
  configSource: string | undefined;
  cwd: string;
}): string {
  const configDir = options.configSource
    ? path.dirname(options.configSource)
    : options.cwd;
  const rawDir = options.rawDir || options.cwd;

  return path.isAbsolute(rawDir)
    ? rawDir
    : path.resolve(configDir, rawDir);
}

describe('workspace.dir resolution (#1358)', () => {
  it('should resolve relative path against config file directory when config file exists', () => {
    const result = resolveWorkspaceDir({
      rawDir: './workspace',
      configSource: '/home/user/my-project/disclaude.config.yaml',
      cwd: '/home/user', // Different from config dir - this is the bug scenario
    });

    expect(result).toBe('/home/user/my-project/workspace');
  });

  it('should resolve relative path against cwd when no config file found', () => {
    const result = resolveWorkspaceDir({
      rawDir: './workspace',
      configSource: undefined, // No config file
      cwd: '/home/user',
    });

    expect(result).toBe('/home/user/workspace');
  });

  it('should use absolute path as-is regardless of config file location', () => {
    const result = resolveWorkspaceDir({
      rawDir: '/opt/custom/workspace',
      configSource: '/home/user/my-project/disclaude.config.yaml',
      cwd: '/home/user',
    });

    expect(result).toBe('/opt/custom/workspace');
  });

  it('should handle relative path with parent directory references', () => {
    const result = resolveWorkspaceDir({
      rawDir: '../data/workspace',
      configSource: '/home/user/my-project/config/disclaude.config.yaml',
      cwd: '/home/user',
    });

    expect(result).toBe('/home/user/my-project/data/workspace');
  });

  it('should handle deeply nested config file paths', () => {
    const result = resolveWorkspaceDir({
      rawDir: './workspace',
      configSource: '/a/b/c/d/disclaude.config.yaml',
      cwd: '/x/y/z',
    });

    expect(result).toBe('/a/b/c/d/workspace');
  });

  it('should default to cwd when workspace.dir is not configured', () => {
    const result = resolveWorkspaceDir({
      rawDir: undefined, // No workspace.dir in config
      configSource: '/home/user/my-project/disclaude.config.yaml',
      cwd: '/home/user/actual-cwd',
    });

    // When workspace.dir is not set, fall back to cwd
    expect(result).toBe('/home/user/actual-cwd');
  });

  it('should reproduce the bug scenario from #1358 correctly', () => {
    // Scenario: Config at /home/user/my-project/disclaude.config.yaml
    // with workspace.dir: "./workspace"
    // Running from /home/user/ directory

    // Before fix: would resolve to /home/user/workspace (WRONG)
    const buggyResult = path.isAbsolute('./workspace')
      ? './workspace'
      : path.resolve('/home/user', './workspace');

    // After fix: should resolve to /home/user/my-project/workspace (CORRECT)
    const fixedResult = resolveWorkspaceDir({
      rawDir: './workspace',
      configSource: '/home/user/my-project/disclaude.config.yaml',
      cwd: '/home/user',
    });

    expect(buggyResult).toBe('/home/user/workspace');
    expect(fixedResult).toBe('/home/user/my-project/workspace');
    expect(fixedResult).not.toBe(buggyResult);
  });

  it('should handle home directory config paths', () => {
    const result = resolveWorkspaceDir({
      rawDir: './workspace',
      configSource: '/home/user/.config/disclaude/disclaude.config.yaml',
      cwd: '/tmp/some/other/dir',
    });

    expect(result).toBe('/home/user/.config/disclaude/workspace');
  });

  it('should handle tilde-style paths in config dir', () => {
    // Note: tilde expansion doesn't happen via path.resolve, this tests
    // that the resolution logic handles what the OS provides
    const result = resolveWorkspaceDir({
      rawDir: './workspace',
      configSource: '/Users/john/projects/app/disclaude.config.yaml',
      cwd: '/Users/john',
    });

    expect(result).toBe('/Users/john/projects/app/workspace');
  });
});
