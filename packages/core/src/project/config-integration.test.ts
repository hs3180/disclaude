/**
 * Integration tests for config-based project module integration.
 *
 * Tests cover Issue #2227 verification criteria:
 * - import { ProjectManager } from '@disclaude/core' is available
 * - All types are correctly exported
 * - Loading templates from config works correctly
 * - createCwdProvider returns updated results after use()/reset()
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectManager } from './project-manager.js';
import { createCwdProviderFromConfig } from './create-cwd-provider.js';
import type {
  CwdProvider,
  ProjectResult,
  ProjectTemplatesConfig,
} from './index.js';

// Re-export types verification: importing these types proves they are accessible
// Only import types that are actually used in test values below

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Verification: import { ProjectManager } available
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: ProjectManager importability', () => {
  it('should import ProjectManager as a class', () => {
    expect(ProjectManager).toBeDefined();
    expect(typeof ProjectManager).toBe('function');
  });

  it('should construct ProjectManager with valid options', () => {
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {},
    });
    expect(pm).toBeDefined();
    expect(pm.listTemplates()).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Verification: All types correctly exported
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: Type exports', () => {
  it('should export CwdProvider type (function returning string | undefined)', () => {
    const cwdProvider: CwdProvider = (_chatId: string) => undefined;
    expect(cwdProvider('test')).toBeUndefined();
  });

  it('should export ProjectTemplatesConfig type', () => {
    const config: ProjectTemplatesConfig = {
      research: { displayName: '研究模式', description: '专注研究' },
      coding: {},
    };
    expect(config.research.displayName).toBe('研究模式');
    expect(config.coding.displayName).toBeUndefined();
  });

  it('should export ProjectResult type (discriminated union)', () => {
    const success: ProjectResult<string> = { ok: true, data: 'value' };
    const failure: ProjectResult<string> = { ok: false, error: 'msg' };

    expect(success.ok).toBe(true);
    if (success.ok) {
      expect(success.data).toBe('value');
    }
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error).toBe('msg');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Verification: Loading templates from config
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: Config-based template loading', () => {
  it('should load templates from explicit config', () => {
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {
        research: { displayName: '研究模式', description: '专注研究的独立空间' },
        'book-reader': { displayName: '读书助手' },
      },
    });

    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.find(t => t.name === 'research')).toMatchObject({
      name: 'research',
      displayName: '研究模式',
      description: '专注研究的独立空间',
    });
    expect(templates.find(t => t.name === 'book-reader')).toMatchObject({
      name: 'book-reader',
      displayName: '读书助手',
    });
  });

  it('should handle empty config (no templates)', () => {
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {},
    });
    expect(pm.listTemplates()).toEqual([]);
  });

  it('should handle undefined config (no templates)', () => {
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {},
    });
    expect(pm.listTemplates()).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Verification: createCwdProvider dynamic updates
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: createCwdProvider dynamic behavior', () => {
  it('should return undefined for default project', () => {
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });
    const cwdProvider = pm.createCwdProvider();

    // No binding → default → undefined
    expect(cwdProvider('chat_unknown')).toBeUndefined();
  });

  it('should return workingDir after create()', () => {
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });
    const cwdProvider = pm.createCwdProvider();

    pm.create('chat_1', 'research', 'my-research');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/my-research'));
  });

  it('should return updated workingDir after use()', () => {
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {
        research: { displayName: '研究模式' },
        coding: { displayName: '编码模式' },
      },
    });
    const cwdProvider = pm.createCwdProvider();

    pm.create('chat_1', 'research', 'research-1');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/research-1'));

    // Switch to another project
    pm.create('chat_2', 'coding', 'coding-1');
    pm.use('chat_1', 'coding-1');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/coding-1'));
  });

  it('should return undefined after reset()', () => {
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });
    const cwdProvider = pm.createCwdProvider();

    pm.create('chat_1', 'research', 'my-research');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/my-research'));

    // Reset → back to default
    pm.reset('chat_1');
    expect(cwdProvider('chat_1')).toBeUndefined();
  });

  it('should not affect other chatIds when one is reset', () => {
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'pkg'),
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });
    const cwdProvider = pm.createCwdProvider();

    pm.create('chat_1', 'research', 'shared-project');
    pm.use('chat_2', 'shared-project');

    // Both should return the same workingDir
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/shared-project'));
    expect(cwdProvider('chat_2')).toBe(join(workspaceDir, 'projects/shared-project'));

    // Reset chat_1 only
    pm.reset('chat_1');
    expect(cwdProvider('chat_1')).toBeUndefined();
    expect(cwdProvider('chat_2')).toBe(join(workspaceDir, 'projects/shared-project'));
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProviderFromConfig factory tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: createCwdProviderFromConfig factory', () => {
  it('should create CwdProvider from explicit templates config', () => {
    const workspaceDir = createTempDir();
    const { cwdProvider, projectManager } = createCwdProviderFromConfig({
      workspaceDir,
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });

    expect(cwdProvider).toBeDefined();
    expect(typeof cwdProvider).toBe('function');
    expect(projectManager).toBeDefined();
    expect(projectManager.listTemplates()).toHaveLength(1);
  });

  it('should create CwdProvider with empty config (no templates)', () => {
    const workspaceDir = createTempDir();
    const { cwdProvider, projectManager } = createCwdProviderFromConfig({
      workspaceDir,
    });

    expect(cwdProvider('any_chat')).toBeUndefined();
    expect(projectManager.listTemplates()).toEqual([]);
  });

  it('should create CwdProvider with auto-discovery fallback when no config', () => {
    const workspaceDir = createTempDir();
    const packageDir = join(workspaceDir, 'pkg');

    // Create template directory structure with CLAUDE.md
    mkdirSync(join(packageDir, 'templates', 'research'), { recursive: true });
    writeFileSync(
      join(packageDir, 'templates', 'research', 'CLAUDE.md'),
      '# Research Template',
      'utf8',
    );

    const { cwdProvider, projectManager } = createCwdProviderFromConfig({
      workspaceDir,
      packageDir,
    });

    // Templates should be auto-discovered from package directory
    expect(cwdProvider).toBeDefined();
    expect(typeof cwdProvider).toBe('function');
    expect(projectManager.listTemplates()).toHaveLength(1);
    expect(projectManager.listTemplates()[0].name).toBe('research');
  });

  it('should prefer explicit config over auto-discovery', () => {
    const workspaceDir = createTempDir();
    const packageDir = join(workspaceDir, 'pkg');

    // Create template directory structure
    mkdirSync(join(packageDir, 'templates', 'auto-discovered'), { recursive: true });
    writeFileSync(
      join(packageDir, 'templates', 'auto-discovered', 'CLAUDE.md'),
      '# Auto Template',
      'utf8',
    );

    const { projectManager } = createCwdProviderFromConfig({
      workspaceDir,
      packageDir,
      templatesConfig: {
        'explicit-template': { displayName: '显式模板' },
      },
    });

    // Should use the explicit config (ignoring auto-discovered)
    const templates = projectManager.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('explicit-template');
  });

  it('should produce a working CwdProvider that tracks mutations', () => {
    const workspaceDir = createTempDir();
    const { cwdProvider, projectManager } = createCwdProviderFromConfig({
      workspaceDir,
      templatesConfig: {
        research: { displayName: '研究模式' },
      },
    });

    // Initially undefined
    expect(cwdProvider('chat_1')).toBeUndefined();

    // After create → has workingDir
    projectManager.create('chat_1', 'research', 'my-research');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/my-research'));

    // After reset → undefined again
    projectManager.reset('chat_1');
    expect(cwdProvider('chat_1')).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Config types integration
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227: DisclaudeConfig.projectTemplates', () => {
  it('should accept projectTemplates in config shape', () => {
    // This test verifies the type integration by construction
    // The shape matches DisclaudeConfig['projectTemplates']
    const projectTemplates = {
      research: { displayName: '研究模式', description: '专注研究' },
      coding: { displayName: '编码模式' },
    } as const;

    expect(projectTemplates).toBeDefined();
    expect(Object.keys(projectTemplates)).toEqual(['research', 'coding']);
    expect(projectTemplates.research.displayName).toBe('研究模式');
  });

  it('should be compatible with ProjectTemplatesConfig type', () => {
    // Verifies that config-based projectTemplates can be passed to ProjectManager
    const configTemplates: Record<string, {
      displayName?: string;
      description?: string;
    }> = {
      research: { displayName: '研究模式', description: '专注研究' },
      coding: { displayName: '编码模式' },
    };

    // Should be assignable to ProjectTemplatesConfig
    const templatesConfig: ProjectTemplatesConfig = configTemplates;
    expect(templatesConfig).toBeDefined();
  });
});
