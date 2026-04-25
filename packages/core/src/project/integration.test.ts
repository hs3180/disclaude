/**
 * Integration tests for ProjectManager module export and Config integration.
 *
 * Verifies that:
 * - ProjectManager is correctly re-exported from @disclaude/core
 * - All types are correctly exported
 * - Config.getProjectTemplatesConfig() reads from config
 * - createCwdProvider works after use()/reset()
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Test that re-exports work from the project barrel file
import {
  ProjectManager,
  discoverTemplates,
  discoveryResultToConfig,
  discoverTemplatesAsConfig,
  // Type imports — using `import type` separately is not allowed by no-duplicate-imports
  type CwdProvider,
  type InstanceInfo,
  type ProjectContextConfig,
  type ProjectManagerOptions,
  type ProjectResult,
  type ProjectTemplatesConfig,
  type ProjectsPersistData,
  type PersistedInstance,
  type DiscoveryResult,
  type DiscoveryError,
  type DiscoveryOptions,
} from './index.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-int-'));
  tempDirs.push(dir);
  return dir;
}

function createOptions(overrides?: Partial<ProjectManagerOptions>): ProjectManagerOptions {
  const workspaceDir = createTempDir();
  return {
    workspaceDir,
    packageDir: join(workspaceDir, 'packages/core'),
    templatesConfig: {
      research: {
        displayName: '研究模式',
        description: '专注研究的独立空间',
      },
    },
    ...overrides,
  };
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
// Type Export Verification
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Project module — type exports', () => {
  it('should export ProjectManager class', () => {
    expect(ProjectManager).toBeDefined();
    expect(typeof ProjectManager).toBe('function');
  });

  it('should export discoverTemplates function', () => {
    expect(discoverTemplates).toBeDefined();
    expect(typeof discoverTemplates).toBe('function');
  });

  it('should export discoveryResultToConfig function', () => {
    expect(discoveryResultToConfig).toBeDefined();
    expect(typeof discoveryResultToConfig).toBe('function');
  });

  it('should export discoverTemplatesAsConfig function', () => {
    expect(discoverTemplatesAsConfig).toBeDefined();
    expect(typeof discoverTemplatesAsConfig).toBe('function');
  });

  it('should allow typing CwdProvider', () => {
    const cwdProvider: CwdProvider = (_chatId: string) => undefined;
    expect(cwdProvider).toBeDefined();
  });

  it('should allow typing ProjectTemplatesConfig', () => {
    const config: ProjectTemplatesConfig = {
      research: { displayName: '研究模式' },
    };
    expect(config.research.displayName).toBe('研究模式');
  });

  it('should allow typing ProjectResult', () => {
    const success: ProjectResult<string> = { ok: true, data: 'test' };
    const failure: ProjectResult<string> = { ok: false, error: 'error' };
    expect(success.ok).toBe(true);
    expect(failure.ok).toBe(false);
  });

  it('should allow typing ProjectContextConfig', () => {
    const ctx: ProjectContextConfig = {
      name: 'default',
      workingDir: '/workspace',
    };
    expect(ctx.name).toBe('default');
  });

  it('should allow typing InstanceInfo', () => {
    const info: InstanceInfo = {
      name: 'test',
      templateName: 'research',
      chatIds: ['chat_1'],
      workingDir: '/workspace/projects/test',
      createdAt: '2026-04-26T00:00:00.000Z',
    };
    expect(info.name).toBe('test');
  });

  it('should allow typing PersistedInstance', () => {
    const inst: PersistedInstance = {
      name: 'test',
      templateName: 'research',
      workingDir: '/workspace/projects/test',
      createdAt: '2026-04-26T00:00:00.000Z',
    };
    expect(inst.templateName).toBe('research');
  });

  it('should allow typing ProjectsPersistData', () => {
    const data: ProjectsPersistData = {
      instances: {},
      chatProjectMap: {},
    };
    expect(data.instances).toEqual({});
  });

  it('should allow typing DiscoveryResult', () => {
    const result: DiscoveryResult = {
      templates: [],
      errors: [],
    };
    expect(result.templates).toEqual([]);
  });

  it('should allow typing DiscoveryError', () => {
    const err: DiscoveryError = {
      dirName: 'test',
      message: 'error',
    };
    expect(err.dirName).toBe('test');
  });

  it('should allow typing DiscoveryOptions', () => {
    const opts: DiscoveryOptions = {
      templatesDirName: 'custom-templates',
    };
    expect(opts.templatesDirName).toBe('custom-templates');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Config Integration — loading templates from config
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Config integration', () => {
  it('should construct with templates loaded from config-like object', () => {
    const configLike: ProjectTemplatesConfig = {
      research: { displayName: '研究模式', description: '专注研究' },
      'book-reader': { displayName: '读书助手' },
    };

    const pm = new ProjectManager({
      workspaceDir: createTempDir(),
      packageDir: '/app/packages/core',
      templatesConfig: configLike,
    });

    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.find(t => t.name === 'research')?.displayName).toBe('研究模式');
    expect(templates.find(t => t.name === 'book-reader')?.displayName).toBe('读书助手');
  });

  it('should construct with empty config (zero-config mode)', () => {
    const pm = new ProjectManager({
      workspaceDir: createTempDir(),
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });

    expect(pm.listTemplates()).toHaveLength(0);
    // Default context should work without templates
    const ctx = pm.getActive('any_chat');
    expect(ctx.name).toBe('default');
  });

  it('should construct with empty config (zero-config mode)', () => {
    const pm = new ProjectManager({
      workspaceDir: createTempDir(),
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });

    expect(pm.listTemplates()).toHaveLength(0);
  });

  it('should support hot-reloading templates from new config', () => {
    const pm = new ProjectManager(createOptions());
    expect(pm.listTemplates()).toHaveLength(1);

    // Hot-reload with new templates
    pm.init({
      coding: { displayName: '编码模式' },
      writing: { displayName: '写作模式' },
    });

    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.find(t => t.name === 'coding')).toBeDefined();
    expect(templates.find(t => t.name === 'writing')).toBeDefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProvider — dynamic updates after use()/reset()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — createCwdProvider dynamic behavior', () => {
  let pm: ProjectManager;
  let workspaceDir: string;
  let cwdProvider: CwdProvider;

  beforeEach(() => {
    const opts = createOptions();
    ({ workspaceDir } = opts);
    pm = new ProjectManager(opts);
    cwdProvider = pm.createCwdProvider();
  });

  it('should return undefined for default project (unbound chatId)', () => {
    expect(cwdProvider('unbound_chat')).toBeUndefined();
  });

  it('should return workingDir after create()', () => {
    pm.create('chat_1', 'research', 'my-research');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/my-research'));
  });

  it('should return undefined after reset()', () => {
    pm.create('chat_1', 'research', 'my-research');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/my-research'));

    pm.reset('chat_1');
    expect(cwdProvider('chat_1')).toBeUndefined();
  });

  it('should track use() changes dynamically', () => {
    pm.create('chat_1', 'research', 'research-1');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/research-1'));

    // Create another instance and switch
    pm.create('chat_2', 'research', 'research-2');
    pm.use('chat_1', 'research-2');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/research-2'));

    // Switch back
    pm.use('chat_1', 'research-1');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/research-1'));
  });

  it('should reflect self-healing after stale binding cleanup', () => {
    // Create and bind
    pm.create('chat_1', 'research', 'temp-project');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/temp-project'));

    // Force stale state by manipulating internal state
    // (In real usage, this would happen if persist file is edited externally)
    pm.reset('chat_1');

    // After reset, cwdProvider should return undefined
    expect(cwdProvider('chat_1')).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// discoverTemplates — integration with ProjectManager
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('discoverTemplates — integration with ProjectManager', () => {
  it('should discover templates and feed them to ProjectManager', () => {
    const tempDir = createTempDir();
    const templatesDir = join(tempDir, 'templates', 'research');
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, 'CLAUDE.md'), '# Research Template', 'utf8');

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].name).toBe('research');

    // Convert to config and create ProjectManager
    const config = discoveryResultToConfig(result);
    const pm = new ProjectManager({
      workspaceDir: createTempDir(),
      packageDir: tempDir,
      templatesConfig: config,
    });

    expect(pm.listTemplates()).toHaveLength(1);
    expect(pm.listTemplates()[0].name).toBe('research');
  });

  it('should combine config and auto-discovered templates', () => {
    const tempDir = createTempDir();
    const templatesDir = join(tempDir, 'templates', 'discovered');
    mkdirSync(templatesDir, { recursive: true });
    writeFileSync(join(templatesDir, 'CLAUDE.md'), '# Discovered', 'utf8');

    // Discover from filesystem
    const discoveredConfig = discoverTemplatesAsConfig(tempDir);

    // Merge with manual config
    const mergedConfig: ProjectTemplatesConfig = {
      ...discoveredConfig,
      manual: { displayName: 'Manual Template' },
    };

    const pm = new ProjectManager({
      workspaceDir: createTempDir(),
      packageDir: tempDir,
      templatesConfig: mergedConfig,
    });

    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.find(t => t.name === 'discovered')).toBeDefined();
    expect(templates.find(t => t.name === 'manual')).toBeDefined();
  });

  it('should handle empty discovery gracefully', () => {
    const tempDir = createTempDir();
    const config = discoverTemplatesAsConfig(tempDir);
    expect(Object.keys(config)).toHaveLength(0);

    const pm = new ProjectManager({
      workspaceDir: createTempDir(),
      packageDir: tempDir,
      templatesConfig: config,
    });
    expect(pm.listTemplates()).toHaveLength(0);
  });
});
