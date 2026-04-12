/**
 * Tests for the project persistence module.
 *
 * Covers:
 * - Schema validation (valid, invalid, corrupt data)
 * - Atomic write (persist → load round-trip)
 * - Edge cases (empty state, missing directory, large data)
 * - Delete operations (instance removal, binding cleanup)
 * - Error handling (corrupt file, permission issues)
 *
 * Uses real filesystem operations in temp directories (no mocks).
 *
 * @see Issue #2225
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import {
  validatePersistData,
  loadPersistedProjects,
  persistProjects,
  deletePersistedInstance,
  getDisclaudeDir,
  getProjectsFilePath,
} from './persistence.js';
import type { ProjectsPersistData } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Create a temp workspace directory for each test. */
function createTestWorkspace(): string {
  const dir = join(tmpdir(), `persistence-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Clean up temp workspace after test. */
function cleanupTestWorkspace(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/** Create valid sample data for testing. */
function createSampleData(): ProjectsPersistData {
  return {
    instances: {
      'my-research': {
        name: 'my-research',
        templateName: 'research',
        workingDir: '/workspace/projects/my-research',
        createdAt: '2026-04-09T10:00:00Z',
      },
    },
    chatProjectMap: {
      'oc_abc123': 'my-research',
      'oc_def456': 'my-research',
    },
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Path Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getDisclaudeDir', () => {
  it('should return .disclaude directory path inside workspace', () => {
    expect(getDisclaudeDir('/workspace')).toBe(resolve('/workspace/.disclaude'));
  });

  it('should handle relative paths', () => {
    expect(getDisclaudeDir('my-workspace')).toBe(resolve('my-workspace/.disclaude'));
  });
});

describe('getProjectsFilePath', () => {
  it('should return projects.json path inside .disclaude directory', () => {
    expect(getProjectsFilePath('/workspace')).toBe(
      resolve('/workspace/.disclaude/projects.json'),
    );
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Schema Validation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('validatePersistData', () => {
  it('should accept valid full data', () => {
    const data = createSampleData();
    const result = validatePersistData(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.instances['my-research'].name).toBe('my-research');
      expect(result.data.chatProjectMap['oc_abc123']).toBe('my-research');
    }
  });

  it('should accept empty state', () => {
    const result = validatePersistData({ instances: {}, chatProjectMap: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.data.instances)).toHaveLength(0);
    }
  });

  it('should reject null', () => {
    const result = validatePersistData(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('期望一个对象');
    }
  });

  it('should reject arrays', () => {
    const result = validatePersistData([]);
    expect(result.ok).toBe(false);
  });

  it('should reject non-objects', () => {
    expect(validatePersistData('string').ok).toBe(false);
    expect(validatePersistData(123).ok).toBe(false);
    expect(validatePersistData(true).ok).toBe(false);
  });

  it('should reject missing instances field', () => {
    const result = validatePersistData({ chatProjectMap: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('instances');
    }
  });

  it('should reject missing chatProjectMap field', () => {
    const result = validatePersistData({
      instances: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatProjectMap');
    }
  });

  it('should reject instance with missing name', () => {
    const result = validatePersistData({
      instances: {
        test: { templateName: 'research', workingDir: '/x', createdAt: '2026-01-01' },
      },
      chatProjectMap: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('name');
    }
  });

  it('should reject instance with empty name', () => {
    const result = validatePersistData({
      instances: {
        test: { name: '', templateName: 'research', workingDir: '/x', createdAt: '2026-01-01' },
      },
      chatProjectMap: {},
    });
    expect(result.ok).toBe(false);
  });

  it('should reject instance with non-string templateName', () => {
    const result = validatePersistData({
      instances: {
        test: { name: 'test', templateName: 123, workingDir: '/x', createdAt: '2026-01-01' },
      },
      chatProjectMap: {},
    });
    expect(result.ok).toBe(false);
  });

  it('should reject instance with missing workingDir', () => {
    const result = validatePersistData({
      instances: {
        test: { name: 'test', templateName: 'research', createdAt: '2026-01-01' },
      },
      chatProjectMap: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('workingDir');
    }
  });

  it('should reject instance with missing createdAt', () => {
    const result = validatePersistData({
      instances: {
        test: { name: 'test', templateName: 'research', workingDir: '/x' },
      },
      chatProjectMap: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('createdAt');
    }
  });

  it('should reject chatProjectMap with non-string value', () => {
    const result = validatePersistData({
      instances: {},
      chatProjectMap: { 'oc_abc': 123 as unknown as string },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('oc_abc');
    }
  });

  it('should accept data with multiple instances', () => {
    const data: ProjectsPersistData = {
      instances: {
        research: {
          name: 'research',
          templateName: 'research-tpl',
          workingDir: '/ws/projects/research',
          createdAt: '2026-04-09T10:00:00Z',
        },
        'book-reader': {
          name: 'book-reader',
          templateName: 'book-tpl',
          workingDir: '/ws/projects/book-reader',
          createdAt: '2026-04-10T12:00:00Z',
        },
      },
      chatProjectMap: {
        'oc_1': 'research',
        'oc_2': 'book-reader',
        'oc_3': 'research',
      },
    };
    const result = validatePersistData(data);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.data.instances)).toHaveLength(2);
      expect(Object.keys(result.data.chatProjectMap)).toHaveLength(3);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Write Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('persistProjects', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTestWorkspace();
  });

  afterEach(() => {
    cleanupTestWorkspace(workspace);
  });

  it('should persist data to projects.json', () => {
    const data = createSampleData();
    const result = persistProjects(data, workspace);
    expect(result.ok).toBe(true);

    // Verify file exists and content is correct
    const filePath = getProjectsFilePath(workspace);
    expect(existsSync(filePath)).toBe(true);

    const content = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(content.instances['my-research'].name).toBe('my-research');
    expect(content.chatProjectMap['oc_abc123']).toBe('my-research');
  });

  it('should create .disclaude directory if it does not exist', () => {
    const data: ProjectsPersistData = { instances: {}, chatProjectMap: {} };
    const result = persistProjects(data, workspace);
    expect(result.ok).toBe(true);

    expect(existsSync(getDisclaudeDir(workspace))).toBe(true);
  });

  it('should create nested directories if needed', () => {
    const nestedWorkspace = join(workspace, 'nested', 'deep');
    const data: ProjectsPersistData = { instances: {}, chatProjectMap: {} };
    const result = persistProjects(data, nestedWorkspace);
    expect(result.ok).toBe(true);
    expect(existsSync(getDisclaudeDir(nestedWorkspace))).toBe(true);

    cleanupTestWorkspace(nestedWorkspace);
  });

  it('should overwrite existing data', () => {
    const data1: ProjectsPersistData = {
      instances: {
        first: {
          name: 'first',
          templateName: 'tpl',
          workingDir: '/x',
          createdAt: '2026-01-01',
        },
      },
      chatProjectMap: {},
    };

    const data2: ProjectsPersistData = {
      instances: {
        second: {
          name: 'second',
          templateName: 'tpl',
          workingDir: '/y',
          createdAt: '2026-01-02',
        },
      },
      chatProjectMap: { 'oc_1': 'second' },
    };

    expect(persistProjects(data1, workspace).ok).toBe(true);
    expect(persistProjects(data2, workspace).ok).toBe(true);

    const loaded = loadPersistedProjects(workspace);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data.instances['first']).toBeUndefined();
      expect(loaded.data.instances['second']).toBeDefined();
      expect(loaded.data.chatProjectMap['oc_1']).toBe('second');
    }
  });

  it('should not leave temp files on success', () => {
    const data = createSampleData();
    persistProjects(data, workspace);

    const tempPath = `${getProjectsFilePath(workspace)}.tmp`;
    expect(existsSync(tempPath)).toBe(false);
  });

  it('should write human-readable JSON with 2-space indent', () => {
    const data: ProjectsPersistData = { instances: {}, chatProjectMap: {} };
    persistProjects(data, workspace);

    const content = readFileSync(getProjectsFilePath(workspace), 'utf-8');
    // 2-space indented JSON should start with "{\n  "
    expect(content).toMatch(/^\{\n  "instances"/);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Read Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('loadPersistedProjects', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTestWorkspace();
  });

  afterEach(() => {
    cleanupTestWorkspace(workspace);
  });

  it('should return empty state when file does not exist', () => {
    const result = loadPersistedProjects(workspace);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.data.instances)).toHaveLength(0);
      expect(Object.keys(result.data.chatProjectMap)).toHaveLength(0);
    }
  });

  it('should load valid persisted data', () => {
    const data = createSampleData();
    persistProjects(data, workspace);

    const result = loadPersistedProjects(workspace);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.instances['my-research'].templateName).toBe('research');
      expect(result.data.chatProjectMap['oc_abc123']).toBe('my-research');
    }
  });

  it('should reject corrupt JSON', () => {
    const dir = getDisclaudeDir(workspace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(getProjectsFilePath(workspace), 'not valid json{');

    const result = loadPersistedProjects(workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('无法读取 projects.json');
    }
  });

  it('should reject valid JSON with invalid schema', () => {
    const dir = getDisclaudeDir(workspace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      getProjectsFilePath(workspace),
      JSON.stringify({ instances: 'not an object', chatProjectMap: {} }),
    );

    const result = loadPersistedProjects(workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('instances');
    }
  });

  it('should handle empty JSON object', () => {
    const dir = getDisclaudeDir(workspace);
    mkdirSync(dir, { recursive: true });
    writeFileSync(getProjectsFilePath(workspace), '{}');

    const result = loadPersistedProjects(workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('instances');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Round-trip Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('persist → load round-trip', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTestWorkspace();
  });

  afterEach(() => {
    cleanupTestWorkspace(workspace);
  });

  it('should survive a persist-load round-trip', () => {
    const original = createSampleData();
    const persistResult = persistProjects(original, workspace);
    expect(persistResult.ok).toBe(true);

    const loadResult = loadPersistedProjects(workspace);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.data).toEqual(original);
    }
  });

  it('should preserve multiple instances through round-trip', () => {
    const data: ProjectsPersistData = {
      instances: {
        alpha: {
          name: 'alpha',
          templateName: 'tpl-a',
          workingDir: '/ws/projects/alpha',
          createdAt: '2026-01-01T00:00:00Z',
        },
        beta: {
          name: 'beta',
          templateName: 'tpl-b',
          workingDir: '/ws/projects/beta',
          createdAt: '2026-02-01T00:00:00Z',
        },
        gamma: {
          name: 'gamma',
          templateName: 'tpl-c',
          workingDir: '/ws/projects/gamma',
          createdAt: '2026-03-01T00:00:00Z',
        },
      },
      chatProjectMap: {
        'oc_1': 'alpha',
        'oc_2': 'beta',
        'oc_3': 'alpha',
        'oc_4': 'gamma',
        'oc_5': 'beta',
      },
    };

    persistProjects(data, workspace);
    const loaded = loadPersistedProjects(workspace);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data).toEqual(data);
    }
  });

  it('should preserve empty state through round-trip', () => {
    const data: ProjectsPersistData = { instances: {}, chatProjectMap: {} };
    persistProjects(data, workspace);
    const loaded = loadPersistedProjects(workspace);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data).toEqual(data);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Delete Operations
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('deletePersistedInstance', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTestWorkspace();
  });

  afterEach(() => {
    cleanupTestWorkspace(workspace);
  });

  it('should remove an instance and its bindings', () => {
    const data: ProjectsPersistData = {
      instances: {
        research: {
          name: 'research',
          templateName: 'tpl',
          workingDir: '/ws/projects/research',
          createdAt: '2026-01-01',
        },
        book: {
          name: 'book',
          templateName: 'tpl',
          workingDir: '/ws/projects/book',
          createdAt: '2026-01-02',
        },
      },
      chatProjectMap: {
        'oc_1': 'research',
        'oc_2': 'research',
        'oc_3': 'book',
      },
    };
    persistProjects(data, workspace);

    const result = deletePersistedInstance('research', workspace);
    expect(result.ok).toBe(true);

    const loaded = loadPersistedProjects(workspace);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data.instances['research']).toBeUndefined();
      expect(loaded.data.instances['book']).toBeDefined();
      expect(loaded.data.chatProjectMap['oc_1']).toBeUndefined();
      expect(loaded.data.chatProjectMap['oc_2']).toBeUndefined();
      expect(loaded.data.chatProjectMap['oc_3']).toBe('book');
    }
  });

  it('should return error for non-existent instance', () => {
    const data: ProjectsPersistData = { instances: {}, chatProjectMap: {} };
    persistProjects(data, workspace);

    const result = deletePersistedInstance('nonexistent', workspace);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should return error when no persistence file exists', () => {
    // No file persisted, but this should still fail gracefully
    const result = deletePersistedInstance('something', workspace);
    // loadPersistedProjects returns empty state (no file),
    // then deletePersistedInstance checks if instance exists
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should clean up all chatId bindings for deleted instance', () => {
    const data: ProjectsPersistData = {
      instances: {
        target: {
          name: 'target',
          templateName: 'tpl',
          workingDir: '/ws/projects/target',
          createdAt: '2026-01-01',
        },
      },
      chatProjectMap: {
        'oc_a': 'target',
        'oc_b': 'target',
        'oc_c': 'target',
        'oc_d': 'target',
      },
    };
    persistProjects(data, workspace);

    deletePersistedInstance('target', workspace);

    const loaded = loadPersistedProjects(workspace);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(Object.keys(loaded.data.chatProjectMap)).toHaveLength(0);
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Edge Cases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('edge cases', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = createTestWorkspace();
  });

  afterEach(() => {
    cleanupTestWorkspace(workspace);
  });

  it('should handle instance with special characters in name', () => {
    const data: ProjectsPersistData = {
      instances: {
        'my-project_v2.0': {
          name: 'my-project_v2.0',
          templateName: 'tpl',
          workingDir: '/ws/projects/my-project_v2.0',
          createdAt: '2026-01-01',
        },
      },
      chatProjectMap: {},
    };

    persistProjects(data, workspace);
    const loaded = loadPersistedProjects(workspace);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data.instances['my-project_v2.0']).toBeDefined();
    }
  });

  it('should handle Unicode in template names', () => {
    const data: ProjectsPersistData = {
      instances: {
        'research': {
          name: 'research',
          templateName: '研究模板',
          workingDir: '/ws/projects/research',
          createdAt: '2026-01-01',
        },
      },
      chatProjectMap: {},
    };

    persistProjects(data, workspace);
    const loaded = loadPersistedProjects(workspace);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data.instances['research'].templateName).toBe('研究模板');
    }
  });

  it('should handle very long workingDir paths', () => {
    const longPath = `/ws/projects/${'a'.repeat(500)}`;
    const data: ProjectsPersistData = {
      instances: {
        test: {
          name: 'test',
          templateName: 'tpl',
          workingDir: longPath,
          createdAt: '2026-01-01',
        },
      },
      chatProjectMap: {},
    };

    persistProjects(data, workspace);
    const loaded = loadPersistedProjects(workspace);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.data.instances['test'].workingDir).toBe(longPath);
    }
  });

  it('should handle many instances', () => {
    const instances: Record<string, { name: string; templateName: string; workingDir: string; createdAt: string }> = {};
    const chatProjectMap: Record<string, string> = {};
    for (let i = 0; i < 100; i++) {
      const name = `project-${i}`;
      instances[name] = {
        name,
        templateName: 'tpl',
        workingDir: `/ws/projects/${name}`,
        createdAt: '2026-01-01',
      };
      chatProjectMap[`oc_${i}`] = name;
    }

    const data: ProjectsPersistData = { instances, chatProjectMap };
    persistProjects(data, workspace);

    const loaded = loadPersistedProjects(workspace);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(Object.keys(loaded.data.instances)).toHaveLength(100);
      expect(Object.keys(loaded.data.chatProjectMap)).toHaveLength(100);
    }
  });
});
