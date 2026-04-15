/**
 * Tests for ProjectManager core logic with persistence.
 *
 * Covers:
 * - Template initialization
 * - Instance creation with validation
 * - chatId binding (use/reset)
 * - Stale binding self-healing
 * - Path traversal protection
 * - CwdProvider closure
 * - State serialization/deserialization
 * - Persistence (persist, loadPersistedData)
 * - Deletion
 * - Rollback on persist failure
 *
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #2225 (Sub-Issue C — Persistence)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect, beforeEach } from 'vitest';
import { ProjectManager } from './project-manager.js';
import type { ProjectTemplatesConfig } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const PACKAGE_DIR = '/test/packages/core';

const TEMPLATES_CONFIG: ProjectTemplatesConfig = {
  research: {
    displayName: '研究模式',
    description: '专注研究的独立空间',
  },
  'book-reader': {
    displayName: '读书助手',
  },
};

/** Track temp directories for cleanup */
const tempDirs: string[] = [];

/**
 * Create a ProjectManager with a real temp directory as workspace.
 * The directory is cleaned up after each test.
 */
function createManager(
  config: ProjectTemplatesConfig = TEMPLATES_CONFIG,
): ProjectManager {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  tempDirs.push(workspaceDir);

  const pm = new ProjectManager({
    workspaceDir,
    packageDir: PACKAGE_DIR,
    templatesConfig: config,
  });
  pm.init();
  return pm;
}

