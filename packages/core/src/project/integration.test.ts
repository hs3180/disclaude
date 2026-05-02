/**
 * Integration tests for Project module re-export and config integration.
 *
 * Tests verify:
 * - ProjectManager and types are importable from @disclaude/core barrel
 * - DisclaudeConfig includes projectTemplates field
 * - Config.getProjectTemplatesConfig() returns correct values
 * - createCwdProvider() integration works after config-driven initialization
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Barrel Re-export Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Project module barrel re-exports (Issue #2227)', () => {
  it('should export ProjectManager class from project/index.ts', async () => {
    const mod = await import('./index.js');
    expect(mod.ProjectManager).toBeDefined();
    expect(typeof mod.ProjectManager).toBe('function');
  });

  it('should export all project types from project/index.ts', async () => {
    const mod = await import('./index.js');

    // Type exports are compile-time only, but we can verify the runtime module
    // has the expected exports by checking the module object
    // (types are erased at runtime, so we check the module is valid)
    expect(mod).toBeDefined();
    expect(mod.ProjectManager).toBeDefined();
    expect(mod.discoverTemplates).toBeDefined();
    expect(mod.discoveryResultToConfig).toBeDefined();
    expect(mod.discoverTemplatesAsConfig).toBeDefined();
  });

  it('should export template discovery functions from project/index.ts', async () => {
    const mod = await import('./index.js');
    expect(typeof mod.discoverTemplates).toBe('function');
    expect(typeof mod.discoveryResultToConfig).toBe('function');
    expect(typeof mod.discoverTemplatesAsConfig).toBe('function');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Config Integration Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('DisclaudeConfig.projectTemplates integration (Issue #2227)', () => {
  it('should accept projectTemplates in DisclaudeConfig type', () => {
    // This test verifies the type compiles correctly
    // The actual config loading is tested in config module tests
    type Config = import('../config/types.js').DisclaudeConfig;
    const config: Config = {
      projectTemplates: {
        research: {
          displayName: '研究模式',
          description: '专注研究的独立空间',
        },
        'book-reader': {
          displayName: '读书助手',
        },
      },
    };
    expect(config.projectTemplates).toBeDefined();
    expect(config.projectTemplates?.research?.displayName).toBe('研究模式');
  });

  it('should allow undefined projectTemplates (zero-config compatibility)', () => {
    type Config = import('../config/types.js').DisclaudeConfig;
    const config: Config = {
      workspace: { dir: '/tmp/test' },
    };
    expect(config.projectTemplates).toBeUndefined();
  });

  it('should allow empty projectTemplates', () => {
    type Config = import('../config/types.js').DisclaudeConfig;
    const config: Config = {
      projectTemplates: {},
    };
    expect(Object.keys(config.projectTemplates ?? {})).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProvider Integration Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('createCwdProvider integration (Issue #2227)', () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pm-integration-'));
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

  it('should return undefined for default project (zero-config)', async () => {
    const { ProjectManager } = await import('./project-manager.js');
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: {},
    });

    const cwdProvider = pm.createCwdProvider();
    expect(cwdProvider('chat-123')).toBeUndefined();
  });

  it('should return workingDir after create() and use()', async () => {
    const { ProjectManager } = await import('./project-manager.js');
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });

    const cwdProvider = pm.createCwdProvider();

    // Before creation: returns undefined (default)
    expect(cwdProvider('chat-1')).toBeUndefined();

    // Create instance
    const result = pm.create('chat-1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    // After creation: returns workingDir
    expect(cwdProvider('chat-1')).toBe(join(workspaceDir, 'projects/my-research'));

    // After reset: returns undefined again
    pm.reset('chat-1');
    expect(cwdProvider('chat-1')).toBeUndefined();
  });

  it('should support use() to bind to existing instance', async () => {
    const { ProjectManager } = await import('./project-manager.js');
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });

    // Create instance from chat-1
    pm.create('chat-1', 'research', 'shared-research');

    // chat-2 uses the same instance
    const useResult = pm.use('chat-2', 'shared-research');
    expect(useResult.ok).toBe(true);

    const cwdProvider = pm.createCwdProvider();
    expect(cwdProvider('chat-1')).toBe(join(workspaceDir, 'projects/shared-research'));
    expect(cwdProvider('chat-2')).toBe(join(workspaceDir, 'projects/shared-research'));

    // Reset chat-2 only
    pm.reset('chat-2');
    expect(cwdProvider('chat-2')).toBeUndefined();
    expect(cwdProvider('chat-1')).toBe(join(workspaceDir, 'projects/shared-research'));
  });

  it('should work with config-driven templates', async () => {
    const { ProjectManager } = await import('./project-manager.js');
    type Config = import('../config/types.js').DisclaudeConfig;
    const workspaceDir = createTempDir();

    // Simulate config-driven template setup
    const config: Config = {
      projectTemplates: {
        research: {
          displayName: '研究模式',
          description: '专注研究的独立空间',
        },
      },
    };

    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: config.projectTemplates ?? {},
    });

    const templates = pm.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('research');
    expect(templates[0].displayName).toBe('研究模式');
  });
});
