/**
 * Integration tests for Project module re-exports and config integration.
 *
 * Verifies Issue #2227 (Sub-Issue E — integration) acceptance criteria:
 * - import { ProjectManager } from '@disclaude/core' is available
 * - All types correctly exported
 * - Config type supports projectTemplates field
 * - createCwdProvider returns updated results after use()/reset()
 *
 * @see Issue #2227
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test 1: Re-exports are available
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Project module re-exports (Issue #2227)', () => {
  it('should export ProjectManager class', async () => {
    const mod = await import('../index.js');
    expect(mod.ProjectManager).toBeDefined();
    expect(typeof mod.ProjectManager).toBe('function');
  });

  it('should export discoverTemplates function', async () => {
    const mod = await import('../index.js');
    expect(mod.discoverTemplates).toBeDefined();
    expect(typeof mod.discoverTemplates).toBe('function');
  });

  it('should export discoveryResultToConfig function', async () => {
    const mod = await import('../index.js');
    expect(mod.discoveryResultToConfig).toBeDefined();
    expect(typeof mod.discoveryResultToConfig).toBe('function');
  });

  it('should export discoverTemplatesAsConfig function', async () => {
    const mod = await import('../index.js');
    expect(mod.discoverTemplatesAsConfig).toBeDefined();
    expect(typeof mod.discoverTemplatesAsConfig).toBe('function');
  });

  it('should export all project types (type-only exports)', async () => {
    const mod = await import('../index.js');
    // Type-only exports don't appear at runtime, but we verify
    // the module loads without error
    expect(mod).toBeDefined();
    // Verify the ProjectManager can be instantiated with correct types
    expect(typeof mod.ProjectManager).toBe('function');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test 2: Config type supports projectTemplates
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('DisclaudeConfig.projectTemplates (Issue #2227)', () => {
  it('should accept projectTemplates in config type', async () => {
    // This test verifies the type is correctly extended at compile time
    // If the type is wrong, TypeScript would fail during build
    const { Config } = await import('../config/index.js');
    // getProjectTemplatesConfig should exist
    expect(typeof Config.getProjectTemplatesConfig).toBe('function');
  });

  it('should return undefined when no projectTemplates configured', async () => {
    const { Config } = await import('../config/index.js');
    const config = Config.getProjectTemplatesConfig();
    // In test environment, no config file is loaded, so projectTemplates should be undefined
    expect(config).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test 3: createCwdProvider integration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('createCwdProvider integration (Issue #2227)', () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pm-integ-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    tempDirs.length = 0;
  });

  it('should return undefined for default project (unbound chatId)', async () => {
    const { ProjectManager } = await import('../index.js');
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {},
    });
    const provider = pm.createCwdProvider();
    expect(provider('unbound-chat-id')).toBeUndefined();
  });

  it('should return workingDir after use() binding', async () => {
    const { ProjectManager } = await import('../index.js');
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });

    // Create an instance
    const createResult = pm.create('chat-1', 'research', 'my-research');
    expect(createResult.ok).toBe(true);

    // Bind via use()
    const useResult = pm.use('chat-2', 'my-research');
    expect(useResult.ok).toBe(true);

    // createCwdProvider should reflect the binding
    const provider = pm.createCwdProvider();
    expect(provider('chat-2')).toContain('projects/my-research');
  });

  it('should return undefined after reset()', async () => {
    const { ProjectManager } = await import('../index.js');
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });

    // Create and bind
    pm.create('chat-1', 'research', 'my-research');
    pm.use('chat-1', 'my-research');

    const provider = pm.createCwdProvider();
    expect(provider('chat-1')).toContain('projects/my-research');

    // Reset
    pm.reset('chat-1');
    expect(provider('chat-1')).toBeUndefined();
  });

  it('should work with provider created before binding changes', async () => {
    const { ProjectManager } = await import('../index.js');
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });

    // Create provider BEFORE any binding
    const provider = pm.createCwdProvider();
    expect(provider('chat-1')).toBeUndefined();

    // Create and bind
    pm.create('chat-1', 'research', 'test-project');
    pm.use('chat-1', 'test-project');

    // Provider closure should reflect the update dynamically
    expect(provider('chat-1')).toContain('projects/test-project');

    // Reset
    pm.reset('chat-1');
    expect(provider('chat-1')).toBeUndefined();
  });
});
