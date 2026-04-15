/**
 * Tests for ProjectManager persistence layer.
 *
 * Tests the persistence capabilities (persist, load, delete, recovery)
 * using real filesystem operations in temporary directories.
 *
 * @see Issue #2225 (Sub-Issue C — Persistence)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectManager } from './project-manager.js';
import type {
  ProjectManagerOptions,
  ProjectsPersistData,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Temp dirs for filesystem operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let tempFsBaseDir: string;
let tempWorkspaceDir: string;
let tempPackageDir: string;

beforeAll(() => {
  tempFsBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-persist-fs-'));
  tempWorkspaceDir = path.join(tempFsBaseDir, 'workspace');
  tempPackageDir = path.join(tempFsBaseDir, 'package');

  // Create template directories with CLAUDE.md files
  const researchDir = path.join(tempPackageDir, 'templates', 'research');
  fs.mkdirSync(researchDir, { recursive: true });
  fs.writeFileSync(path.join(researchDir, 'CLAUDE.md'), '# Research\n', 'utf-8');

  const bookDir = path.join(tempPackageDir, 'templates', 'book-reader');
  fs.mkdirSync(bookDir, { recursive: true });
  fs.writeFileSync(path.join(bookDir, 'CLAUDE.md'), '# Book Reader\n', 'utf-8');
});

afterAll(() => {
  try { fs.rmSync(tempFsBaseDir, { recursive: true, force: true }); } catch {}
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Create a temp directory for testing */
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-test-'));
}

/** Standard test options with persistence enabled */
function createPersistOptions(persistDir: string): ProjectManagerOptions {
  return {
    workspaceDir: tempWorkspaceDir,
    packageDir: tempPackageDir,
    templatesConfig: {
      research: {
        displayName: '研究模式',
        description: '专注研究的独立空间',
      },
      'book-reader': {
        displayName: '读书助手',
      },
    },
    persistDir,
  };
}

