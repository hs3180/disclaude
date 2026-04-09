/**
 * Unit tests for ProjectManager — core logic for unified per-chatId Agent context switching.
 *
 * Tests use real temp directories for persistence validation.
 *
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 * @see Issue #2225 (Sub-Issue C — Persistence)
 * @see Issue #2226 (Sub-Issue D — Filesystem operations)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectManager } from './project-manager.js';
import type {
  ProjectManagerOptions,
  ProjectTemplatesConfig,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Temp dirs created during tests — cleaned up in afterEach */
const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Create expected path relative to workspace */
function wp(workspaceDir: string, ...segments: string[]): string {
  return path.join(workspaceDir, ...segments);
}

function createTestManager(
  templatesConfig?: ProjectTemplatesConfig,
): { pm: ProjectManager; workspaceDir: string } {
  const workspaceDir = createTempDir();
  const options: ProjectManagerOptions = {
    workspaceDir,
    packageDir: '',
    templatesConfig: templatesConfig ?? {},
  };
  const pm = new ProjectManager(options);
  pm.init(templatesConfig);
  return { pm, workspaceDir };
}

function createManagerWithTemplates(): { pm: ProjectManager; workspaceDir: string } {
  return createTestManager({
    research: {
      displayName: '研究模式',
      description: '专注研究的独立空间',
    },
    'book-reader': {
      displayName: '读书助手',
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
  tempDirs.length = 0;
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor & Initialization
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Constructor & Initialization', () => {
  it('should construct with valid options', () => {
    const { pm } = createManagerWithTemplates();
    expect(pm).toBeDefined();
  });

  it('should start with empty templates before init()', () => {
    const workspaceDir = createTempDir();
    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir: '/app/packages/core',
      templatesConfig: {},
    };
    const pm = new ProjectManager(options);
    // Not initialized — templates should be empty
    expect(pm.listTemplates()).toHaveLength(0);
  });

  it('should load templates from init() config', () => {
    const { pm } = createManagerWithTemplates();
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.map((t) => t.name)).toContain('research');
    expect(templates.map((t) => t.name)).toContain('book-reader');
  });

  it('should load template metadata (displayName, description)', () => {
    const { pm } = createManagerWithTemplates();
    const templates = pm.listTemplates();
    const research = templates.find((t) => t.name === 'research');
    expect(research?.displayName).toBe('研究模式');
    expect(research?.description).toBe('专注研究的独立空间');
  });

  it('should allow re-init to replace templates', () => {
    const { pm } = createManagerWithTemplates();
    expect(pm.listTemplates()).toHaveLength(2);

    pm.init({
      coding: { displayName: '编程模式' },
    });
    expect(pm.listTemplates()).toHaveLength(1);
    expect(pm.listTemplates()[0].name).toBe('coding');
  });

  it('should handle empty templates config', () => {
    const { pm } = createTestManager();
    expect(pm.listTemplates()).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getActive()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — getActive()', () => {
  it('should return default project for unbound chatId', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    const active = pm.getActive('oc_unbound');
    expect(active.name).toBe('default');
    expect(active.workingDir).toBe(workspaceDir);
    expect(active.templateName).toBeUndefined();
  });

  it('should return bound instance config', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('my-research');
    expect(active.templateName).toBe('research');
    expect(active.workingDir).toBe(wp(workspaceDir, 'projects', 'my-research'));
  });

  it('should self-heal stale binding (instance removed)', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'temp-project');
    expect(result.ok).toBe(true);

    // Remove the instance via delete to create stale binding
    pm.delete('temp-project');

    // Now oc_chat1 has a stale binding — getActive should self-heal
    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('default');
  });

  it('should handle multiple chatIds bound to same instance', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'shared-project');

    const useResult = pm.use('oc_chat2', 'shared-project');
    expect(useResult.ok).toBe(true);

    const active1 = pm.getActive('oc_chat1');
    const active2 = pm.getActive('oc_chat2');
    expect(active1.name).toBe('shared-project');
    expect(active2.name).toBe('shared-project');
    expect(active1.workingDir).toBe(active2.workingDir);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// create()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — create()', () => {
  it('should create instance from template and bind chatId', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'my-research');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('my-research');
      expect(result.data.templateName).toBe('research');
      expect(result.data.workingDir).toBe(wp(workspaceDir, 'projects', 'my-research'));
    }
  });

  it('should auto-bind chatId after creation', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');

    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('my-research');
  });

  it('should record createdAt timestamp', () => {
    const { pm } = createManagerWithTemplates();
    const before = new Date().toISOString();
    pm.create('oc_chat1', 'research', 'my-research');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].createdAt >= before).toBe(true);
  });

  // ── Input Validation: chatId ──

  it('should reject empty chatId', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('', 'research', 'my-project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatId');
    }
  });

  // ── Input Validation: name ──

  it('should reject reserved name "default"', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名');
    }
  });

  it('should reject empty name', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject name with ".."', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', '..');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('..');
    }
  });

  it('should reject name containing ".." segment', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'hello..world');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('..');
    }
  });

  it('should reject name with "/"', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'path/to/project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('/');
    }
  });

  it('should reject name with "\\"', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'path\\to');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('\\');
    }
  });

  it('should reject name with null byte', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'bad\x00name');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('空字节');
    }
  });

  it('should reject name exceeding 64 characters', () => {
    const { pm } = createManagerWithTemplates();
    const longName = 'a'.repeat(65);
    const result = pm.create('oc_chat1', 'research', longName);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('64');
    }
  });

  it('should accept name at exactly 64 characters', () => {
    const { pm } = createManagerWithTemplates();
    const name64 = 'a'.repeat(64);
    const result = pm.create('oc_chat1', 'research', name64);
    expect(result.ok).toBe(true);
  });

  it('should reject whitespace-only name', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', '   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('空白');
    }
  });

  // ── Input Validation: templateName ──

  it('should reject non-existent template', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'nonexistent', 'my-project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  // ── Duplicate Prevention ──

  it('should reject duplicate instance name', () => {
    const { pm } = createManagerWithTemplates();
    const result1 = pm.create('oc_chat1', 'research', 'my-project');
    expect(result1.ok).toBe(true);

    const result2 = pm.create('oc_chat2', 'research', 'my-project');
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.error).toContain('已存在');
    }
  });

  // ── Rebinding ──

  it('should allow same chatId to create different instances (rebinding)', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    const result = pm.create('oc_chat1', 'book-reader', 'project-b');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('project-b');
    }

    // chatId should now be bound to project-b
    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('project-b');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// use()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — use()', () => {
  it('should bind chatId to existing instance', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'shared-project');

    const result = pm.use('oc_chat2', 'shared-project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('shared-project');
    }
  });

  it('should reject using "default" name', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.use('oc_chat1', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名');
      expect(result.error).toContain('reset');
    }
  });

  it('should reject non-existent instance', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.use('oc_chat1', 'nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should reject empty chatId', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');

    const result = pm.use('', 'project-a');
    expect(result.ok).toBe(false);
  });

  it('should reject empty name', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.use('oc_chat1', '');
    expect(result.ok).toBe(false);
  });

  it('should allow rebinding chatId to different instance', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat1', 'book-reader', 'project-b');

    const result = pm.use('oc_chat1', 'project-a');
    expect(result.ok).toBe(true);

    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('project-a');
  });

  it('should support multiple chatIds binding to same instance', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'shared-project');

    pm.use('oc_chat2', 'shared-project');
    pm.use('oc_chat3', 'shared-project');

    expect(pm.getActive('oc_chat1').name).toBe('shared-project');
    expect(pm.getActive('oc_chat2').name).toBe('shared-project');
    expect(pm.getActive('oc_chat3').name).toBe('shared-project');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// reset()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — reset()', () => {
  it('should unbind chatId and return default', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-project');

    const result = pm.reset('oc_chat1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('default');
      expect(result.data.workingDir).toBe(workspaceDir);
    }

    // Verify unbound
    expect(pm.getActive('oc_chat1').name).toBe('default');
  });

  it('should be silent no-op when already on default', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.reset('oc_unbound');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('default');
    }
  });

  it('should reject empty chatId', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.reset('');
    expect(result.ok).toBe(false);
  });

  it('should not affect other chatIds bound to same instance', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'shared-project');
    pm.use('oc_chat2', 'shared-project');

    pm.reset('oc_chat1');

    // chat1 should be on default
    expect(pm.getActive('oc_chat1').name).toBe('default');
    // chat2 should still be bound
    expect(pm.getActive('oc_chat2').name).toBe('shared-project');
  });

  it('should allow re-binding after reset', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.reset('oc_chat1');
    pm.create('oc_chat1', 'book-reader', 'project-b');

    expect(pm.getActive('oc_chat1').name).toBe('project-b');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listTemplates()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — listTemplates()', () => {
  it('should return all loaded templates', () => {
    const { pm } = createManagerWithTemplates();
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
  });

  it('should include template metadata', () => {
    const { pm } = createManagerWithTemplates();
    const templates = pm.listTemplates();
    const research = templates.find((t) => t.name === 'research');
    expect(research).toBeDefined();
    expect(research!.displayName).toBe('研究模式');
    expect(research!.description).toBe('专注研究的独立空间');

    const bookReader = templates.find((t) => t.name === 'book-reader');
    expect(bookReader).toBeDefined();
    expect(bookReader!.displayName).toBe('读书助手');
    expect(bookReader!.description).toBeUndefined();
  });

  it('should return empty array when no templates configured', () => {
    const { pm } = createTestManager();
    expect(pm.listTemplates()).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listInstances()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — listInstances()', () => {
  it('should return empty array when no instances created', () => {
    const { pm } = createManagerWithTemplates();
    expect(pm.listInstances()).toHaveLength(0);
  });

  it('should list created instances with bindings', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe('my-research');
    expect(instances[0].templateName).toBe('research');
    expect(instances[0].chatIds).toContain('oc_chat1');
    expect(instances[0].workingDir).toBe(wp(workspaceDir, 'projects', 'my-research'));
  });

  it('should not include default in instance list', () => {
    const { pm } = createManagerWithTemplates();
    expect(pm.listInstances()).toHaveLength(0);
    // Even after getActive returns default
    pm.getActive('oc_chat1');
    expect(pm.listInstances()).toHaveLength(0);
  });

  it('should track multiple bindings per instance', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'shared-project');
    pm.use('oc_chat2', 'shared-project');
    pm.use('oc_chat3', 'shared-project');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].chatIds).toHaveLength(3);
    expect(instances[0].chatIds).toContain('oc_chat1');
    expect(instances[0].chatIds).toContain('oc_chat2');
    expect(instances[0].chatIds).toContain('oc_chat3');
  });

  it('should show empty chatIds for unbound instance', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.reset('oc_chat1');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].chatIds).toHaveLength(0);
  });

  it('should list multiple instances', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat2', 'book-reader', 'project-b');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(2);
    const names = instances.map((i) => i.name);
    expect(names).toContain('project-a');
    expect(names).toContain('project-b');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProvider()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — createCwdProvider()', () => {
  it('should return undefined for default project', () => {
    const { pm } = createManagerWithTemplates();
    const provider = pm.createCwdProvider();
    expect(provider('oc_unbound')).toBeUndefined();
  });

  it('should return workingDir for bound project', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');

    const provider = pm.createCwdProvider();
    expect(provider('oc_chat1')).toBe(wp(workspaceDir, 'projects', 'my-research'));
  });

  it('should return undefined after reset to default', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');
    pm.reset('oc_chat1');

    const provider = pm.createCwdProvider();
    expect(provider('oc_chat1')).toBeUndefined();
  });

  it('should reflect dynamic binding changes', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat1', 'book-reader', 'project-b');

    const provider = pm.createCwdProvider();
    expect(provider('oc_chat1')).toBe(wp(workspaceDir, 'projects', 'project-b'));

    pm.use('oc_chat1', 'project-a');
    expect(provider('oc_chat1')).toBe(wp(workspaceDir, 'projects', 'project-a'));
  });

  it('should be a closure — works independently after creation', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');

    const provider = pm.createCwdProvider();

    // Even though provider is detached from pm variable, it should work
    expect(provider('oc_chat1')).toBe(wp(workspaceDir, 'projects', 'my-research'));
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Path Traversal Protection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Path Traversal Protection', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    ({ pm } = createManagerWithTemplates());
  });

  it('should reject "../../../etc/passwd"', () => {
    const result = pm.create('oc_chat1', 'research', '../../../etc/passwd');
    expect(result.ok).toBe(false);
  });

  it('should reject ".." as name', () => {
    const result = pm.create('oc_chat1', 'research', '..');
    expect(result.ok).toBe(false);
  });

  it('should reject name containing ".."', () => {
    const result = pm.create('oc_chat1', 'research', 'hello..world');
    expect(result.ok).toBe(false);
  });

  it('should reject name with forward slash', () => {
    const result = pm.create('oc_chat1', 'research', 'path/to/project');
    expect(result.ok).toBe(false);
  });

  it('should reject name with backslash', () => {
    const result = pm.create('oc_chat1', 'research', 'path\\to');
    expect(result.ok).toBe(false);
  });

  it('should reject name with null byte', () => {
    const result = pm.create('oc_chat1', 'research', 'bad\x00name');
    expect(result.ok).toBe(false);
  });

  it('should reject name with ".." even when URL-encoded path separators are present', () => {
    const result = pm.create('oc_chat1', 'research', '..%2F..%2Fetc');
    // Contains ".." which is always rejected regardless of encoding
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('..');
    }
  });

  it('should allow valid hyphenated names', () => {
    const result = pm.create('oc_chat1', 'research', 'my-research-project');
    expect(result.ok).toBe(true);
  });

  it('should allow names with underscores', () => {
    const result = pm.create('oc_chat1', 'research', 'my_research_project');
    expect(result.ok).toBe(true);
  });

  it('should allow names with numbers', () => {
    const result = pm.create('oc_chat1', 'research', 'project123');
    expect(result.ok).toBe(true);
  });

  it('should allow Chinese characters in names', () => {
    const result = pm.create('oc_chat1', 'research', '我的研究项目');
    expect(result.ok).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// "default" Name Interception
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — "default" Name Protection', () => {
  let pm: ProjectManager;
  let workspaceDir: string;

  beforeEach(() => {
    ({ pm, workspaceDir } = createManagerWithTemplates());
  });

  it('should reject "default" in create()', () => {
    const result = pm.create('oc_chat1', 'research', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名');
    }
  });

  it('should reject "default" in use()', () => {
    const result = pm.use('oc_chat1', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名');
      expect(result.error).toContain('reset');
    }
  });

  it('should always return default project from getActive() when unbound', () => {
    const active = pm.getActive('oc_any');
    expect(active.name).toBe('default');
    expect(active.workingDir).toBe(workspaceDir);
    expect(active.templateName).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Integration Scenarios
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Integration Scenarios', () => {
  it('should handle full lifecycle: create → use → reset', () => {
    const { pm } = createManagerWithTemplates();

    // Step 1: Create
    const createResult = pm.create('oc_chat1', 'research', 'my-project');
    expect(createResult.ok).toBe(true);

    // Step 2: Verify binding
    expect(pm.getActive('oc_chat1').name).toBe('my-project');

    // Step 3: Another chat binds to same instance
    const useResult = pm.use('oc_chat2', 'my-project');
    expect(useResult.ok).toBe(true);
    expect(pm.getActive('oc_chat2').name).toBe('my-project');

    // Step 4: First chat resets
    pm.reset('oc_chat1');
    expect(pm.getActive('oc_chat1').name).toBe('default');
    expect(pm.getActive('oc_chat2').name).toBe('my-project');

    // Step 5: List instances
    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].chatIds).toEqual(['oc_chat2']);
  });

  it('should handle switching between projects', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'research-a');
    pm.create('oc_chat2', 'book-reader', 'book-b');

    // Chat1 switches to book
    pm.use('oc_chat1', 'book-b');
    expect(pm.getActive('oc_chat1').name).toBe('book-b');
    expect(pm.getActive('oc_chat1').templateName).toBe('book-reader');

    // Chat1 switches back to research
    pm.use('oc_chat1', 'research-a');
    expect(pm.getActive('oc_chat1').name).toBe('research-a');
    expect(pm.getActive('oc_chat1').templateName).toBe('research');
  });

  it('should handle CwdProvider across multiple chats', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat2', 'book-reader', 'project-b');

    const provider = pm.createCwdProvider();
    expect(provider('oc_chat1')).toBe(wp(workspaceDir, 'projects', 'project-a'));
    expect(provider('oc_chat2')).toBe(wp(workspaceDir, 'projects', 'project-b'));
    expect(provider('oc_unbound')).toBeUndefined();
  });

  it('should handle empty template config gracefully', () => {
    const { pm } = createTestManager();
    expect(pm.listTemplates()).toHaveLength(0);
    expect(pm.listInstances()).toHaveLength(0);
    expect(pm.getActive('oc_any').name).toBe('default');

    // Cannot create any instances without templates
    const result = pm.create('oc_chat1', 'research', 'project-a');
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence — persist()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Persistence (persist)', () => {
  it('should create .disclaude/projects.json on first create()', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-project');

    const filePath = path.join(workspaceDir, '.disclaude', 'projects.json');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('should persist instance data after create()', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');

    const filePath = path.join(workspaceDir, '.disclaude', 'projects.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(data.instances['my-research']).toBeDefined();
    expect(data.instances['my-research'].name).toBe('my-research');
    expect(data.instances['my-research'].templateName).toBe('research');
    expect(data.instances['my-research'].workingDir).toBe(
      wp(workspaceDir, 'projects', 'my-research'),
    );
    expect(data.instances['my-research'].createdAt).toBeDefined();
  });

  it('should persist chatProjectMap after create()', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');

    const filePath = path.join(workspaceDir, '.disclaude', 'projects.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(data.chatProjectMap['oc_chat1']).toBe('my-research');
  });

  it('should persist after use()', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'shared-project');
    pm.use('oc_chat2', 'shared-project');

    const filePath = path.join(workspaceDir, '.disclaude', 'projects.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(data.chatProjectMap['oc_chat1']).toBe('shared-project');
    expect(data.chatProjectMap['oc_chat2']).toBe('shared-project');
  });

  it('should persist after reset()', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-project');
    pm.reset('oc_chat1');

    const filePath = path.join(workspaceDir, '.disclaude', 'projects.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    expect(data.chatProjectMap['oc_chat1']).toBeUndefined();
    // Instance still exists (only binding removed)
    expect(data.instances['my-project']).toBeDefined();
  });

  it('should use atomic write (no intermediate .tmp file on success)', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-project');

    const tmpPath = path.join(workspaceDir, '.disclaude', 'projects.json.tmp');
    expect(fs.existsSync(tmpPath)).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence — loadPersistedData()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Persistence (loadPersistedData)', () => {
  it('should succeed silently when no persistence file exists', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(true);
  });

  it('should restore instances from persistence file', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');

    // Create a new manager and load persisted data
    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });
    pm2.init();
    const loadResult = pm2.loadPersistedData();
    expect(loadResult.ok).toBe(true);

    // Verify instance restored
    const instances = pm2.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe('my-research');
    expect(instances[0].templateName).toBe('research');
  });

  it('should restore chatProjectMap from persistence file', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');
    pm.use('oc_chat2', 'my-research');

    // Create a new manager and load
    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });
    pm2.init();
    pm2.loadPersistedData();

    // Verify bindings restored
    expect(pm2.getActive('oc_chat1').name).toBe('my-research');
    expect(pm2.getActive('oc_chat2').name).toBe('my-research');
    expect(pm2.getActive('oc_unbound').name).toBe('default');
  });

  it('should handle corrupt JSON gracefully', () => {
    const { workspaceDir } = createManagerWithTemplates();
    // Write corrupt data
    const disclaudeDir = path.join(workspaceDir, '.disclaude');
    fs.mkdirSync(disclaudeDir, { recursive: true });
    fs.writeFileSync(path.join(disclaudeDir, 'projects.json'), '{invalid json}', 'utf8');

    const pm = new ProjectManager({
      workspaceDir,
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });
    pm.init();
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('解析失败');
    }
  });

  it('should handle missing instances field', () => {
    const { workspaceDir } = createManagerWithTemplates();
    const disclaudeDir = path.join(workspaceDir, '.disclaude');
    fs.mkdirSync(disclaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(disclaudeDir, 'projects.json'),
      JSON.stringify({ chatProjectMap: {} }),
      'utf8',
    );

    const pm = new ProjectManager({
      workspaceDir,
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });
    pm.init();
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('instances');
    }
  });

  it('should handle missing chatProjectMap field', () => {
    const { workspaceDir } = createManagerWithTemplates();
    const disclaudeDir = path.join(workspaceDir, '.disclaude');
    fs.mkdirSync(disclaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(disclaudeDir, 'projects.json'),
      JSON.stringify({ instances: {} }),
      'utf8',
    );

    const pm = new ProjectManager({
      workspaceDir,
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });
    pm.init();
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatProjectMap');
    }
  });

  it('should handle instance with invalid workingDir', () => {
    const { workspaceDir } = createManagerWithTemplates();
    const disclaudeDir = path.join(workspaceDir, '.disclaude');
    fs.mkdirSync(disclaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(disclaudeDir, 'projects.json'),
      JSON.stringify({
        instances: {
          'bad-instance': {
            name: 'bad-instance',
            templateName: 'research',
            workingDir: 123, // not a string
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
        chatProjectMap: {},
      }),
      'utf8',
    );

    const pm = new ProjectManager({
      workspaceDir,
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });
    pm.init();
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('workingDir');
    }
  });

  it('should handle instance with missing createdAt', () => {
    const { workspaceDir } = createManagerWithTemplates();
    const disclaudeDir = path.join(workspaceDir, '.disclaude');
    fs.mkdirSync(disclaudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(disclaudeDir, 'projects.json'),
      JSON.stringify({
        instances: {
          'bad-instance': {
            name: 'bad-instance',
            templateName: 'research',
            workingDir: '/workspace/projects/bad-instance',
            // missing createdAt
          },
        },
        chatProjectMap: {},
      }),
      'utf8',
    );

    const pm = new ProjectManager({
      workspaceDir,
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });
    pm.init();
    const result = pm.loadPersistedData();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('createdAt');
    }
  });

  it('should clear existing data before loading', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'old-project');

    // Write different data to the file
    const disclaudeDir = path.join(workspaceDir, '.disclaude');
    fs.writeFileSync(
      path.join(disclaudeDir, 'projects.json'),
      JSON.stringify({
        instances: {
          'new-project': {
            name: 'new-project',
            templateName: 'book-reader',
            workingDir: wp(workspaceDir, 'projects', 'new-project'),
            createdAt: '2024-01-01T00:00:00.000Z',
          },
        },
        chatProjectMap: { oc_chat2: 'new-project' },
      }),
      'utf8',
    );

    pm.loadPersistedData();

    // Old instance should be gone
    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe('new-project');
  });

  it('should persist then reload preserves full state', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();

    // Create multiple instances with bindings
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat2', 'book-reader', 'project-b');
    pm.use('oc_chat3', 'project-a');

    // Create new manager and reload
    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });
    pm2.init();
    pm2.loadPersistedData();

    // Verify full state
    expect(pm2.listInstances()).toHaveLength(2);
    expect(pm2.getActive('oc_chat1').name).toBe('project-a');
    expect(pm2.getActive('oc_chat2').name).toBe('project-b');
    expect(pm2.getActive('oc_chat3').name).toBe('project-a');
    expect(pm2.getActive('oc_unbound').name).toBe('default');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence — delete()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Persistence (delete)', () => {
  it('should delete instance from memory and persistence', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'to-delete');
    pm.delete('to-delete');

    // Memory check
    expect(pm.listInstances()).toHaveLength(0);

    // Persistence check
    const filePath = path.join(workspaceDir, '.disclaude', 'projects.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(data.instances['to-delete']).toBeUndefined();
  });

  it('should remove all bindings when deleting instance', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'shared');
    pm.use('oc_chat2', 'shared');
    pm.use('oc_chat3', 'shared');

    pm.delete('shared');

    // All bindings should be removed
    expect(pm.getActive('oc_chat1').name).toBe('default');
    expect(pm.getActive('oc_chat2').name).toBe('default');
    expect(pm.getActive('oc_chat3').name).toBe('default');

    // Persistence check
    const filePath = path.join(workspaceDir, '.disclaude', 'projects.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(data.chatProjectMap['oc_chat1']).toBeUndefined();
    expect(data.chatProjectMap['oc_chat2']).toBeUndefined();
    expect(data.chatProjectMap['oc_chat3']).toBeUndefined();
  });

  it('should not affect other instances when deleting', () => {
    const { pm } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat2', 'book-reader', 'project-b');

    pm.delete('project-a');

    expect(pm.listInstances()).toHaveLength(1);
    expect(pm.getActive('oc_chat2').name).toBe('project-b');
  });

  it('should reject deleting non-existent instance', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.delete('nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should reject deleting "default"', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.delete('default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名');
    }
  });

  it('should reject deleting with empty name', () => {
    const { pm } = createManagerWithTemplates();
    const result = pm.delete('');
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence — Rollback on persist failure
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Persistence Rollback', () => {
  it('should rollback create() when persist fails', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'first-project');

    // Make .disclaude directory read-only to cause persist failure
    const disclaudeDir = path.join(workspaceDir, '.disclaude');
    fs.chmodSync(disclaudeDir, 0o444);

    const result = pm.create('oc_chat2', 'research', 'second-project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('持久化失败');
    }

    // Rollback: instance should NOT exist in memory
    const instances = pm.listInstances();
    expect(instances.find((i) => i.name === 'second-project')).toBeUndefined();

    // chatId should not be bound to the failed instance
    expect(pm.getActive('oc_chat2').name).toBe('default');

    // Restore permissions for cleanup
    fs.chmodSync(disclaudeDir, 0o755);
  });

  it('should rollback use() when persist fails', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat1', 'research', 'project-b');

    // Make .disclaude directory read-only
    const disclaudeDir = path.join(workspaceDir, '.disclaude');
    fs.chmodSync(disclaudeDir, 0o444);

    const result = pm.use('oc_chat1', 'project-a');
    expect(result.ok).toBe(false);

    // Rollback: chatId should still be bound to project-b
    expect(pm.getActive('oc_chat1').name).toBe('project-b');

    fs.chmodSync(disclaudeDir, 0o755);
  });

  it('should rollback reset() when persist fails', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-project');

    // Make .disclaude directory read-only
    const disclaudeDir = path.join(workspaceDir, '.disclaude');
    fs.chmodSync(disclaudeDir, 0o444);

    const result = pm.reset('oc_chat1');
    expect(result.ok).toBe(false);

    // Rollback: chatId should still be bound to my-project
    expect(pm.getActive('oc_chat1').name).toBe('my-project');

    fs.chmodSync(disclaudeDir, 0o755);
  });

  it('should rollback delete() when persist fails', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-project');
    pm.use('oc_chat2', 'my-project');

    // Make .disclaude directory read-only
    const disclaudeDir = path.join(workspaceDir, '.disclaude');
    fs.chmodSync(disclaudeDir, 0o444);

    const result = pm.delete('my-project');
    expect(result.ok).toBe(false);

    // Rollback: instance and bindings should still exist
    expect(pm.listInstances()).toHaveLength(1);
    expect(pm.getActive('oc_chat1').name).toBe('my-project');
    expect(pm.getActive('oc_chat2').name).toBe('my-project');

    fs.chmodSync(disclaudeDir, 0o755);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Persistence — Self-healing persistence
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Self-healing Persistence', () => {
  it('should persist stale binding cleanup via getActive()', () => {
    const { pm, workspaceDir } = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'temp-project');

    // Delete the instance (removes from memory + persists)
    pm.delete('temp-project');

    // Manually re-add a stale binding (simulating race condition)
    // We do this by writing directly to the file
    const filePath = path.join(workspaceDir, '.disclaude', 'projects.json');
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    data.chatProjectMap['oc_chat1'] = 'temp-project'; // stale!
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

    // Reload from file
    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir: '/app/packages/core',
      templatesConfig: {},
    });
    pm2.init();
    pm2.loadPersistedData();

    // getActive should self-heal the stale binding
    const active = pm2.getActive('oc_chat1');
    expect(active.name).toBe('default');

    // The self-healed state should be persisted
    const updatedData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(updatedData.chatProjectMap['oc_chat1']).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Filesystem Operations (Sub-Issue D — #2226)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Filesystem Operations (#2226)', () => {
  /**
   * Helper: create a manager with a real packageDir containing template CLAUDE.md files.
   */
  function createManagerWithPackageDir(): {
    pm: ProjectManager;
    workspaceDir: string;
    packageDir: string;
  } {
    const workspaceDir = createTempDir();
    const packageDir = createTempDir();

    // Create template CLAUDE.md files
    const researchTemplateDir = path.join(packageDir, 'templates', 'research');
    fs.mkdirSync(researchTemplateDir, { recursive: true });
    fs.writeFileSync(
      path.join(researchTemplateDir, 'CLAUDE.md'),
      '# Research Mode\nYou are in research mode.',
      'utf8',
    );

    const bookTemplateDir = path.join(packageDir, 'templates', 'book-reader');
    fs.mkdirSync(bookTemplateDir, { recursive: true });
    fs.writeFileSync(
      path.join(bookTemplateDir, 'CLAUDE.md'),
      '# Book Reader\nYou are a book reading assistant.',
      'utf8',
    );

    const templatesConfig: ProjectTemplatesConfig = {
      research: { displayName: '研究模式' },
      'book-reader': { displayName: '读书助手' },
    };

    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir,
      templatesConfig,
    };
    const pm = new ProjectManager(options);
    pm.init(templatesConfig);

    return { pm, workspaceDir, packageDir };
  }

  // ── Working Directory Creation ──

  it('should create working directory under {workspace}/projects/{name}', () => {
    const { pm, workspaceDir } = createManagerWithPackageDir();
    const result = pm.create('oc_chat1', 'research', 'my-research');

    expect(result.ok).toBe(true);
    const expectedDir = wp(workspaceDir, 'projects', 'my-research');
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.statSync(expectedDir).isDirectory()).toBe(true);
  });

  it('should create projects/ subdirectory if it does not exist', () => {
    const { pm, workspaceDir } = createManagerWithPackageDir();
    // projects/ dir should not exist initially
    expect(fs.existsSync(wp(workspaceDir, 'projects'))).toBe(false);

    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    // Now projects/ should exist
    expect(fs.existsSync(wp(workspaceDir, 'projects'))).toBe(true);
  });

  // ── CLAUDE.md Copy ──

  it('should copy CLAUDE.md from template to working directory', () => {
    const { pm, workspaceDir } = createManagerWithPackageDir();
    pm.create('oc_chat1', 'research', 'my-research');

    const claudeMdPath = wp(workspaceDir, 'projects', 'my-research', 'CLAUDE.md');
    expect(fs.existsSync(claudeMdPath)).toBe(true);
    const content = fs.readFileSync(claudeMdPath, 'utf8');
    expect(content).toBe('# Research Mode\nYou are in research mode.');
  });

  it('should copy correct CLAUDE.md for different templates', () => {
    const { pm, workspaceDir } = createManagerWithPackageDir();
    pm.create('oc_chat1', 'research', 'my-research');
    pm.create('oc_chat2', 'book-reader', 'my-books');

    const researchMd = wp(workspaceDir, 'projects', 'my-research', 'CLAUDE.md');
    const bookMd = wp(workspaceDir, 'projects', 'my-books', 'CLAUDE.md');

    expect(fs.readFileSync(researchMd, 'utf8')).toContain('Research Mode');
    expect(fs.readFileSync(bookMd, 'utf8')).toContain('Book Reader');
  });

  // ── packageDir Not Configured ──

  it('should create instance without CLAUDE.md when packageDir has no templates dir', () => {
    const workspaceDir = createTempDir();
    const packageDir = createTempDir();
    // No templates/ subdirectory at all — but packageDir is set
    // This should fail because template CLAUDE.md doesn't exist
    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir,
      templatesConfig: { research: { displayName: '研究模式' } },
    };
    const pm = new ProjectManager(options);
    pm.init({ research: { displayName: '研究模式' } });

    const result = pm.create('oc_chat1', 'research', 'no-claude-md');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CLAUDE.md');
    }
  });

  it('should skip CLAUDE.md copy when packageDir is not configured', () => {
    const workspaceDir = createTempDir();
    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir: '',
      templatesConfig: { research: {} },
    };
    const pm = new ProjectManager(options);
    pm.init({ research: {} });

    const result = pm.create('oc_chat1', 'research', 'no-pkg-dir');
    expect(result.ok).toBe(true);

    const workingDir = wp(workspaceDir, 'projects', 'no-pkg-dir');
    expect(fs.existsSync(workingDir)).toBe(true);
    expect(fs.existsSync(wp(workingDir, 'CLAUDE.md'))).toBe(false);
  });

  // ── Template CLAUDE.md Not Found ──

  it('should fail if template CLAUDE.md does not exist in packageDir', () => {
    const workspaceDir = createTempDir();
    const packageDir = createTempDir();
    // Create templates dir but no CLAUDE.md for 'research'
    fs.mkdirSync(path.join(packageDir, 'templates', 'research'), { recursive: true });

    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir,
      templatesConfig: { research: {} },
    };
    const pm = new ProjectManager(options);
    pm.init({ research: {} });

    const result = pm.create('oc_chat1', 'research', 'missing-claude');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('CLAUDE.md');
    }

    // Directory should be cleaned up on rollback
    const expectedDir = wp(workspaceDir, 'projects', 'missing-claude');
    expect(fs.existsSync(expectedDir)).toBe(false);
  });

  // ── Rollback ──

  it('should rollback directory if CLAUDE.md copy fails', () => {
    const workspaceDir = createTempDir();
    const packageDir = createTempDir();
    // Create templates dir but make CLAUDE.md a directory (will cause copyFileSync to fail)
    const templateDir = path.join(packageDir, 'templates', 'research');
    fs.mkdirSync(templateDir, { recursive: true });
    fs.mkdirSync(path.join(templateDir, 'CLAUDE.md')); // directory instead of file

    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir,
      templatesConfig: { research: {} },
    };
    const pm = new ProjectManager(options);
    pm.init({ research: {} });

    const result = pm.create('oc_chat1', 'research', 'rollback-test');
    expect(result.ok).toBe(false);

    // Directory should be cleaned up
    const expectedDir = wp(workspaceDir, 'projects', 'rollback-test');
    expect(fs.existsSync(expectedDir)).toBe(false);

    // Instance should not be in memory
    const instances = pm.listInstances();
    expect(instances).toHaveLength(0);
  });

  // ── Path Traversal Protection ──

  it('should reject path traversal in working directory via name validation', () => {
    const { pm } = createManagerWithPackageDir();

    const result = pm.create('oc_chat1', 'research', '..');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('..');
    }
  });

  it('should reject name with path separator characters', () => {
    const { pm } = createManagerWithPackageDir();

    const result = pm.create('oc_chat1', 'research', 'evil/path');
    expect(result.ok).toBe(false);
  });

  // ── Multiple Instances ──

  it('should create separate working directories for different instances', () => {
    const { pm, workspaceDir } = createManagerWithPackageDir();

    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat2', 'book-reader', 'project-b');

    expect(fs.existsSync(wp(workspaceDir, 'projects', 'project-a'))).toBe(true);
    expect(fs.existsSync(wp(workspaceDir, 'projects', 'project-b'))).toBe(true);

    // Each should have its own CLAUDE.md
    expect(fs.readFileSync(wp(workspaceDir, 'projects', 'project-a', 'CLAUDE.md'), 'utf8'))
      .toContain('Research Mode');
    expect(fs.readFileSync(wp(workspaceDir, 'projects', 'project-b', 'CLAUDE.md'), 'utf8'))
      .toContain('Book Reader');
  });

  // ── Integration with existing methods ──

  it('should persist instance after successful filesystem creation', () => {
    const { pm, workspaceDir } = createManagerWithPackageDir();
    pm.create('oc_chat1', 'research', 'persisted-instance');

    // Verify persistence file exists
    const persistPath = wp(workspaceDir, '.disclaude', 'projects.json');
    expect(fs.existsSync(persistPath)).toBe(true);

    const data = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    expect(data.instances['persisted-instance']).toBeDefined();
    expect(data.instances['persisted-instance'].templateName).toBe('research');
  });

  it('should work with use() after create() with filesystem ops', () => {
    const { pm, workspaceDir } = createManagerWithPackageDir();
    pm.create('oc_chat1', 'research', 'shared-proj');

    // Another chatId uses the same instance
    const useResult = pm.use('oc_chat2', 'shared-proj');
    expect(useResult.ok).toBe(true);

    const active = pm.getActive('oc_chat2');
    expect(active.name).toBe('shared-proj');
    expect(active.workingDir).toBe(wp(workspaceDir, 'projects', 'shared-proj'));
  });

  it('should create working directory even if persisted data is loaded from previous session', () => {
    const { pm, workspaceDir, packageDir } = createManagerWithPackageDir();

    // First session: create an instance
    pm.create('oc_chat1', 'research', 'first-instance');

    // Simulate new session: load persisted data
    const pm2 = new ProjectManager({
      workspaceDir,
      packageDir,
      templatesConfig: { research: { displayName: '研究模式' } },
    });
    pm2.init({ research: { displayName: '研究模式' } });
    pm2.loadPersistedData();

    // Create another instance in new session
    const result = pm2.create('oc_chat2', 'research', 'second-instance');
    expect(result.ok).toBe(true);

    // Both directories should exist
    expect(fs.existsSync(wp(workspaceDir, 'projects', 'first-instance'))).toBe(true);
    expect(fs.existsSync(wp(workspaceDir, 'projects', 'second-instance'))).toBe(true);
  });
});
