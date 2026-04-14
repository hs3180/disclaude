/**
 * Filesystem operation tests for ProjectManager — Sub-Issue D (#2226).
 *
 * Tests real filesystem operations: working directory creation,
 * CLAUDE.md template copying, path traversal protection, and rollback.
 *
 * @see Issue #2226 (Sub-Issue D — Filesystem operations)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it, expect } from 'vitest';
import { ProjectManager } from './project-manager.js';
import type {
  ProjectManagerOptions,
  ProjectTemplatesConfig,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Temp directories created during tests — cleaned up in afterEach */
const tempDirs: string[] = [];

function createTempDir(prefix = 'pm-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * Set up a complete test environment with real filesystem:
 * - workspaceDir with projects/ subdirectory
 * - packageDir with templates/ containing template CLAUDE.md files
 */
function setupTestEnv(templateConfig: ProjectTemplatesConfig = {}) {
  const workspaceDir = createTempDir('pm-ws-');
  const packageDir = createTempDir('pm-pkg-');

  // Create template directories with CLAUDE.md files
  const templatesDir = path.join(packageDir, 'templates');
  fs.mkdirSync(templatesDir, { recursive: true });

  for (const templateName of Object.keys(templateConfig)) {
    const templateDir = path.join(templatesDir, templateName);
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(
      path.join(templateDir, 'CLAUDE.md'),
      `# ${templateName} template\n\nThis is the ${templateName} CLAUDE.md template.`,
    );
  }

  const options: ProjectManagerOptions = {
    workspaceDir,
    packageDir,
    templatesConfig: templateConfig,
  };

  const pm = new ProjectManager(options);
  pm.init(templateConfig);

  return { pm, workspaceDir, packageDir, templatesDir };
}

afterEach(() => {
  // Clean up all temp directories
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
  tempDirs.length = 0;
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Working Directory Creation
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — instantiateFromTemplate() — working directory', () => {
  it('should create working directory under {workspaceDir}/projects/', () => {
    const { pm, workspaceDir } = setupTestEnv({
      research: { displayName: '研究模式' },
    });

    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    const expectedDir = path.join(workspaceDir, 'projects', 'my-research');
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.statSync(expectedDir).isDirectory()).toBe(true);
  });

  it('should create nested projects/ directory if it does not exist', () => {
    const { pm, workspaceDir } = setupTestEnv({
      research: {},
    });

    // Verify projects/ dir doesn't exist yet (it's created by instantiateFromTemplate)
    const projectsDir = path.join(workspaceDir, 'projects');
    expect(fs.existsSync(projectsDir)).toBe(false);

    const result = pm.create('oc_chat1', 'research', 'test-project');
    expect(result.ok).toBe(true);

    expect(fs.existsSync(projectsDir)).toBe(true);
    expect(fs.existsSync(path.join(projectsDir, 'test-project'))).toBe(true);
  });

  it('should handle directory already existing', () => {
    const { pm, workspaceDir } = setupTestEnv({
      research: {},
    });

    // Pre-create the directory
    const projectDir = path.join(workspaceDir, 'projects', 'existing');
    fs.mkdirSync(projectDir, { recursive: true });

    const result = pm.create('oc_chat1', 'research', 'existing');
    // This should fail because the instance already exists in memory? No, the name is new.
    // But the directory already exists on disk. The code checks existsSync before mkdirSync,
    // so this should succeed (skip mkdir since dir exists).
    expect(result.ok).toBe(true);
  });

  it('should create different directories for different instances', () => {
    const { pm, workspaceDir } = setupTestEnv({
      research: {},
      'book-reader': {},
    });

    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat2', 'book-reader', 'project-b');

    const dirA = path.join(workspaceDir, 'projects', 'project-a');
    const dirB = path.join(workspaceDir, 'projects', 'project-b');
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CLAUDE.md Copying
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — copyClaudeMd() — template copying', () => {
  it('should copy CLAUDE.md from template to instance working directory', () => {
    const { pm, workspaceDir, packageDir } = setupTestEnv({
      research: { displayName: '研究模式' },
    });

    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    const sourceMd = path.join(packageDir, 'templates', 'research', 'CLAUDE.md');
    const destMd = path.join(workspaceDir, 'projects', 'my-research', 'CLAUDE.md');

    expect(fs.existsSync(destMd)).toBe(true);
    expect(fs.readFileSync(destMd, 'utf-8')).toBe(
      fs.readFileSync(sourceMd, 'utf-8'),
    );
  });

  it('should copy correct template CLAUDE.md for each instance', () => {
    const { pm, workspaceDir } = setupTestEnv({
      research: {},
      'book-reader': {},
    });

    pm.create('oc_chat1', 'research', 'proj-research');
    pm.create('oc_chat2', 'book-reader', 'proj-books');

    const researchMd = path.join(workspaceDir, 'projects', 'proj-research', 'CLAUDE.md');
    const booksMd = path.join(workspaceDir, 'projects', 'proj-books', 'CLAUDE.md');

    expect(fs.readFileSync(researchMd, 'utf-8')).toContain('research');
    expect(fs.readFileSync(booksMd, 'utf-8')).toContain('book-reader');
  });

  it('should skip CLAUDE.md copy when packageDir is empty', () => {
    const workspaceDir = createTempDir('pm-ws-');
    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir: '',
      templatesConfig: {
        research: {},
      },
    };

    const pm = new ProjectManager(options);
    pm.init({ research: {} });

    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    // Directory should be created, but no CLAUDE.md
    const instanceDir = path.join(workspaceDir, 'projects', 'my-research');
    expect(fs.existsSync(instanceDir)).toBe(true);
    expect(fs.existsSync(path.join(instanceDir, 'CLAUDE.md'))).toBe(false);
  });

  it('should return error when template CLAUDE.md does not exist', () => {
    const workspaceDir = createTempDir('pm-ws-');
    const packageDir = createTempDir('pm-pkg-');

    // Create template directory but WITHOUT CLAUDE.md
    const templateDir = path.join(packageDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    // Note: no CLAUDE.md created

    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir,
      templatesConfig: { research: {} },
    };

    const pm = new ProjectManager(options);
    pm.init({ research: {} });

    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('模板文件不存在');
    }

    // Instance should NOT be in memory (rolled back)
    expect(pm.getActive('oc_chat1').name).toBe('default');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Rollback Mechanism
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — rollback on failure', () => {
  it('should remove created directory when CLAUDE.md copy fails', () => {
    const workspaceDir = createTempDir('pm-ws-');
    const packageDir = createTempDir('pm-pkg-');

    // Template dir exists but NO CLAUDE.md
    const templateDir = path.join(packageDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });

    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir,
      templatesConfig: { research: {} },
    };

    const pm = new ProjectManager(options);
    pm.init({ research: {} });

    const instanceDir = path.join(workspaceDir, 'projects', 'my-research');

    // Before create, dir should not exist
    expect(fs.existsSync(instanceDir)).toBe(false);

    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(false);

    // After failed create, dir should be cleaned up (rolled back)
    expect(fs.existsSync(instanceDir)).toBe(false);
  });

  it('should roll back in-memory instance on filesystem failure', () => {
    const workspaceDir = createTempDir('pm-ws-');
    const packageDir = createTempDir('pm-pkg-');

    // Template dir exists but NO CLAUDE.md
    const templateDir = path.join(packageDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });

    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir,
      templatesConfig: { research: {} },
    };

    const pm = new ProjectManager(options);
    pm.init({ research: {} });

    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(false);

    // In-memory state should be clean
    expect(pm.listInstances()).toHaveLength(0);
    expect(pm.getActive('oc_chat1').name).toBe('default');
  });

  it('should allow retrying create after filesystem failure', () => {
    const { workspaceDir, packageDir } = setupTestEnv({
      research: {},
    });

    // Temporarily remove CLAUDE.md to cause failure
    const claudeMdPath = path.join(packageDir, 'templates', 'research', 'CLAUDE.md');
    fs.renameSync(claudeMdPath, `${claudeMdPath}.bak`);

    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir,
      templatesConfig: { research: {} },
    };
    const pm = new ProjectManager(options);
    pm.init({ research: {} });

    // First attempt should fail
    const result1 = pm.create('oc_chat1', 'research', 'my-research');
    expect(result1.ok).toBe(false);

    // Restore CLAUDE.md
    fs.renameSync(`${claudeMdPath}.bak`, claudeMdPath);

    // Retry should succeed
    const result2 = pm.create('oc_chat1', 'research', 'my-research');
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.data.name).toBe('my-research');
    }
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Path Traversal Protection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — path traversal protection', () => {
  it('should reject instance name that resolves outside workspace', () => {
    const workspaceDir = createTempDir('pm-ws-');
    const packageDir = createTempDir('pm-pkg-');

    // Note: name validation already blocks "..", "/", "\" so direct path traversal
    // via name is blocked. But we test the extra resolve() check in instantiateFromTemplate.
    // Since names can't contain path separators, this test validates the defense-in-depth.

    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir,
      templatesConfig: { research: {} },
    };

    const pm = new ProjectManager(options);
    pm.init({ research: {} });

    // Names with ".." are already blocked by validateName()
    const result = pm.create('oc_chat1', 'research', '..');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('..');
    }
  });

  it('should reject names with path separators', () => {
    const { pm } = setupTestEnv({ research: {} });

    const result = pm.create('oc_chat1', 'research', '../escape');
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Integration: create() with filesystem
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — create() integration with filesystem', () => {
  it('should create instance with both directory and CLAUDE.md', () => {
    const { pm, workspaceDir } = setupTestEnv({
      research: { displayName: '研究模式' },
    });

    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('my-research');
      expect(result.data.templateName).toBe('research');
      expect(result.data.workingDir).toBe(
        path.join(workspaceDir, 'projects', 'my-research'),
      );
    }

    // Verify filesystem state
    const instanceDir = path.join(workspaceDir, 'projects', 'my-research');
    expect(fs.existsSync(instanceDir)).toBe(true);
    expect(fs.existsSync(path.join(instanceDir, 'CLAUDE.md'))).toBe(true);

    // Verify in-memory state
    expect(pm.getActive('oc_chat1').name).toBe('my-research');
  });

  it('should handle multiple creates successfully', () => {
    const { pm, workspaceDir } = setupTestEnv({
      research: {},
      'book-reader': {},
    });

    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat2', 'book-reader', 'project-b');
    pm.create('oc_chat3', 'research', 'project-c');

    expect(fs.existsSync(path.join(workspaceDir, 'projects', 'project-a'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'projects', 'project-b'))).toBe(true);
    expect(fs.existsSync(path.join(workspaceDir, 'projects', 'project-c'))).toBe(true);

    expect(pm.listInstances()).toHaveLength(3);
  });

  it('should preserve existing validation rules with filesystem enabled', () => {
    const { pm } = setupTestEnv({ research: {} });

    // Empty name
    const r1 = pm.create('oc_chat1', 'research', '');
    expect(r1.ok).toBe(false);

    // Reserved name
    const r2 = pm.create('oc_chat1', 'research', 'default');
    expect(r2.ok).toBe(false);

    // Non-existent template
    const r3 = pm.create('oc_chat1', 'nonexistent', 'my-project');
    expect(r3.ok).toBe(false);

    // Empty chatId
    const r4 = pm.create('', 'research', 'my-project');
    expect(r4.ok).toBe(false);

    // Duplicate name
    pm.create('oc_chat1', 'research', 'unique-name');
    const r5 = pm.create('oc_chat2', 'research', 'unique-name');
    expect(r5.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// instantiateFromTemplate() — direct call
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — instantiateFromTemplate() — direct', () => {
  it('should return error for non-existent instance', () => {
    const { pm } = setupTestEnv({ research: {} });

    const result = pm.instantiateFromTemplate('nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });
});

describe('ProjectManager — copyClaudeMd() — direct', () => {
  it('should return error for non-existent instance', () => {
    const { pm } = setupTestEnv({ research: {} });

    const result = pm.copyClaudeMd('nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });
});