/** Get the workspace directory of a manager (for assertions) */
function getWorkspaceDir(pm: ProjectManager): string {
  return path.dirname(path.dirname(pm.getPersistPath()));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Cleanup
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors in tests
    }
  }
  tempDirs.length = 0;
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Initialization
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager.init()', () => {
  it('should load templates from constructor config', () => {
    const pm = createManager();
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.find((t) => t.name === 'research')).toBeDefined();
    expect(templates.find((t) => t.name === 'book-reader')).toBeDefined();
  });

  it('should load templates from override config', () => {
    const pm = createManager();
    const overrideConfig: ProjectTemplatesConfig = {
      custom: { displayName: '自定义' },
    };
    pm.init(overrideConfig);
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('custom');
  });

  it('should handle empty templates config', () => {
    const pm = createManager({});
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(0);
  });

  it('should clear previous templates on re-init', () => {
    const pm = createManager();
    expect(pm.listTemplates()).toHaveLength(2);
    pm.init({});
    expect(pm.listTemplates()).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// create()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager.create()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    pm = createManager();
    workspaceDir = getWorkspaceDir(pm);
  });

  it('should create instance from template', () => {
    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('my-research');
      expect(result.data.templateName).toBe('research');
      expect(result.data.workingDir).toBe(path.join(workspaceDir, 'projects', 'my-research'));
    }
  });

  it('should auto-bind chatId to created instance', () => {
    pm.create('oc_chat1', 'research', 'my-research');
    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('my-research');
    expect(active.templateName).toBe('research');
  });

  it('should reject non-existent template', () => {
    const result = pm.create('oc_chat1', 'nonexistent', 'test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('nonexistent');
      expect(result.error).toContain('不存在');
    }
  });

  it('should reject duplicate instance name', () => {
    pm.create('oc_chat1', 'research', 'my-research');
    const result = pm.create('oc_chat2', 'research', 'my-research');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('已存在');
      expect(result.error).toContain('/project use');
    }
  });

  it('should reject reserved name "default"', () => {
    const result = pm.create('oc_chat1', 'research', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名');
    }
  });

  it('should create instance from different templates with different names', () => {
    const r1 = pm.create('oc_chat1', 'research', 'project-a');
    const r2 = pm.create('oc_chat2', 'book-reader', 'project-b');
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const active1 = pm.getActive('oc_chat1');
    const active2 = pm.getActive('oc_chat2');
    expect(active1.name).toBe('project-a');
    expect(active2.name).toBe('project-b');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Input Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager name validation', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    pm = createManager();
  });

  it('should reject empty name', () => {
    const result = pm.create('oc_chat1', 'research', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject whitespace-only name', () => {
    const result = pm.create('oc_chat1', 'research', '   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject name with path traversal ".."', () => {
    const result = pm.create('oc_chat1', 'research', '..');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('路径遍历');
    }
  });

  it('should reject name containing ".." segment', () => {
    const result = pm.create('oc_chat1', 'research', 'foo..bar');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('路径遍历');
    }
  });

  it('should reject name with forward slash', () => {
    const result = pm.create('oc_chat1', 'research', 'foo/bar');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('/');
    }
  });

  it('should reject name with backslash', () => {
    const result = pm.create('oc_chat1', 'research', 'foo\\bar');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('\\');
    }
  });

  it('should reject name with null byte', () => {
    const result = pm.create('oc_chat1', 'research', 'foo\x00bar');
    expect(result.ok).toBe(false);
  });

  it('should reject name exceeding 64 characters', () => {
    const longName = 'a'.repeat(65);
    const result = pm.create('oc_chat1', 'research', longName);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('64');
    }
  });

  it('should accept name at exactly 64 characters', () => {
    const name = 'a'.repeat(64);
    const result = pm.create('oc_chat1', 'research', name);
    expect(result.ok).toBe(true);
  });

  it('should reject name with leading/trailing whitespace', () => {
    const result = pm.create('oc_chat1', 'research', ' my-project ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('空格');
    }
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

describe('ProjectManager.use()', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    pm = createManager();
    pm.create('oc_chat1', 'research', 'my-research');
  });

  it('should bind another chatId to existing instance', () => {
    const result = pm.use('oc_chat2', 'my-research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('my-research');
    }

    // Both chatIds should resolve to the same instance
    expect(pm.getActive('oc_chat1').name).toBe('my-research');
    expect(pm.getActive('oc_chat2').name).toBe('my-research');
  });

  it('should reject binding to non-existent instance', () => {
    const result = pm.use('oc_chat2', 'nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should reject binding to "default"', () => {
    const result = pm.use('oc_chat2', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名');
      expect(result.error).toContain('reset');
    }
  });

  it('should rebind chatId to different instance', () => {
    pm.create('oc_chat1', 'book-reader', 'my-book');
    const result = pm.use('oc_chat1', 'my-book');
    expect(result.ok).toBe(true);

    expect(pm.getActive('oc_chat1').name).toBe('my-book');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// reset()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager.reset()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    pm = createManager();
    workspaceDir = getWorkspaceDir(pm);
  });

  it('should reset bound chatId to default', () => {
    pm.create('oc_chat1', 'research', 'my-research');
    expect(pm.getActive('oc_chat1').name).toBe('my-research');

    const result = pm.reset('oc_chat1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('default');
      expect(result.data.workingDir).toBe(workspaceDir);
    }

    expect(pm.getActive('oc_chat1').name).toBe('default');
  });

  it('should be no-op for unbound chatId', () => {
    const result = pm.reset('oc_unbound');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('default');
    }
  });

  it('should not affect other chatId bindings', () => {
    pm.create('oc_chat1', 'research', 'my-research');
    pm.use('oc_chat2', 'my-research');

    pm.reset('oc_chat1');
    expect(pm.getActive('oc_chat1').name).toBe('default');
    expect(pm.getActive('oc_chat2').name).toBe('my-research');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getActive() and Stale Binding Self-Healing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager.getActive()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    pm = createManager();
    workspaceDir = getWorkspaceDir(pm);
  });

  it('should return default for unbound chatId', () => {
    const active = pm.getActive('oc_unknown');
    expect(active.name).toBe('default');
    expect(active.templateName).toBeUndefined();
    expect(active.workingDir).toBe(workspaceDir);
  });

  it('should return bound instance for bound chatId', () => {
    pm.create('oc_chat1', 'research', 'my-research');
    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('my-research');
    expect(active.templateName).toBe('research');
  });

  it('should self-heal stale binding (instance removed)', () => {
    pm.create('oc_chat1', 'research', 'my-research');
    // Simulate instance being removed (e.g., by persistence layer)
    const state = pm.getState();
    state.instances.delete('my-research');

    // getActive should detect stale binding and return default
    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('default');

    // Binding should be cleaned up
    expect(state.chatProjectMap.has('oc_chat1')).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listTemplates()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager.listTemplates()', () => {
  it('should list all templates from config', () => {
    const pm = createManager();
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);

    const research = templates.find((t) => t.name === 'research');
    expect(research).toBeDefined();
    expect(research!.displayName).toBe('研究模式');
    expect(research!.description).toBe('专注研究的独立空间');

    const bookReader = templates.find((t) => t.name === 'book-reader');
    expect(bookReader).toBeDefined();
    expect(bookReader!.displayName).toBe('读书助手');
  });

  it('should return empty array for empty config', () => {
    const pm = createManager({});
    expect(pm.listTemplates()).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listInstances()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager.listInstances()', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    pm = createManager();
    workspaceDir = getWorkspaceDir(pm);
  });

  it('should return empty array when no instances exist', () => {
    expect(pm.listInstances()).toHaveLength(0);
  });

  it('should list created instances with bindings', () => {
    pm.create('oc_chat1', 'research', 'my-research');
    pm.use('oc_chat2', 'my-research');
    pm.create('oc_chat3', 'book-reader', 'my-book');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(2);

    const research = instances.find((i) => i.name === 'my-research');
    expect(research).toBeDefined();
    expect(research!.templateName).toBe('research');
    expect(research!.chatIds).toHaveLength(2);
    expect(research!.chatIds).toContain('oc_chat1');
    expect(research!.chatIds).toContain('oc_chat2');
    expect(research!.workingDir).toBe(path.join(workspaceDir, 'projects', 'my-research'));
    expect(research!.createdAt).toBeTruthy();

    const book = instances.find((i) => i.name === 'my-book');
    expect(book).toBeDefined();
    expect(book!.chatIds).toHaveLength(1);
    expect(book!.chatIds).toContain('oc_chat3');
  });

  it('should not include default in instance list', () => {
    // default is implicit, never appears in listInstances()
    expect(pm.listInstances()).toHaveLength(0);
  });

  it('should reflect unbound state after reset', () => {
    pm.create('oc_chat1', 'research', 'my-research');
    pm.reset('oc_chat1');

    const instances = pm.listInstances();
    const research = instances.find((i) => i.name === 'my-research');
    expect(research).toBeDefined();
    expect(research!.chatIds).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProvider()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager.createCwdProvider()', () => {
  it('should return undefined for default project', () => {
    const pm = createManager();
    const provider = pm.createCwdProvider();
    expect(provider('oc_chat1')).toBeUndefined();
  });

  it('should return workingDir for bound project', () => {
    const pm = createManager();
    pm.create('oc_chat1', 'research', 'my-research');
    const provider = pm.createCwdProvider();
    expect(provider('oc_chat1')).toBe(path.join(getWorkspaceDir(pm), 'projects', 'my-research'));
  });

  it('should reflect binding changes dynamically', () => {
    const pm = createManager();
    pm.create('oc_chat1', 'research', 'my-research');
    const provider = pm.createCwdProvider();

    expect(provider('oc_chat1')).toBe(path.join(getWorkspaceDir(pm), 'projects', 'my-research'));

    pm.reset('oc_chat1');
    expect(provider('oc_chat1')).toBeUndefined();
  });

  it('should be a closure bound to the ProjectManager', () => {
    const pm = createManager();
    const provider = pm.createCwdProvider();

    // Provider should work independently after creation
    pm.create('oc_chat1', 'research', 'test-project');
    expect(provider('oc_chat1')).toBe(path.join(getWorkspaceDir(pm), 'projects', 'test-project'));
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// State Serialization
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager state serialization', () => {
  it('should serialize and restore state', () => {
    const pm1 = createManager();
    pm1.create('oc_chat1', 'research', 'project-a');
    pm1.use('oc_chat2', 'project-a');

    const state = pm1.getState();

    // Serialize to arrays
    const serialized = {
      instances: Array.from(state.instances.entries()),
      chatProjectMap: Array.from(state.chatProjectMap.entries()),
      createdAtMap: Array.from(state.createdAtMap.entries()),
    };

    // Restore into new manager
    const pm2 = createManager();
    pm2.loadState(serialized);

    expect(pm2.getActive('oc_chat1').name).toBe('project-a');
    expect(pm2.getActive('oc_chat2').name).toBe('project-a');
    expect(pm2.listInstances()).toHaveLength(1);
    expect(pm2.listInstances()[0].chatIds).toHaveLength(2);
  });

  it('should overwrite state on loadState', () => {
    const pm = createManager();
    pm.create('oc_chat1', 'research', 'project-a');

    pm.loadState({
      instances: [],
      chatProjectMap: [],
      createdAtMap: [],
    });

    expect(pm.listInstances()).toHaveLength(0);
    expect(pm.getActive('oc_chat1').name).toBe('default');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence: persist()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager.persist()', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    pm = createManager();
  });

  it('should create .disclaude directory if not exists', () => {
    const persistPath = pm.getPersistPath();
    const persistDir = path.dirname(persistPath);

    expect(fs.existsSync(persistDir)).toBe(false);

    const result = pm.persist();
    expect(result.ok).toBe(true);

    expect(fs.existsSync(persistDir)).toBe(true);
    expect(fs.existsSync(persistPath)).toBe(true);
  });

  it('should write valid JSON to projects.json', () => {
    pm.create('oc_chat1', 'research', 'my-research');

    const persistPath = pm.getPersistPath();
    const raw = fs.readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);

    expect(data.instances).toBeDefined();
    expect(data.chatProjectMap).toBeDefined();
    expect(data.instances['my-research']).toBeDefined();
    expect(data.instances['my-research'].name).toBe('my-research');
    expect(data.instances['my-research'].templateName).toBe('research');
    expect(data.instances['my-research'].workingDir).toBeTruthy();
    expect(data.instances['my-research'].createdAt).toBeTruthy();
    expect(data.chatProjectMap['oc_chat1']).toBe('my-research');
  });

  it('should serialize all instances and bindings', () => {
    pm.create('oc_chat1', 'research', 'project-a');
    pm.use('oc_chat2', 'project-a');
    pm.create('oc_chat3', 'book-reader', 'project-b');

    const persistPath = pm.getPersistPath();
    const raw = fs.readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);

    expect(Object.keys(data.instances)).toHaveLength(2);
    expect(data.instances['project-a']).toBeDefined();
    expect(data.instances['project-b']).toBeDefined();
    expect(data.chatProjectMap['oc_chat1']).toBe('project-a');
    expect(data.chatProjectMap['oc_chat2']).toBe('project-a');
    expect(data.chatProjectMap['oc_chat3']).toBe('project-b');
  });

  it('should persist empty state correctly', () => {
    const result = pm.persist();
    expect(result.ok).toBe(true);

    const persistPath = pm.getPersistPath();
    const raw = fs.readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);

    expect(data.instances).toEqual({});
    expect(data.chatProjectMap).toEqual({});
  });

  it('should use atomic write (no .tmp file left after success)', () => {
    pm.persist();

    const persistPath = pm.getPersistPath();
    const tmpPath = `${persistPath}.tmp`;

    expect(fs.existsSync(persistPath)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence: loadPersistedData()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager.loadPersistedData()', () => {
  it('should return success when no persistence file exists', () => {
    const pm = createManager();
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(true);
    expect(pm.listInstances()).toHaveLength(0);
  });

  it('should restore instances and bindings from disk', () => {
    // Setup: create and persist data
    const pm1 = createManager();
    pm1.create('oc_chat1', 'research', 'my-research');
    pm1.use('oc_chat2', 'my-research');

    // Load into a fresh manager (same workspace)
    const workspaceDir = getWorkspaceDir(pm1);
    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir: PACKAGE_DIR,
      templatesConfig: TEMPLATES_CONFIG,
    });
    pm2.init();
    const result = pm2.loadPersistedData();

    expect(result.ok).toBe(true);
    expect(pm2.getActive('oc_chat1').name).toBe('my-research');
    expect(pm2.getActive('oc_chat2').name).toBe('my-research');
    expect(pm2.listInstances()).toHaveLength(1);
    expect(pm2.listInstances()[0].chatIds).toHaveLength(2);
  });

  it('should restore timestamps correctly', () => {
    const pm1 = createManager();
    pm1.create('oc_chat1', 'research', 'my-research');
    const originalCreatedAt = pm1.listInstances()[0].createdAt;

    // Load into a fresh manager
    const workspaceDir = getWorkspaceDir(pm1);
    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir: PACKAGE_DIR,
      templatesConfig: TEMPLATES_CONFIG,
    });
    pm2.init();
    pm2.loadPersistedData();

    expect(pm2.listInstances()[0].createdAt).toBe(originalCreatedAt);
  });

  it('should return error for corrupted JSON', () => {
    const pm = createManager();
    const persistDir = path.dirname(pm.getPersistPath());
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(pm.getPersistPath(), '{ invalid json', 'utf8');

    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('读取持久化数据失败');
    }
  });

  it('should return error for invalid schema (missing instances)', () => {
    const pm = createManager();
    const persistDir = path.dirname(pm.getPersistPath());
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(
      pm.getPersistPath(),
      JSON.stringify({ chatProjectMap: {} }),
      'utf8',
    );

    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('instances');
    }
  });

  it('should return error for invalid schema (missing chatProjectMap)', () => {
    const pm = createManager();
    const persistDir = path.dirname(pm.getPersistPath());
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(
      pm.getPersistPath(),
      JSON.stringify({ instances: {} }),
      'utf8',
    );

    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatProjectMap');
    }
  });

  it('should return error for instance with missing workingDir', () => {
    const pm = createManager();
    const persistDir = path.dirname(pm.getPersistPath());
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(
      pm.getPersistPath(),
      JSON.stringify({
        instances: {
          'test-inst': {
            name: 'test-inst',
            templateName: 'research',
            createdAt: '2026-01-01T00:00:00.000Z',
            // workingDir missing
          },
        },
        chatProjectMap: {},
      }),
      'utf8',
    );

    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('workingDir');
    }
  });

  it('should return error for instance with missing createdAt', () => {
    const pm = createManager();
    const persistDir = path.dirname(pm.getPersistPath());
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(
      pm.getPersistPath(),
      JSON.stringify({
        instances: {
          'test-inst': {
            name: 'test-inst',
            templateName: 'research',
            workingDir: '/some/path',
            // createdAt missing
          },
        },
        chatProjectMap: {},
      }),
      'utf8',
    );

    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('createdAt');
    }
  });

  it('should return error for top-level array', () => {
    const pm = createManager();
    const persistDir = path.dirname(pm.getPersistPath());
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(pm.getPersistPath(), '[]', 'utf8');

    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('期望一个对象');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence: Round-trip
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager persistence round-trip', () => {
  it('should survive create → persist → load cycle', () => {
    const pm1 = createManager();
    pm1.create('oc_chat1', 'research', 'my-research');

    const workspaceDir = getWorkspaceDir(pm1);

    // Load into fresh manager
    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir: PACKAGE_DIR,
      templatesConfig: TEMPLATES_CONFIG,
    });
    pm2.init();
    pm2.loadPersistedData();

    expect(pm2.listInstances()).toHaveLength(1);
    expect(pm2.getActive('oc_chat1').name).toBe('my-research');
  });

  it('should survive create → use → persist → load cycle', () => {
    const pm1 = createManager();
    pm1.create('oc_chat1', 'research', 'project-a');
    pm1.use('oc_chat2', 'project-a');
    pm1.create('oc_chat3', 'book-reader', 'project-b');

    const workspaceDir = getWorkspaceDir(pm1);

    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir: PACKAGE_DIR,
      templatesConfig: TEMPLATES_CONFIG,
    });
    pm2.init();
    pm2.loadPersistedData();

    expect(pm2.listInstances()).toHaveLength(2);
    expect(pm2.getActive('oc_chat1').name).toBe('project-a');
    expect(pm2.getActive('oc_chat2').name).toBe('project-a');
    expect(pm2.getActive('oc_chat3').name).toBe('project-b');
  });

  it('should survive reset → persist → load cycle', () => {
    const pm1 = createManager();
    pm1.create('oc_chat1', 'research', 'project-a');
    pm1.reset('oc_chat1');

    const workspaceDir = getWorkspaceDir(pm1);

    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir: PACKAGE_DIR,
      templatesConfig: TEMPLATES_CONFIG,
    });
    pm2.init();
    pm2.loadPersistedData();

    // Instance should still exist (reset only removes binding)
    expect(pm2.listInstances()).toHaveLength(1);
    // But chat1 should be on default
    expect(pm2.getActive('oc_chat1').name).toBe('default');
  });

  it('should survive delete → persist → load cycle', () => {
    const pm1 = createManager();
    pm1.create('oc_chat1', 'research', 'project-a');
    pm1.create('oc_chat2', 'book-reader', 'project-b');
    pm1.delete('project-a');

    const workspaceDir = getWorkspaceDir(pm1);

    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir: PACKAGE_DIR,
      templatesConfig: TEMPLATES_CONFIG,
    });
    pm2.init();
    pm2.loadPersistedData();

    expect(pm2.listInstances()).toHaveLength(1);
    expect(pm2.listInstances()[0].name).toBe('project-b');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// delete()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager.delete()', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    pm = createManager();
  });

  it('should delete instance and clean up bindings', () => {
    pm.create('oc_chat1', 'research', 'my-research');
    pm.use('oc_chat2', 'my-research');

    const result = pm.delete('my-research');
    expect(result.ok).toBe(true);

    expect(pm.listInstances()).toHaveLength(0);
    expect(pm.getActive('oc_chat1').name).toBe('default');
    expect(pm.getActive('oc_chat2').name).toBe('default');
  });

  it('should delete a single instance without affecting others', () => {
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat2', 'book-reader', 'project-b');

    pm.delete('project-a');

    expect(pm.listInstances()).toHaveLength(1);
    expect(pm.getActive('oc_chat1').name).toBe('default');
    expect(pm.getActive('oc_chat2').name).toBe('project-b');
  });

  it('should reject deleting non-existent instance', () => {
    const result = pm.delete('nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should reject deleting "default"', () => {
    const result = pm.delete('default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名');
    }
  });

  it('should persist state after deletion', () => {
    pm.create('oc_chat1', 'research', 'project-a');
    pm.delete('project-a');

    // Verify disk state
    const persistPath = pm.getPersistPath();
    const raw = fs.readFileSync(persistPath, 'utf8');
    const data = JSON.parse(raw);
    expect(data.instances).toEqual({});
    expect(data.chatProjectMap).toEqual({});
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rollback on persist failure
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager rollback on persist failure', () => {
  it('should rollback create on persist failure', () => {
    const pm = createManager();

    // Make persist fail by making the persist dir read-only
    pm.create('oc_chat1', 'research', 'first-project');

    const persistDir = path.dirname(pm.getPersistPath());
    // Make directory read-only to cause persist to fail
    fs.chmodSync(persistDir, 0o444);

    const result = pm.create('oc_chat2', 'book-reader', 'second-project');

    // Restore permissions for cleanup
    fs.chmodSync(persistDir, 0o755);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('持久化失败');
    }

    // first-project should still exist
    expect(pm.getActive('oc_chat1').name).toBe('first-project');
    // second-project should NOT exist (rolled back)
    expect(pm.listInstances().find((i) => i.name === 'second-project')).toBeUndefined();
  });

  it('should rollback use on persist failure', () => {
    const pm = createManager();
    pm.create('oc_chat1', 'research', 'my-research');

    // Make persist fail
    const persistDir = path.dirname(pm.getPersistPath());
    fs.chmodSync(persistDir, 0o444);

    const result = pm.use('oc_chat2', 'my-research');

    // Restore permissions
    fs.chmodSync(persistDir, 0o755);

    expect(result.ok).toBe(false);
    // oc_chat2 should NOT be bound (rolled back)
    expect(pm.getActive('oc_chat2').name).toBe('default');
  });

  it('should rollback reset on persist failure', () => {
    const pm = createManager();
    pm.create('oc_chat1', 'research', 'my-research');

    // Make persist fail
    const persistDir = path.dirname(pm.getPersistPath());
    fs.chmodSync(persistDir, 0o444);

    const result = pm.reset('oc_chat1');

    // Restore permissions
    fs.chmodSync(persistDir, 0o755);

    expect(result.ok).toBe(false);
    // oc_chat1 should still be bound (rolled back)
    expect(pm.getActive('oc_chat1').name).toBe('my-research');
  });

  it('should rollback delete on persist failure', () => {
    const pm = createManager();
    pm.create('oc_chat1', 'research', 'my-research');

    // Make persist fail
    const persistDir = path.dirname(pm.getPersistPath());
    fs.chmodSync(persistDir, 0o444);

    const result = pm.delete('my-research');

    // Restore permissions
    fs.chmodSync(persistDir, 0o755);

    expect(result.ok).toBe(false);
    // Instance should still exist (rolled back)
    expect(pm.getActive('oc_chat1').name).toBe('my-research');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Edge Cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager edge cases', () => {
  it('should handle multiple chatIds sharing an instance', () => {
    const pm = createManager();
    pm.create('oc_chat1', 'research', 'shared-project');

    // Bind 5 chatIds to the same instance
    for (let i = 2; i <= 5; i++) {
      const result = pm.use(`oc_chat${i}`, 'shared-project');
      expect(result.ok).toBe(true);
    }

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].chatIds).toHaveLength(5);
  });

  it('should allow creating instance after another chatId uses it', () => {
    const pm = createManager();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.use('oc_chat2', 'project-a');
    pm.reset('oc_chat1');

    // oc_chat2 still bound, oc_chat1 is default
    expect(pm.getActive('oc_chat1').name).toBe('default');
    expect(pm.getActive('oc_chat2').name).toBe('project-a');
  });

  it('should handle init clearing templates but keeping instances', () => {
    const pm = createManager();
    pm.create('oc_chat1', 'research', 'my-research');

    // Re-init with empty config — templates cleared
    pm.init({});

    // Existing instances still exist
    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);

    // But new creates with old template names should fail
    const result = pm.create('oc_chat2', 'research', 'another');
    expect(result.ok).toBe(false);
  });
});
