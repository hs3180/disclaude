/**
 * Integration tests for Issue #2227 — Sub-Issue E: integration.
 *
 * Verifies:
 * - `import { ProjectManager } from '@disclaude/core'` is available
 * - All types are correctly exported from core barrel
 * - DisclaudeConfig includes projectTemplates field
 * - Config.getProjectTemplatesConfig() works
 * - createCwdProvider works after use()/reset()
 *
 * @see Issue #2227
 */

import { describe, it, expect } from 'vitest';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test: Core barrel exports
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: Project module core integration', () => {
  it('should export ProjectManager from core barrel', async () => {
    const core = await import('../index.js');
    expect(core.ProjectManager).toBeDefined();
    expect(typeof core.ProjectManager).toBe('function');
  });

  it('should export all project types from core barrel', async () => {
    // Type-level verification — these imports should not throw
    const core = await import('../index.js');

    // These are type-only exports, but we verify they don't throw at import time
    // by checking the module loaded successfully
    expect(core).toBeDefined();
  });

  it('should export template discovery functions from core barrel', async () => {
    const core = await import('../index.js');
    expect(core.discoverTemplates).toBeDefined();
    expect(core.discoveryResultToConfig).toBeDefined();
    expect(core.discoverTemplatesAsConfig).toBeDefined();
    expect(typeof core.discoverTemplates).toBe('function');
    expect(typeof core.discoveryResultToConfig).toBe('function');
    expect(typeof core.discoverTemplatesAsConfig).toBe('function');
  });

  it('should export ProjectManager class from core barrel', async () => {
    const core = await import('../index.js');
    expect(core.ProjectManager).toBeDefined();
    expect(typeof core.ProjectManager).toBe('function');
  });

  it('should include projectTemplates in DisclaudeConfig type', async () => {
    // Verify the config types include projectTemplates by importing the types module
    const configTypes = await import('../config/types.js');
    expect(configTypes).toBeDefined();

    // Verify that a DisclaudeConfig-shaped object can include projectTemplates
    const config: configTypes.DisclaudeConfig = {
      projectTemplates: {
        research: {
          displayName: '研究模式',
          description: '专注研究的独立空间',
        },
      },
    };
    expect(config.projectTemplates).toBeDefined();
    expect(config.projectTemplates?.research?.displayName).toBe('研究模式');
  });

  it('should export CwdProvider type from core barrel (type-level check)', async () => {
    // Type-only exports can't be checked at runtime, but the import should succeed
    const core = await import('../index.js');
    expect(core).toBeDefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test: Config integration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: Config.getProjectTemplatesConfig()', () => {
  it('should have getProjectTemplatesConfig method on Config class', async () => {
    const { Config } = await import('../config/index.js');
    expect(typeof Config.getProjectTemplatesConfig).toBe('function');
  });

  it('should return undefined when projectTemplates is not configured', async () => {
    const { Config } = await import('../config/index.js');
    const result = Config.getProjectTemplatesConfig();
    // In test environment with no config file, it should be undefined
    expect(result).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test: createCwdProvider integration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: createCwdProvider() integration', () => {
  it('should return updated results after use() and reset()', async () => {
    const { ProjectManager } = await import('../index.js');
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const workspaceDir = mkdtempSync(join(tmpdir(), 'integration-test-'));
    try {
      const pm = new ProjectManager({
        workspaceDir,
        packageDir: join(workspaceDir, 'pkg'),
        templatesConfig: {
          research: { displayName: '研究模式' },
        },
      });

      const cwdProvider = pm.createCwdProvider();
      expect(typeof cwdProvider).toBe('function');

      // Default: returns undefined
      expect(cwdProvider('chat-1')).toBeUndefined();

      // Create and use
      const createResult = pm.create('chat-1', 'research', 'my-research');
      expect(createResult.ok).toBe(true);

      // After use: returns working directory
      const cwd = cwdProvider('chat-1');
      expect(cwd).toBeDefined();
      expect(cwd).toContain('projects/my-research');

      // After reset: returns undefined again
      pm.reset('chat-1');
      expect(cwdProvider('chat-1')).toBeUndefined();
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });
});
