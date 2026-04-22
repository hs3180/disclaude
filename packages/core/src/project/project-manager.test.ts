/**
 * Unit tests for ProjectManager — in-memory + persistence logic.
 *
 * Tests cover:
 * - Template loading and querying
 * - Instance creation with input validation
 * - chatId binding (use/reset)
 * - Stale binding self-healing
 * - Path traversal protection
 * - CwdProvider factory
 * - Persistence (atomic write, load, restore, corruption handling)
 * - Delete operation
 * - Edge cases (empty config, duplicate names, etc.)
 *
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #2225 (Sub-Issue C — persistence layer)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectManager } from './project-manager.js';
import type { ProjectManagerOptions, ProjectTemplatesConfig } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-test-'));
  tempDirs.push(dir);
  return dir;
}

function createOptions(overrides?: Partial<ProjectManagerOptions>): ProjectManagerOptions {
  const workspaceDir = createTempDir();
  const packageDir = join(workspaceDir, 'packages/core');

  // Create template directories with CLAUDE.md files for file system operations
  mkdirSync(join(packageDir, 'templates/research'), { recursive: true });
  writeFileSync(join(packageDir, 'templates/research/CLAUDE.md'), '# Research Template', 'utf8');

  mkdirSync(join(packageDir, 'templates/book-reader'), { recursive: true });
  writeFileSync(join(packageDir, 'templates/book-reader/CLAUDE.md'), '# Book Reader Template', 'utf8');

  return {
    workspaceDir,
    packageDir,
    templatesConfig: {
      research: {
        displayName: '研究模式',
        description: '专注研究的独立空间',
      },
      'book-reader': {
        displayName: '读书助手',
      },
    },
    ...overrides,
  };
}

const EMPTY_CONFIG: ProjectTemplatesConfig = {};

// Cleanup all temp directories after all tests
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
// Constructor & init()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager constructor', () => {
  it('should construct with valid options and load templates', () => {
    const pm = new ProjectManager(createOptions());
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
    expect(templates[0].name).toBe('book-reader');
    expect(templates[1].name).toBe('research');
  });

  it('should construct with empty templates config', () => {
    const pm = new ProjectManager(createOptions({ templatesConfig: {} }));
    expect(pm.listTemplates()).toHaveLength(0);
  });

  it('should construct with undefined templates config', () => {
    const pm = new ProjectManager(createOptions({ templatesConfig: undefined }));
    expect(pm.listTemplates()).toHaveLength(0);
  });
});

describe('ProjectManager init()', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    pm = new ProjectManager(createOptions());
  });

  it('should reload templates from new config', () => {
    pm.init({ coding: { displayName: '编码模式' } });
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('coding');
  });

  it('should not clear instances when re-initializing templates', () => {
    const result = pm.create('chat_1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    pm.init({ research: { displayName: 'Updated' } });

    // Instance should still exist
    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe('my-research');
  });

  it('should clear all templates with empty config', () => {
    pm.init({});
    expect(pm.listTemplates()).toHaveLength(0);
  });

  it('should handle undefined config in init', () => {
    pm.init(undefined);
    expect(pm.listTemplates()).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getActive()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager getActive()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    const opts = createOptions();
    ({ workspaceDir } = opts);
    pm = new ProjectManager(opts);
  });

  it('should return default context for unbound chatId', () => {
    const ctx = pm.getActive('chat_unknown');
    expect(ctx.name).toBe('default');
    expect(ctx.workingDir).toBe(workspaceDir);
    expect(ctx.templateName).toBeUndefined();
  });

  it('should return bound instance context for bound chatId', () => {
    const createResult = pm.create('chat_1', 'research', 'my-research');
    expect(createResult.ok).toBe(true);

    const ctx = pm.getActive('chat_1');
    expect(ctx.name).toBe('my-research');
    expect(ctx.templateName).toBe('research');
    expect(ctx.workingDir).toBe(join(workspaceDir, 'projects/my-research'));
  });

  it('should self-heal stale bindings after reset', () => {
    pm.create('chat_1', 'research', 'temp-project');
    expect(pm.getActive('chat_1').name).toBe('temp-project');

    pm.reset('chat_1');
    const ctxAfterReset = pm.getActive('chat_1');
    expect(ctxAfterReset.name).toBe('default');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// create()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager create()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    const opts = createOptions();
    ({ workspaceDir } = opts);
    pm = new ProjectManager(opts);
  });

  it('should create instance from valid template', () => {
    const result = pm.create('chat_1', 'research', 'my-research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('my-research');
      expect(result.data.templateName).toBe('research');
      expect(result.data.workingDir).toBe(join(workspaceDir, 'projects/my-research'));
    }
  });

  it('should auto-bind the creating chatId to the new instance', () => {
    pm.create('chat_1', 'research', 'my-research');
    const ctx = pm.getActive('chat_1');
    expect(ctx.name).toBe('my-research');
  });

  it('should reject non-existent template', () => {
    const result = pm.create('chat_1', 'nonexistent', 'test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('nonexistent');
    }
  });

  it('should reject duplicate instance name', () => {
    pm.create('chat_1', 'research', 'my-research');
    const result = pm.create('chat_2', 'research', 'my-research');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('已存在');
    }
  });

  it('should allow creating instances from different templates', () => {
    const r1 = pm.create('chat_1', 'research', 'research-1');
    const r2 = pm.create('chat_2', 'book-reader', 'book-1');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// create() — Input Validation (Path Traversal)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager create() — name validation', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    pm = new ProjectManager(createOptions());
  });

  it('should reject empty name', () => {
    const result = pm.create('chat_1', 'research', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject "default" as name', () => {
    const result = pm.create('chat_1', 'research', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名称');
    }
  });

  it('should reject path traversal ".." in name', () => {
    const result = pm.create('chat_1', 'research', '..');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('路径遍历');
    }
  });

  it('should reject name containing ".." segment', () => {
    const result = pm.create('chat_1', 'research', 'foo..bar');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('路径遍历');
    }
  });

  it('should reject name with forward slash', () => {
    const result = pm.create('chat_1', 'research', 'foo/bar');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('/');
    }
  });

  it('should reject name with backslash', () => {
    const result = pm.create('chat_1', 'research', 'foo\\bar');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('\\');
    }
  });

  it('should reject name with null bytes', () => {
    const result = pm.create('chat_1', 'research', 'foo\x00bar');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('空字节');
    }
  });

  it('should reject whitespace-only name', () => {
    const result = pm.create('chat_1', 'research', '   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('空白');
    }
  });

  it('should reject name exceeding 64 characters', () => {
    const longName = 'a'.repeat(65);
    const result = pm.create('chat_1', 'research', longName);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('64');
    }
  });

  it('should accept name at exactly 64 characters', () => {
    const name64 = 'a'.repeat(64);
    const result = pm.create('chat_1', 'research', name64);
    expect(result.ok).toBe(true);
  });

  it('should accept hyphens and underscores in name', () => {
    const result = pm.create('chat_1', 'research', 'my-research_project');
    expect(result.ok).toBe(true);
  });

  it('should accept unicode in name', () => {
    const result = pm.create('chat_1', 'research', '研究项目');
    expect(result.ok).toBe(true);
  });
});

describe('ProjectManager create() — chatId validation', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    pm = new ProjectManager(createOptions());
  });

  it('should reject empty chatId', () => {
    const result = pm.create('', 'research', 'test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatId');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// use()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager use()', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    pm = new ProjectManager(createOptions());
  });

  it('should bind chatId to existing instance', () => {
    pm.create('chat_1', 'research', 'my-research');
    const result = pm.use('chat_2', 'my-research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('my-research');
    }

    // Both chatIds should resolve to same instance
    expect(pm.getActive('chat_1').name).toBe('my-research');
    expect(pm.getActive('chat_2').name).toBe('my-research');
  });

  it('should rebind chatId to different instance', () => {
    pm.create('chat_1', 'research', 'research-1');
    pm.create('chat_1', 'book-reader', 'book-1');

    // Now chat_1 should be bound to book-1 (latest create)
    expect(pm.getActive('chat_1').name).toBe('book-1');

    // Explicitly rebind to research-1
    const result = pm.use('chat_1', 'research-1');
    expect(result.ok).toBe(true);
    expect(pm.getActive('chat_1').name).toBe('research-1');
  });

  it('should reject binding to non-existent instance', () => {
    const result = pm.use('chat_1', 'nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should reject empty chatId', () => {
    pm.create('chat_1', 'research', 'my-research');
    const result = pm.use('', 'my-research');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatId');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// reset()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager reset()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    const opts = createOptions();
    ({ workspaceDir } = opts);
    pm = new ProjectManager(opts);
  });

  it('should unbind chatId and return default context', () => {
    pm.create('chat_1', 'research', 'my-research');
    expect(pm.getActive('chat_1').name).toBe('my-research');

    const result = pm.reset('chat_1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('default');
      expect(result.data.workingDir).toBe(workspaceDir);
    }

    expect(pm.getActive('chat_1').name).toBe('default');
  });

  it('should be idempotent for unbound chatId', () => {
    const result = pm.reset('chat_unknown');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('default');
    }
  });

  it('should reject empty chatId', () => {
    const result = pm.reset('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatId');
    }
  });

  it('should not affect other bindings when resetting one chatId', () => {
    pm.create('chat_1', 'research', 'my-research');
    pm.use('chat_2', 'my-research');

    pm.reset('chat_1');

    // chat_2 should still be bound
    expect(pm.getActive('chat_2').name).toBe('my-research');
    // chat_1 should be default
    expect(pm.getActive('chat_1').name).toBe('default');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listTemplates()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager listTemplates()', () => {
  it('should return templates sorted by name', () => {
    const pm = new ProjectManager(createOptions());
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
    expect(templates[0].name).toBe('book-reader');
    expect(templates[1].name).toBe('research');
    expect(templates[1].displayName).toBe('研究模式');
    expect(templates[1].description).toBe('专注研究的独立空间');
  });

  it('should return empty array when no templates configured', () => {
    const pm = new ProjectManager(createOptions({ templatesConfig: EMPTY_CONFIG }));
    expect(pm.listTemplates()).toEqual([]);
  });

  it('should include all metadata from config', () => {
    const pm = new ProjectManager(createOptions({
      templatesConfig: {
        research: { displayName: '研究', description: '研究模式' },
        coding: { displayName: '编码' },
        minimal: {},
      },
    }));

    const templates = pm.listTemplates();
    expect(templates).toHaveLength(3);
    expect(templates.find((t) => t.name === 'minimal')).toEqual({
      name: 'minimal',
      displayName: undefined,
      description: undefined,
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listInstances()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager listInstances()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    const opts = createOptions();
    ({ workspaceDir } = opts);
    pm = new ProjectManager(opts);
  });

  it('should return empty array when no instances exist', () => {
    expect(pm.listInstances()).toEqual([]);
  });

  it('should list created instances with correct binding info', () => {
    pm.create('chat_1', 'research', 'my-research');
    pm.use('chat_2', 'my-research');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0]).toMatchObject({
      name: 'my-research',
      templateName: 'research',
      chatIds: expect.arrayContaining(['chat_1', 'chat_2']),
      workingDir: join(workspaceDir, 'projects/my-research'),
    });
    expect(instances[0].createdAt).toBeTruthy();
  });

  it('should list multiple instances', () => {
    pm.create('chat_1', 'research', 'research-1');
    pm.create('chat_2', 'book-reader', 'book-1');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(2);
    const names = instances.map((i) => i.name);
    expect(names).toContain('research-1');
    expect(names).toContain('book-1');
  });

  it('should show empty chatIds for unbound instance', () => {
    pm.create('chat_1', 'research', 'my-research');
    pm.reset('chat_1');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].chatIds).toEqual([]);
  });

  it('should not include default project', () => {
    // getActive('unbound') returns default, but listInstances should not include it
    pm.getActive('unbound_chat');
    expect(pm.listInstances()).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProvider()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager createCwdProvider()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;
  let cwdProvider: (chatId: string) => string | undefined;

  beforeEach(() => {
    const opts = createOptions();
    ({ workspaceDir } = opts);
    pm = new ProjectManager(opts);
    cwdProvider = pm.createCwdProvider();
  });

  it('should return undefined for default project', () => {
    expect(cwdProvider('unbound_chat')).toBeUndefined();
  });

  it('should return workingDir for bound project', () => {
    pm.create('chat_1', 'research', 'my-research');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/my-research'));
  });

  it('should update dynamically after project switch', () => {
    pm.create('chat_1', 'research', 'research-1');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/research-1'));

    pm.reset('chat_1');
    expect(cwdProvider('chat_1')).toBeUndefined();
  });

  it('should track use() changes', () => {
    pm.create('chat_1', 'research', 'research-1');
    pm.create('chat_1', 'book-reader', 'book-1');

    // After second create, chat_1 is bound to book-1
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/book-1'));

    // Switch back via use()
    pm.use('chat_1', 'research-1');
    expect(cwdProvider('chat_1')).toBe(join(workspaceDir, 'projects/research-1'));
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence (Sub-Issue C)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager persist()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    const opts = createOptions();
    ({ workspaceDir } = opts);
    pm = new ProjectManager(opts);
  });

  it('should create .disclaude directory and projects.json on first persist', () => {
    const result = pm.persist();
    expect(result.ok).toBe(true);

    const persistPath = join(workspaceDir, '.disclaude', 'projects.json');
    expect(existsSync(persistPath)).toBe(true);
  });

  it('should persist instances and bindings as valid JSON', () => {
    pm.create('chat_1', 'research', 'my-research');

    const persistPath = pm.getPersistPath();
    const raw = readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);

    expect(data.instances).toBeDefined();
    expect(data.instances['my-research']).toBeDefined();
    expect(data.instances['my-research'].templateName).toBe('research');
    expect(data.chatProjectMap['chat_1']).toBe('my-research');
  });

  it('should persist empty state correctly', () => {
    const result = pm.persist();
    expect(result.ok).toBe(true);

    const persistPath = pm.getPersistPath();
    const raw = readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);

    expect(data.instances).toEqual({});
    expect(data.chatProjectMap).toEqual({});
  });

  it('should auto-persist on create()', () => {
    pm.create('chat_1', 'research', 'my-research');

    // Verify file exists without explicit persist() call
    const persistPath = pm.getPersistPath();
    const raw = readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.instances['my-research']).toBeDefined();
  });

  it('should auto-persist on use()', () => {
    pm.create('chat_1', 'research', 'my-research');
    pm.use('chat_2', 'my-research');

    const persistPath = pm.getPersistPath();
    const raw = readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.chatProjectMap['chat_2']).toBe('my-research');
  });

  it('should auto-persist on reset()', () => {
    pm.create('chat_1', 'research', 'my-research');
    pm.reset('chat_1');

    const persistPath = pm.getPersistPath();
    const raw = readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.chatProjectMap['chat_1']).toBeUndefined();
  });

  it('should not leave .tmp files after successful persist', () => {
    pm.persist();

    const tmpPath = join(workspaceDir, '.disclaude', 'projects.json.tmp');
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe('ProjectManager loadPersistedData()', () => {
  it('should restore instances from persisted state', () => {
    const opts = createOptions();
    const {workspaceDir} = opts;

    // Create PM1, add data
    const pm1 = new ProjectManager(opts);
    pm1.create('chat_1', 'research', 'my-research');
    pm1.use('chat_2', 'my-research');

    // Create PM2 from same workspace — should load persisted state
    const pm2 = new ProjectManager({
      ...opts,
      workspaceDir,
    });

    // Instances should be restored
    const instances = pm2.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe('my-research');
    expect(instances[0].templateName).toBe('research');

    // Bindings should be restored
    expect(pm2.getActive('chat_1').name).toBe('my-research');
    expect(pm2.getActive('chat_2').name).toBe('my-research');
  });

  it('should handle first run (no projects.json) gracefully', () => {
    const pm = new ProjectManager(createOptions());
    expect(pm.listInstances()).toEqual([]);
  });

  it('should handle corrupted JSON gracefully', () => {
    const opts = createOptions();
    const {workspaceDir} = opts;

    // Write corrupted data
    const dataDir = join(workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'projects.json'), '{ invalid json }', 'utf8');

    // Should not crash
    const pm = new ProjectManager(opts);
    expect(pm.listInstances()).toEqual([]);
  });

  it('should skip invalid instance entries', () => {
    const opts = createOptions();
    const {workspaceDir} = opts;

    // Write data with one valid and one invalid instance
    const dataDir = join(workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
      instances: {
        valid: {
          name: 'valid',
          templateName: 'research',
          workingDir: '/workspace/projects/valid',
          createdAt: '2026-04-16T00:00:00.000Z',
        },
        invalid: {
          name: 'invalid',
          // Missing required fields
          workingDir: 123, // Not a string
          createdAt: '',
        },
      },
      chatProjectMap: {
        chat_1: 'valid',
        chat_2: 'invalid', // Points to invalid instance
        chat_3: 'nonexistent', // Points to missing instance
      },
    }), 'utf8');

    const pm = new ProjectManager(opts);
    const instances = pm.listInstances();

    // Only the valid instance should be loaded
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe('valid');

    // Only valid bindings should be restored
    expect(pm.getActive('chat_1').name).toBe('valid');
    expect(pm.getActive('chat_2').name).toBe('default'); // Invalid → not loaded
    expect(pm.getActive('chat_3').name).toBe('default'); // Nonexistent → not loaded
  });

  it('should handle invalid top-level schema', () => {
    const opts = createOptions();
    const {workspaceDir} = opts;

    const dataDir = join(workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });

    // Array instead of object
    writeFileSync(join(dataDir, 'projects.json'), '[]', 'utf8');

    const pm = new ProjectManager(opts);
    expect(pm.listInstances()).toEqual([]);
  });

  it('should handle null top-level value', () => {
    const opts = createOptions();
    const {workspaceDir} = opts;

    const dataDir = join(workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'projects.json'), 'null', 'utf8');

    const pm = new ProjectManager(opts);
    expect(pm.listInstances()).toEqual([]);
  });

  it('should handle missing instances field', () => {
    const opts = createOptions();
    const {workspaceDir} = opts;

    const dataDir = join(workspaceDir, '.disclaude');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({
      chatProjectMap: {},
    }), 'utf8');

    const pm = new ProjectManager(opts);
    expect(pm.listInstances()).toEqual([]);
  });
});

describe('ProjectManager persistence round-trip', () => {
  it('should survive full lifecycle: create → persist → reload → mutate → persist → reload', () => {
    const opts = createOptions();
    const {workspaceDir} = opts;

    // Phase 1: Create and persist
    const pm1 = new ProjectManager(opts);
    pm1.create('chat_1', 'research', 'my-research');
    pm1.use('chat_2', 'my-research');

    // Phase 2: Reload and verify
    const pm2 = new ProjectManager({ ...opts, workspaceDir });
    expect(pm2.listInstances()).toHaveLength(1);
    expect(pm2.getActive('chat_1').name).toBe('my-research');
    expect(pm2.getActive('chat_2').name).toBe('my-research');

    // Phase 3: Mutate
    pm2.create('chat_3', 'book-reader', 'book-1');
    pm2.reset('chat_1');

    // Phase 4: Reload and verify mutations
    const pm3 = new ProjectManager({ ...opts, workspaceDir });
    expect(pm3.listInstances()).toHaveLength(2);
    expect(pm3.getActive('chat_1').name).toBe('default'); // Was reset
    expect(pm3.getActive('chat_2').name).toBe('my-research');
    expect(pm3.getActive('chat_3').name).toBe('book-1');
  });

  it('should rebuild reverse index (chatIds in listInstances) after reload', () => {
    const opts = createOptions();
    const {workspaceDir} = opts;

    // Create instance with multiple bindings
    const pm1 = new ProjectManager(opts);
    pm1.create('chat_1', 'research', 'my-research');
    pm1.use('chat_2', 'my-research');
    pm1.use('chat_3', 'my-research');

    // Reload — reverse index should be rebuilt from persisted data
    const pm2 = new ProjectManager({ ...opts, workspaceDir });
    const instances = pm2.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].chatIds).toHaveLength(3);
    expect(instances[0].chatIds).toEqual(expect.arrayContaining(['chat_1', 'chat_2', 'chat_3']));
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Edge Cases & Integration Scenarios
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — edge cases', () => {
  it('should handle multiple chatIds sharing one instance', () => {
    const pm = new ProjectManager(createOptions());
    pm.create('chat_1', 'research', 'shared-project');

    for (const id of ['chat_2', 'chat_3', 'chat_4']) {
      const result = pm.use(id, 'shared-project');
      expect(result.ok).toBe(true);
    }

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].chatIds).toHaveLength(4);
  });

  it('should handle chatId switching between instances', () => {
    const pm = new ProjectManager(createOptions());
    pm.create('chat_1', 'research', 'research-1');
    pm.create('chat_2', 'book-reader', 'book-1');

    // Switch chat_1 to book-1
    pm.use('chat_1', 'book-1');
    expect(pm.getActive('chat_1').name).toBe('book-1');

    // Switch back to research-1
    pm.use('chat_1', 'research-1');
    expect(pm.getActive('chat_1').name).toBe('research-1');
  });

  it('should compute workingDir correctly with trailing slash in workspaceDir', () => {
    const tempDir = createTempDir();
    const opts = createOptions({
      workspaceDir: `${tempDir  }/`,
    });
    const pm = new ProjectManager(opts);
    const result = pm.create('chat_1', 'research', 'test-project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.workingDir).toBe(`${tempDir}/projects/test-project`);
    }
  });

  it('should compute workingDir correctly with multiple trailing slashes', () => {
    const tempDir = createTempDir();
    const opts = createOptions({
      workspaceDir: `${tempDir  }///`,
    });
    const pm = new ProjectManager(opts);
    const result = pm.create('chat_1', 'research', 'test-project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.workingDir).toBe(`${tempDir}/projects/test-project`);
    }
  });

  it('should generate valid ISO 8601 createdAt timestamps', () => {
    const pm = new ProjectManager(createOptions());
    const before = new Date().toISOString();
    pm.create('chat_1', 'research', 'test-project');
    const after = new Date().toISOString();

    const instances = pm.listInstances();
    expect(instances[0].createdAt >= before).toBe(true);
    expect(instances[0].createdAt <= after).toBe(true);

    // Should be parseable as a valid date
    expect(new Date(instances[0].createdAt).toISOString()).toBe(instances[0].createdAt);
  });

  it('should handle template with no metadata', () => {
    const opts = createOptions({
      templatesConfig: {
        minimal: {},
      },
    });
    // Also create the minimal template's CLAUDE.md on disk
    mkdirSync(join(opts.packageDir, 'templates/minimal'), { recursive: true });
    writeFileSync(join(opts.packageDir, 'templates/minimal/CLAUDE.md'), '# Minimal Template', 'utf8');

    const pm = new ProjectManager(opts);

    const templates = pm.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0]).toEqual({ name: 'minimal' });

    const result = pm.create('chat_1', 'minimal', 'my-minimal');
    expect(result.ok).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// File System Operations (Sub-Issue D — #2226)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager create() — file system operations', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    const opts = createOptions();
    ({ workspaceDir } = opts);
    pm = new ProjectManager(opts);
  });

  it('should create working directory on instance creation', () => {
    const result = pm.create('chat_1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    const projectDir = join(workspaceDir, 'projects/my-research');
    expect(existsSync(projectDir)).toBe(true);
  });

  it('should copy CLAUDE.md from template to working directory', () => {
    pm.create('chat_1', 'research', 'my-research');

    const claudeMdPath = join(workspaceDir, 'projects/my-research/CLAUDE.md');
    expect(existsSync(claudeMdPath)).toBe(true);

    const content = readFileSync(claudeMdPath, 'utf8');
    expect(content).toBe('# Research Template');
  });

  it('should create projects directory if it does not exist', () => {
    const projectsDir = join(workspaceDir, 'projects');
    expect(existsSync(projectsDir)).toBe(false);

    pm.create('chat_1', 'research', 'my-research');

    expect(existsSync(projectsDir)).toBe(true);
  });

  it('should fail and not create instance when CLAUDE.md template is missing', () => {
    // Create options with a template configured but no corresponding CLAUDE.md file
    const ws = createTempDir();
    const pd = join(ws, 'pkg');
    mkdirSync(join(pd, 'templates/research'), { recursive: true });
    // Deliberately NOT creating CLAUDE.md in research template

    const localPm = new ProjectManager({
      workspaceDir: ws,
      packageDir: pd,
      templatesConfig: {
        research: { displayName: '研究' },
      },
    });

    const result = localPm.create('chat_1', 'research', 'test-instance');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CLAUDE.md');
    }

    // Instance should NOT be in memory
    expect(localPm.listInstances()).toHaveLength(0);

    // Directory should NOT exist (rollback)
    expect(existsSync(join(ws, 'projects/test-instance'))).toBe(false);
  });

  it('should succeed without CLAUDE.md when packageDir is empty', () => {
    const ws = createTempDir();
    const localPm = new ProjectManager({
      workspaceDir: ws,
      packageDir: '',
      templatesConfig: {
        research: { displayName: '研究' },
      },
    });

    const result = localPm.create('chat_1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    // Directory should be created but no CLAUDE.md
    const projectDir = join(ws, 'projects/my-research');
    expect(existsSync(projectDir)).toBe(true);
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false);
  });
});

describe('ProjectManager instantiateFromTemplate()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    const opts = createOptions();
    ({ workspaceDir } = opts);
    pm = new ProjectManager(opts);
  });

  it('should create working directory with correct path', () => {
    const workingDir = join(workspaceDir, 'projects/test-project');
    const result = pm.instantiateFromTemplate('test-project', 'research', workingDir);
    expect(result.ok).toBe(true);
    expect(existsSync(workingDir)).toBe(true);
  });

  it('should copy CLAUDE.md from correct template', () => {
    const workingDir = join(workspaceDir, 'projects/book-project');
    pm.instantiateFromTemplate('book-project', 'book-reader', workingDir);

    const claudeMd = readFileSync(join(workingDir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toBe('# Book Reader Template');
  });

  it('should reject path outside of projects directory', () => {
    const maliciousDir = join(workspaceDir, 'evil-dir');
    const result = pm.instantiateFromTemplate('test', 'research', maliciousDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('路径遍历');
    }
    expect(existsSync(maliciousDir)).toBe(false);
  });

  it('should reject path traversal using .. in resolved path', () => {
    const maliciousDir = join(workspaceDir, 'projects/../../../etc/evil');
    const result = pm.instantiateFromTemplate('test', 'research', maliciousDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('路径遍历');
    }
  });

  it('should rollback directory when CLAUDE.md copy fails', () => {
    // Create a ProjectManager with a template that has no CLAUDE.md
    const ws = createTempDir();
    const pd = join(ws, 'pkg');
    mkdirSync(join(pd, 'templates/broken'), { recursive: true });
    // No CLAUDE.md in broken template

    const localPm = new ProjectManager({
      workspaceDir: ws,
      packageDir: pd,
      templatesConfig: {
        broken: { displayName: '坏模板' },
      },
    });

    const workingDir = join(ws, 'projects/test-instance');
    const result = localPm.instantiateFromTemplate('test-instance', 'broken', workingDir);
    expect(result.ok).toBe(false);

    // Directory should be rolled back
    expect(existsSync(workingDir)).toBe(false);
  });
});

describe('ProjectManager copyClaudeMd()', () => {
  it('should copy CLAUDE.md from template to target directory', () => {
    const opts = createOptions();
    const pm = new ProjectManager(opts);

    const targetDir = join(opts.workspaceDir, 'projects/test-copy');
    mkdirSync(targetDir, { recursive: true });

    const result = pm.copyClaudeMd('research', targetDir);
    expect(result.ok).toBe(true);
    expect(existsSync(join(targetDir, 'CLAUDE.md'))).toBe(true);
  });

  it('should skip when packageDir is empty string', () => {
    const ws = createTempDir();
    const pm = new ProjectManager({
      workspaceDir: ws,
      packageDir: '',
      templatesConfig: { research: {} },
    });

    const targetDir = join(ws, 'projects/test-skip');
    mkdirSync(targetDir, { recursive: true });

    const result = pm.copyClaudeMd('research', targetDir);
    expect(result.ok).toBe(true);

    // No CLAUDE.md should be copied
    expect(existsSync(join(targetDir, 'CLAUDE.md'))).toBe(false);
  });

  it('should return error when template CLAUDE.md does not exist', () => {
    // Create a template config entry without the actual CLAUDE.md file
    const ws = createTempDir();
    const pd = join(ws, 'pkg');
    mkdirSync(join(pd, 'templates'), { recursive: true });
    const localPm = new ProjectManager({
      workspaceDir: ws,
      packageDir: pd,
      templatesConfig: {
        ghost: { displayName: '幽灵模板' },
      },
    });

    mkdirSync(join(ws, 'projects/test'), { recursive: true });
    const result = localPm.copyClaudeMd('ghost', join(ws, 'projects/test'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CLAUDE.md');
    }
  });
});

describe('ProjectManager — full file system lifecycle', () => {
  it('should create directory + CLAUDE.md, persist, and reload correctly', () => {
    const opts = createOptions();
    const { workspaceDir } = opts;

    // Create instance
    const pm1 = new ProjectManager(opts);
    const result = pm1.create('chat_1', 'research', 'lifecycle-test');
    expect(result.ok).toBe(true);

    // Verify filesystem state
    const projectDir = join(workspaceDir, 'projects/lifecycle-test');
    expect(existsSync(projectDir)).toBe(true);
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(true);

    // Reload from persisted state
    const pm2 = new ProjectManager({ ...opts, workspaceDir });
    expect(pm2.listInstances()).toHaveLength(1);
    expect(pm2.getActive('chat_1').name).toBe('lifecycle-test');
    expect(pm2.getActive('chat_1').workingDir).toBe(projectDir);

    // File system should still exist after reload
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(true);
  });

  it('should create multiple instances with separate directories', () => {
    const opts = createOptions();
    const { workspaceDir } = opts;
    const pm = new ProjectManager(opts);

    pm.create('chat_1', 'research', 'project-a');
    pm.create('chat_2', 'book-reader', 'project-b');

    expect(existsSync(join(workspaceDir, 'projects/project-a/CLAUDE.md'))).toBe(true);
    expect(existsSync(join(workspaceDir, 'projects/project-b/CLAUDE.md'))).toBe(true);

    const contentA = readFileSync(join(workspaceDir, 'projects/project-a/CLAUDE.md'), 'utf8');
    const contentB = readFileSync(join(workspaceDir, 'projects/project-b/CLAUDE.md'), 'utf8');
    expect(contentA).toBe('# Research Template');
    expect(contentB).toBe('# Book Reader Template');
  });
});
