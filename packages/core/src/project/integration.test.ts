/**
 * Integration tests for ProjectManager module — barrel exports & config integration.
 *
 * Tests cover Issue #2227 acceptance criteria:
 * - `import { ProjectManager } from '@disclaude/core'` is available
 * - All types correctly exported
 * - Config integration: projectTemplates in DisclaudeConfig
 * - createCwdProvider returns updated results after use()/reset()
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test: Barrel exports from @disclaude/core
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: Project module barrel exports', () => {
  it('should export ProjectManager from barrel file', async () => {
    const { ProjectManager } = await import('./index.js');
    expect(ProjectManager).toBeDefined();
    expect(typeof ProjectManager).toBe('function');
  });

  it('should export all required types from barrel file', async () => {
    const exports = await import('./index.js');

    // Runtime exports (functions/classes)
    expect(exports.ProjectManager).toBeDefined();
    expect(exports.discoverTemplates).toBeDefined();
    expect(exports.discoveryResultToConfig).toBeDefined();
    expect(exports.discoverTemplatesAsConfig).toBeDefined();
  });

  it('should export CwdProvider-compatible function via createCwdProvider', async () => {
    const { ProjectManager } = await import('./index.js');

    const tempDir = mkdtempSync(join(tmpdir(), 'pm-integration-'));
    try {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: join(tempDir, 'pkg'),
        templatesConfig: {
          research: { displayName: '研究模式' },
        },
      });

      const cwdProvider = pm.createCwdProvider();

      // Default: returns undefined
      expect(cwdProvider('chat_unknown')).toBeUndefined();

      // After create: returns workingDir
      pm.create('chat_1', 'research', 'my-research');
      expect(cwdProvider('chat_1')).toBe(join(tempDir, 'projects/my-research'));

      // After use(): updates dynamically
      pm.reset('chat_1');
      expect(cwdProvider('chat_1')).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test: Config integration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: Config integration', () => {
  it('should have projectTemplates in DisclaudeConfig type', () => {
    // Runtime check: ensure the interface allows projectTemplates
    // Type-level correctness is verified by TypeScript compilation
    const config: import('../config/types.js').DisclaudeConfig = {
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
    expect(config.projectTemplates!.research.displayName).toBe('研究模式');
    expect(config.projectTemplates!['book-reader'].description).toBeUndefined();
  });

  it('should export ProjectTemplateEntry type from config types', async () => {
    // Verify the config types module loads without errors
    const types = await import('../config/types.js');
    expect(types).toBeDefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test: createCwdProvider after use()/reset() returns updated results
// (Issue #2227 verification criterion #4)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: createCwdProvider dynamic updates', () => {
  it('should return updated results after use()', async () => {
    const { ProjectManager } = await import('./index.js');

    const tempDir = mkdtempSync(join(tmpdir(), 'pm-cwd-'));
    try {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: join(tempDir, 'pkg'),
        templatesConfig: {
          research: { displayName: '研究' },
          'book-reader': { displayName: '读书' },
        },
      });

      const provider = pm.createCwdProvider();

      // Create two instances
      pm.create('chat_1', 'research', 'research-1');
      pm.create('chat_2', 'book-reader', 'book-1');

      // chat_1 bound to research-1
      expect(provider('chat_1')).toBe(join(tempDir, 'projects/research-1'));

      // Switch chat_1 to book-1 via use()
      pm.use('chat_1', 'book-1');
      expect(provider('chat_1')).toBe(join(tempDir, 'projects/book-1'));

      // Switch back via use()
      pm.use('chat_1', 'research-1');
      expect(provider('chat_1')).toBe(join(tempDir, 'projects/research-1'));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return undefined after reset()', async () => {
    const { ProjectManager } = await import('./index.js');

    const tempDir = mkdtempSync(join(tmpdir(), 'pm-cwd-reset-'));
    try {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: join(tempDir, 'pkg'),
        templatesConfig: {
          research: { displayName: '研究' },
        },
      });

      const provider = pm.createCwdProvider();

      pm.create('chat_1', 'research', 'my-research');
      expect(provider('chat_1')).toBe(join(tempDir, 'projects/my-research'));

      // After reset → undefined (default project)
      pm.reset('chat_1');
      expect(provider('chat_1')).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle multiple chatIds sharing the same instance', async () => {
    const { ProjectManager } = await import('./index.js');

    const tempDir = mkdtempSync(join(tmpdir(), 'pm-cwd-multi-'));
    try {
      const pm = new ProjectManager({
        workspaceDir: tempDir,
        packageDir: join(tempDir, 'pkg'),
        templatesConfig: {
          research: { displayName: '研究' },
        },
      });

      const provider = pm.createCwdProvider();

      pm.create('chat_1', 'research', 'shared-project');
      pm.use('chat_2', 'shared-project');
      pm.use('chat_3', 'shared-project');

      const expectedDir = join(tempDir, 'projects/shared-project');
      expect(provider('chat_1')).toBe(expectedDir);
      expect(provider('chat_2')).toBe(expectedDir);
      expect(provider('chat_3')).toBe(expectedDir);

      // Reset one — others still bound
      pm.reset('chat_2');
      expect(provider('chat_2')).toBeUndefined();
      expect(provider('chat_1')).toBe(expectedDir);
      expect(provider('chat_3')).toBe(expectedDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
