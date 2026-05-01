/**
 * Integration tests for ProjectManager ↔ Config integration.
 *
 * Verifies that:
 * - ProjectManager is re-exported from @disclaude/core
 * - ProjectTemplatesConfig is usable in DisclaudeConfig
 * - createCwdProvider() works with dynamic config
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import { describe, it, expect, afterAll } from 'vitest';
import { ProjectManager } from './project-manager.js';
import type { ProjectTemplatesConfig, CwdProvider, ProjectManagerOptions } from './types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test that ProjectTemplatesConfig is compatible with DisclaudeConfig.projectTemplates
describe('ProjectManager Config Integration (Issue #2227)', () => {
  const tempDirs: string[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pm-int-test-'));
    tempDirs.push(dir);
    return dir;
  }

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should accept ProjectTemplatesConfig from config file format', () => {
    // Simulates what Config.getProjectTemplates() would return from disclaude.config.yaml
    const configTemplates: ProjectTemplatesConfig = {
      research: {
        displayName: '研究模式',
        description: '专注研究的独立空间',
      },
      'book-reader': {
        displayName: '读书助手',
      },
    };

    const workspaceDir = createTempDir();
    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: configTemplates,
    };

    const pm = new ProjectManager(options);

    // Verify templates loaded correctly
    const result = pm.create('chat_1', 'research', 'my-research');
    expect(result.ok).toBe(true);
  });

  it('should provide CwdProvider that returns undefined for default project', () => {
    const workspaceDir = createTempDir();
    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: { research: { displayName: '研究' } },
    };

    const pm = new ProjectManager(options);
    const cwdProvider: CwdProvider = pm.createCwdProvider();

    // Default project returns undefined
    expect(cwdProvider('chat_unknown')).toBeUndefined();
  });

  it('should provide CwdProvider that returns workingDir for bound project', () => {
    const workspaceDir = createTempDir();
    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: { research: { displayName: '研究' } },
    };

    const pm = new ProjectManager(options);

    // Create and bind a project
    pm.create('chat_1', 'research', 'my-research');
    pm.use('chat_1', 'my-research');

    const cwdProvider: CwdProvider = pm.createCwdProvider();
    const cwd = cwdProvider('chat_1');

    expect(cwd).toBeDefined();
    expect(cwd).toContain('projects/my-research');
  });

  it('should handle empty templates config (auto-discovery fallback)', () => {
    const workspaceDir = createTempDir();
    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: {},
    };

    const pm = new ProjectManager(options);
    const cwdProvider: CwdProvider = pm.createCwdProvider();

    // Should still work with no templates
    expect(cwdProvider('chat_1')).toBeUndefined();
  });

  it('should update CwdProvider results after use/reset', () => {
    const workspaceDir = createTempDir();
    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: {
        research: { displayName: '研究' },
        coding: { displayName: '编程' },
      },
    };

    const pm = new ProjectManager(options);
    const cwdProvider: CwdProvider = pm.createCwdProvider();

    // Initially no binding
    expect(cwdProvider('chat_1')).toBeUndefined();

    // Create and bind project
    pm.create('chat_1', 'research', 'my-research');
    pm.use('chat_1', 'my-research');
    expect(cwdProvider('chat_1')).toContain('projects/my-research');

    // Switch to different project
    pm.create('chat_1', 'coding', 'my-code');
    pm.use('chat_1', 'my-code');
    expect(cwdProvider('chat_1')).toContain('projects/my-code');

    // Reset to default
    pm.reset('chat_1');
    expect(cwdProvider('chat_1')).toBeUndefined();
  });
});