/** Create a ProjectManager with persistence in a temp dir */
function createPersistManager(tempDir?: string): { pm: ProjectManager; cleanup: () => void; persistDir: string } {
  const persistDir = tempDir ?? createTempDir();
  const pm = new ProjectManager(createPersistOptions(persistDir));
  return {
    pm,
    persistDir,
    cleanup: () => {
      try {
        fs.rmSync(persistDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure
      }
    },
  };
}

/** Read the persisted file and parse it */
function readPersistedFile(persistDir: string): ProjectsPersistData | null {
  const filePath = path.join(persistDir, 'projects.json');
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// persist()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('persist()', () => {
  let pm: ProjectManager;
  let cleanup: () => void;
  let persistDir: string;

  beforeEach(() => {
    const result = createPersistManager();
    ({ pm, cleanup, persistDir } = result);
  });

  afterEach(() => {
    cleanup();
  });

  it('should create projects.json after create()', () => {
    pm.create('chat1', 'research', 'my-research');

    const data = readPersistedFile(persistDir);
    expect(data).not.toBeNull();
    expect(data!.instances).toHaveProperty('my-research');
    expect(data!.chatProjectMap).toEqual({ chat1: 'my-research' });
  });

  it('should create .disclaude directory if it does not exist', () => {
    const newDir = path.join(createTempDir(), '.disclaude');
    const { pm: pm2, cleanup: cleanup2 } = createPersistManager(newDir);

    pm2.create('chat1', 'research', 'my-research');

    expect(fs.existsSync(newDir)).toBe(true);
    expect(fs.existsSync(path.join(newDir, 'projects.json'))).toBe(true);

    cleanup2();
    try { fs.rmSync(path.dirname(newDir), { recursive: true }); } catch { /* ignore */ }
  });

  it('should persist after use()', () => {
    pm.create('chat1', 'research', 'my-research');
    pm.use('chat2', 'my-research');

    const data = readPersistedFile(persistDir);
    expect(data!.chatProjectMap).toEqual({
      chat1: 'my-research',
      chat2: 'my-research',
    });
  });

  it('should persist after reset()', () => {
    pm.create('chat1', 'research', 'my-research');
    pm.reset('chat1');

    const data = readPersistedFile(persistDir);
    expect(data!.chatProjectMap).toEqual({});
    // Instance should still be persisted (reset only removes binding)
    expect(data!.instances).toHaveProperty('my-research');
  });

  it('should persist after delete()', () => {
    pm.create('chat1', 'research', 'my-research');
    pm.delete('my-research');

    const data = readPersistedFile(persistDir);
    expect(data!.instances).not.toHaveProperty('my-research');
    expect(data!.chatProjectMap).toEqual({});
  });

  it('should persist multiple instances', () => {
    pm.create('chat1', 'research', 'r1');
    pm.create('chat2', 'book-reader', 'b1');

    const data = readPersistedFile(persistDir);
    expect(Object.keys(data!.instances)).toHaveLength(2);
    expect(data!.instances).toHaveProperty('r1');
    expect(data!.instances).toHaveProperty('b1');
  });

  it('should produce valid JSON with expected schema', () => {
    pm.create('chat1', 'research', 'my-research');

    const data = readPersistedFile(persistDir);
    expect(data).toEqual({
      instances: {
        'my-research': {
          name: 'my-research',
          templateName: 'research',
          workingDir: path.join(tempWorkspaceDir, 'projects/my-research'),
          createdAt: expect.any(String),
        },
      },
      chatProjectMap: {
        chat1: 'my-research',
      },
    });
  });

  it('should not leave .tmp file on success', () => {
    pm.create('chat1', 'research', 'my-research');

    const tmpFiles = fs.readdirSync(persistDir).filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// persist() without persistDir
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('persist() without persistDir', () => {
  it('should be a no-op when persistDir is not configured', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-no-persist-'));
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-no-persist-pkg-'));
    const tmplDir = path.join(pkgDir, 'templates', 'research');
    fs.mkdirSync(tmplDir, { recursive: true });
    fs.writeFileSync(path.join(tmplDir, 'CLAUDE.md'), '# Research\n', 'utf-8');

    const pm = new ProjectManager({
      workspaceDir: wsDir,
      packageDir: pkgDir,
      templatesConfig: { research: { displayName: '研究' } },
    });

    const result = pm.create('chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);
    // No error, no file created
    expect(pm.getPersistPath()).toBeUndefined();
    expect(pm.persist()).toBeNull();

    try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch {}
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// loadPersistedData() & restore on construction
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('loadPersistedData()', () => {
  let persistDir: string;

  beforeEach(() => {
    persistDir = createTempDir();
  });

  afterEach(() => {
    try { fs.rmSync(persistDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should restore instances and bindings from persisted file', () => {
    // Create and persist some data
    const { pm: pm1 } = createPersistManager(persistDir);
    pm1.create('chat1', 'research', 'my-research');
    pm1.create('chat2', 'book-reader', 'my-books');

    // Create a new manager from the same persistDir — should load data
    const pm2 = new ProjectManager(createPersistOptions(persistDir));

    // Should restore instances
    const instances = pm2.listInstances();
    expect(instances).toHaveLength(2);

    // Should restore bindings
    expect(pm2.getActive('chat1').name).toBe('my-research');
    expect(pm2.getActive('chat2').name).toBe('my-books');
  });

  it('should return error when file does not exist', () => {
    const { pm } = createPersistManager(createTempDir());
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should return error for invalid JSON', () => {
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(path.join(persistDir, 'projects.json'), 'not json{{{', 'utf-8');

    const { pm } = createPersistManager(persistDir);
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('读取持久化文件失败');
    }
  });

  it('should return error for non-object root', () => {
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(path.join(persistDir, 'projects.json'), '"a string"', 'utf-8');

    const { pm } = createPersistManager(persistDir);
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('数据格式错误');
    }
  });

  it('should return error for missing instances field', () => {
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(path.join(persistDir, 'projects.json'), '{"chatProjectMap":{}}', 'utf-8');

    const { pm } = createPersistManager(persistDir);
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('数据格式错误');
    }
  });

  it('should return error for missing chatProjectMap field', () => {
    fs.mkdirSync(persistDir, { recursive: true });
    fs.writeFileSync(path.join(persistDir, 'projects.json'), '{"instances":{}}', 'utf-8');

    const { pm } = createPersistManager(persistDir);
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('数据格式错误');
    }
  });

  it('should return error for instance missing required fields', () => {
    fs.mkdirSync(persistDir, { recursive: true });
    const data = {
      instances: { 'my-research': { name: 'my-research' } }, // missing templateName, workingDir, createdAt
      chatProjectMap: {},
    };
    fs.writeFileSync(path.join(persistDir, 'projects.json'), JSON.stringify(data), 'utf-8');

    const { pm } = createPersistManager(persistDir);
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('数据格式错误');
    }
  });

  it('should return error for invalid createdAt', () => {
    fs.mkdirSync(persistDir, { recursive: true });
    const data = {
      instances: {
        'my-research': {
          name: 'my-research',
          templateName: 'research',
          workingDir: path.join(tempWorkspaceDir, 'projects/my-research'),
          createdAt: 'not-a-date',
        },
      },
      chatProjectMap: {},
    };
    fs.writeFileSync(path.join(persistDir, 'projects.json'), JSON.stringify(data), 'utf-8');

    const { pm } = createPersistManager(persistDir);
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('数据格式错误');
    }
  });

  it('should return error for non-string chatProjectMap value', () => {
    fs.mkdirSync(persistDir, { recursive: true });
    const data = {
      instances: {},
      chatProjectMap: { chat1: 123 },
    };
    fs.writeFileSync(path.join(persistDir, 'projects.json'), JSON.stringify(data), 'utf-8');

    const { pm } = createPersistManager(persistDir);
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('数据格式错误');
    }
  });

  it('should start fresh when file is missing (not an error)', () => {
    const newDir = createTempDir();
    const pm = new ProjectManager(createPersistOptions(newDir));

    // Should work normally with empty state
    expect(pm.listInstances()).toEqual([]);
    expect(pm.getActive('chat1').name).toBe('default');

    try { fs.rmSync(newDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should not restore bindings for non-existent instances', () => {
    fs.mkdirSync(persistDir, { recursive: true });
    const data = {
      instances: {},
      chatProjectMap: { chat1: 'non-existent-instance' },
    };
    fs.writeFileSync(path.join(persistDir, 'projects.json'), JSON.stringify(data), 'utf-8');

    const pm = new ProjectManager(createPersistOptions(persistDir));

    // Binding to non-existent instance should not be restored
    expect(pm.getActive('chat1').name).toBe('default');
  });

  it('should load valid persisted data successfully', () => {
    fs.mkdirSync(persistDir, { recursive: true });
    const data: ProjectsPersistData = {
      instances: {
        'my-research': {
          name: 'my-research',
          templateName: 'research',
          workingDir: path.join(tempWorkspaceDir, 'projects/my-research'),
          createdAt: new Date().toISOString(),
        },
      },
      chatProjectMap: { chat1: 'my-research' },
    };
    fs.writeFileSync(path.join(persistDir, 'projects.json'), JSON.stringify(data), 'utf-8');

    const pm = new ProjectManager(createPersistOptions(persistDir));

    expect(pm.listInstances()).toHaveLength(1);
    expect(pm.getActive('chat1').name).toBe('my-research');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// delete()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('delete()', () => {
  let pm: ProjectManager;
  let cleanup: () => void;
  let persistDir: string;

  beforeEach(() => {
    const result = createPersistManager();
    ({ pm, cleanup, persistDir } = result);
  });

  afterEach(() => {
    cleanup();
  });

  it('should remove instance and all bindings', () => {
    pm.create('chat1', 'research', 'my-research');
    pm.use('chat2', 'my-research');

    const result = pm.delete('my-research');
    expect(result.ok).toBe(true);

    expect(pm.listInstances()).toHaveLength(0);
    expect(pm.getActive('chat1').name).toBe('default');
    expect(pm.getActive('chat2').name).toBe('default');
  });

  it('should persist the deletion', () => {
    pm.create('chat1', 'research', 'my-research');
    pm.delete('my-research');

    const data = readPersistedFile(persistDir);
    expect(Object.keys(data!.instances)).toHaveLength(0);
    expect(data!.chatProjectMap).toEqual({});
  });

  it('should fail for non-existent instance', () => {
    const result = pm.delete('nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should fail for reserved name "default"', () => {
    const result = pm.delete('default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留');
    }
  });

  it('should only delete the specified instance, not others', () => {
    pm.create('chat1', 'research', 'r1');
    pm.create('chat2', 'book-reader', 'b1');

    pm.delete('r1');

    expect(pm.listInstances()).toHaveLength(1);
    expect(pm.getActive('chat2').name).toBe('b1');
    expect(pm.getActive('chat1').name).toBe('default');
  });

  it('should restore correctly after delete and recreate', () => {
    pm.create('chat1', 'research', 'my-research');
    pm.delete('my-research');

    // Should be able to create with same name
    const result = pm.create('chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    const data = readPersistedFile(persistDir);
    expect(data!.instances).toHaveProperty('my-research');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// toPersistData()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('toPersistData()', () => {
  it('should return empty data for fresh manager', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-td-'));
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-td-pkg-'));
    const tmplDir = path.join(pkgDir, 'templates', 'research');
    fs.mkdirSync(tmplDir, { recursive: true });
    fs.writeFileSync(path.join(tmplDir, 'CLAUDE.md'), '# Research\n', 'utf-8');

    const pm = new ProjectManager({
      workspaceDir: wsDir,
      packageDir: pkgDir,
      templatesConfig: { research: { displayName: '研究' } },
    });

    const data = pm.toPersistData();
    expect(data).toEqual({
      instances: {},
      chatProjectMap: {},
    });

    try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch {}
  });

  it('should reflect current in-memory state', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-td2-'));
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-td2-pkg-'));

    for (const name of ['research', 'book-reader']) {
      const tmplDir = path.join(pkgDir, 'templates', name);
      fs.mkdirSync(tmplDir, { recursive: true });
      fs.writeFileSync(path.join(tmplDir, 'CLAUDE.md'), `# ${name}\n`, 'utf-8');
    }

    const pm = new ProjectManager({
      workspaceDir: wsDir,
      packageDir: pkgDir,
      templatesConfig: {
        research: { displayName: '研究' },
        'book-reader': { displayName: '读书' },
      },
    });

    pm.create('chat1', 'research', 'my-research');
    pm.use('chat2', 'my-research');

    const data = pm.toPersistData();
    expect(Object.keys(data.instances)).toHaveLength(1);
    expect(data.instances['my-research']).toEqual({
      name: 'my-research',
      templateName: 'research',
      workingDir: path.join(wsDir, 'projects/my-research'),
      createdAt: expect.any(String),
    });
    expect(data.chatProjectMap).toEqual({
      chat1: 'my-research',
      chat2: 'my-research',
    });

    try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch {}
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getPersistPath()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getPersistPath()', () => {
  it('should return undefined when persistDir is not set', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-gpp-'));
    const pm = new ProjectManager({
      workspaceDir: wsDir,
      packageDir: '',
      templatesConfig: {},
    });
    expect(pm.getPersistPath()).toBeUndefined();
    try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
  });

  it('should return correct path when persistDir is set', () => {
    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-gpp2-'));
    const pm = new ProjectManager({
      workspaceDir: wsDir,
      packageDir: '',
      templatesConfig: {},
      persistDir: path.join(wsDir, '.disclaude'),
    });
    expect(pm.getPersistPath()).toBe(path.join(wsDir, '.disclaude/projects.json'));
    try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rollback on persist failure
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('rollback on persist failure', () => {
  it('should rollback create() when persist fails', () => {
    // Use a read-only directory to cause persist failure
    const readOnlyDir = createTempDir();
    fs.mkdirSync(readOnlyDir, { recursive: true });
    fs.chmodSync(readOnlyDir, 0o444);

    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-rollback-'));
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-rollback-pkg-'));
    const tmplDir = path.join(pkgDir, 'templates', 'research');
    fs.mkdirSync(tmplDir, { recursive: true });
    fs.writeFileSync(path.join(tmplDir, 'CLAUDE.md'), '# Research\n', 'utf-8');

    const pm = new ProjectManager({
      workspaceDir: wsDir,
      packageDir: pkgDir,
      templatesConfig: { research: { displayName: '研究' } },
      persistDir: readOnlyDir,
    });

    const result = pm.create('chat1', 'research', 'my-research');

    // On some systems, writing to read-only dir still succeeds (root)
    // So we just check that the result is consistent
    if (!result.ok) {
      expect(result.error).toContain('持久化失败');
      // Memory should be rolled back
      expect(pm.listInstances()).toHaveLength(0);
    }

    try { fs.chmodSync(readOnlyDir, 0o755); fs.rmSync(readOnlyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch {}
  });

  it('should rollback use() when persist fails', () => {
    const readOnlyDir = createTempDir();
    fs.mkdirSync(readOnlyDir, { recursive: true });

    const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-rollback2-'));
    const pkgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-rollback2-pkg-'));
    const tmplDir = path.join(pkgDir, 'templates', 'research');
    fs.mkdirSync(tmplDir, { recursive: true });
    fs.writeFileSync(path.join(tmplDir, 'CLAUDE.md'), '# Research\n', 'utf-8');

    const pm = new ProjectManager({
      workspaceDir: wsDir,
      packageDir: pkgDir,
      templatesConfig: { research: { displayName: '研究' } },
      persistDir: readOnlyDir,
    });

    // First create should succeed (dir is writable)
    const createResult = pm.create('chat1', 'research', 'my-research');
    expect(createResult.ok).toBe(true);

    // Make dir read-only
    fs.chmodSync(readOnlyDir, 0o444);

    const useResult = pm.use('chat2', 'my-research');

    if (!useResult.ok) {
      expect(useResult.error).toContain('持久化失败');
      // Binding should be rolled back
      expect(pm.getActive('chat2').name).toBe('default');
    }

    try { fs.chmodSync(readOnlyDir, 0o755); fs.rmSync(readOnlyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(wsDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(pkgDir, { recursive: true, force: true }); } catch {}
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Full lifecycle with persistence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('full persistence lifecycle', () => {
  it('should survive stop/restart cycle', () => {
    const tempDir = createTempDir();

    // Session 1: Create data
    const pm1 = new ProjectManager(createPersistOptions(tempDir));
    pm1.create('chat1', 'research', 'my-research');
    pm1.create('chat2', 'book-reader', 'my-books');
    pm1.use('chat3', 'my-research');

    // Session 2: Reload and verify
    const pm2 = new ProjectManager(createPersistOptions(tempDir));
    expect(pm2.listInstances()).toHaveLength(2);
    expect(pm2.getActive('chat1').name).toBe('my-research');
    expect(pm2.getActive('chat2').name).toBe('my-books');
    expect(pm2.getActive('chat3').name).toBe('my-research');

    // Session 2: Make changes
    pm2.reset('chat1');
    pm2.delete('my-books');

    // Session 3: Verify changes persisted
    const pm3 = new ProjectManager(createPersistOptions(tempDir));
    expect(pm3.listInstances()).toHaveLength(1);
    expect(pm3.getActive('chat1').name).toBe('default');
    expect(pm3.getActive('chat2').name).toBe('default');
    expect(pm3.getActive('chat3').name).toBe('my-research');

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should handle concurrent manager instances pointing to same dir', () => {
    const tempDir = createTempDir();

    // Two managers with same persistDir — each writes its own full state
    const pm1 = new ProjectManager(createPersistOptions(tempDir));
    const pm2 = new ProjectManager(createPersistOptions(tempDir));

    pm1.create('chat1', 'research', 'r1');
    pm2.create('chat2', 'book-reader', 'b1');

    // Last write wins — pm2's write contains only its in-memory state
    const data = readPersistedFile(tempDir);
    // pm2 wrote last, so its state (b1) is on disk
    expect(data!.instances).toHaveProperty('b1');

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should persist and reload complex binding scenarios', () => {
    const tempDir = createTempDir();

    const pm1 = new ProjectManager(createPersistOptions(tempDir));
    pm1.create('chat1', 'research', 'shared-project');
    pm1.use('chat2', 'shared-project');
    pm1.use('chat3', 'shared-project');

    // Verify on disk
    const data = readPersistedFile(tempDir);
    expect(data!.chatProjectMap).toEqual({
      chat1: 'shared-project',
      chat2: 'shared-project',
      chat3: 'shared-project',
    });

    // Reload and verify
    const pm2 = new ProjectManager(createPersistOptions(tempDir));
    const instances = pm2.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].chatIds).toHaveLength(3);

    // Reset one binding
    pm2.reset('chat1');

    const pm3 = new ProjectManager(createPersistOptions(tempDir));
    const instances3 = pm3.listInstances();
    expect(instances3[0].chatIds).toHaveLength(2);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Edge cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('edge cases', () => {
  it('should handle empty persist data (no instances, no bindings)', () => {
    const tempDir = createTempDir();
    const pm = new ProjectManager(createPersistOptions(tempDir));

    // persist() with no changes should write empty data
    pm.persist();

    const data = readPersistedFile(tempDir);
    expect(data).toEqual({
      instances: {},
      chatProjectMap: {},
    });

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should handle special characters in chatId', () => {
    const tempDir = createTempDir();
    const pm = new ProjectManager(createPersistOptions(tempDir));

    const specialChatId = 'oc_abc-123_xyz';
    pm.create(specialChatId, 'research', 'my-research');

    const pm2 = new ProjectManager(createPersistOptions(tempDir));
    expect(pm2.getActive(specialChatId).name).toBe('my-research');

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should not persist on failed operations', () => {
    const tempDir = createTempDir();
    const pm = new ProjectManager(createPersistOptions(tempDir));

    // Try to create with invalid name
    const result = pm.create('chat1', 'research', 'default');
    expect(result.ok).toBe(false);

    // No file should have been created
    expect(fs.existsSync(path.join(tempDir, 'projects.json'))).toBe(false);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('should overwrite previous persist data correctly', () => {
    const tempDir = createTempDir();
    const pm = new ProjectManager(createPersistOptions(tempDir));

    pm.create('chat1', 'research', 'r1');
    let data = readPersistedFile(tempDir);
    expect(Object.keys(data!.instances)).toEqual(['r1']);

    pm.create('chat2', 'book-reader', 'b1');
    data = readPersistedFile(tempDir);
    expect(Object.keys(data!.instances).sort()).toEqual(['b1', 'r1']);

    pm.delete('r1');
    data = readPersistedFile(tempDir);
    expect(Object.keys(data!.instances)).toEqual(['b1']);

    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
