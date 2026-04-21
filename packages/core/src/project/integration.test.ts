/**
 * Integration tests for ProjectManager module exports and config integration.
 *
 * Verifies:
 * - Re-exports from @disclaude/core (index.ts)
 * - DisclaudeConfig.projectTemplates type integration
 * - Config.getProjectTemplatesConfig() accessor
 * - createCwdProvider() integration with config-driven templates
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-integ-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Re-export verification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Project module re-exports from @disclaude/core', () => {
  it('should export ProjectManager class', async () => {
    const { ProjectManager } = await import('../index.js');
    expect(ProjectManager).toBeDefined();
    expect(typeof ProjectManager).toBe('function');
  });

  it('should export ProjectManager-related types', async () => {
    // Types can't be checked at runtime, but we verify the module doesn't throw
    const module = await import('../index.js');
    // Check that the module has the expected exports (functions and classes)
    expect(module.ProjectManager).toBeDefined();
    expect(module.discoverTemplates).toBeDefined();
    expect(module.discoveryResultToConfig).toBeDefined();
    expect(module.discoverTemplatesAsConfig).toBeDefined();
  });

  it('should export discoverTemplates function', async () => {
    const { discoverTemplates } = await import('../index.js');
    expect(typeof discoverTemplates).toBe('function');
  });

  it('should export discoveryResultToConfig function', async () => {
    const { discoveryResultToConfig } = await import('../index.js');
    expect(typeof discoveryResultToConfig).toBe('function');
  });

  it('should export discoverTemplatesAsConfig function', async () => {
    const { discoverTemplatesAsConfig } = await import('../index.js');
    expect(typeof discoverTemplatesAsConfig).toBe('function');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Config integration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Config.getProjectTemplatesConfig()', () => {
  it('should return undefined when projectTemplates is not configured', async () => {
    const { Config } = await import('../config/index.js');
    const templates = Config.getProjectTemplatesConfig();
    // Default config doesn't have projectTemplates
    expect(templates).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProvider integration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('createCwdProvider() integration', () => {
  it('should create CwdProvider that returns undefined for default project', async () => {
    const { ProjectManager } = await import('../index.js');
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: {},
    });

    const cwdProvider = pm.createCwdProvider();
    expect(cwdProvider('unbound_chat')).toBeUndefined();
  });

  it('should create CwdProvider that returns workingDir for bound project', async () => {
    const { ProjectManager } = await import('../index.js');
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: {
        research: { displayName: 'Research' },
      },
    });

    const result = pm.create('chat_1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    const cwdProvider = pm.createCwdProvider();
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/my-research'));
  });

  it('should dynamically update after use() and reset()', async () => {
    const { ProjectManager } = await import('../index.js');
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: {
        research: { displayName: 'Research' },
        coding: { displayName: 'Coding' },
      },
    });

    const cwdProvider = pm.createCwdProvider();

    pm.create('chat_1', 'research', 'research-1');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/research-1'));

    pm.reset('chat_1');
    expect(cwdProvider('chat_1')).toBeUndefined();

    pm.create('chat_1', 'coding', 'code-1');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/code-1'));
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Template discovery + ProjectManager integration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Template discovery integration', () => {
  it('should discover templates and convert to config for ProjectManager', async () => {
    const { discoverTemplates, discoveryResultToConfig, ProjectManager } = await import('../index.js');

    // Discover from a non-existent directory — should return empty
    const result = discoverTemplates('/nonexistent/path');
    const config = discoveryResultToConfig(result);
    expect(Object.keys(config)).toHaveLength(0);

    // ProjectManager should work with empty config
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: config,
    });
    expect(pm.listTemplates()).toHaveLength(0);
  });
});
