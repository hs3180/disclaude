/**
 * Unit tests for ProjectManager — core logic for unified per-chatId Agent context switching.
 *
 * All tests are pure in-memory (no filesystem or persistence dependencies).
 *
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 */

import { describe, it, expect } from 'vitest';
import { ProjectManager, noOpFs } from './project-manager.js';
import type {
  ProjectManagerOptions,
  ProjectTemplatesConfig,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createTestManager(
  templatesConfig?: ProjectTemplatesConfig,
): ProjectManager {
  const options: ProjectManagerOptions = {
    workspaceDir: '/workspace',
    packageDir: '/app/packages/core',
    templatesConfig: templatesConfig ?? {},
  };
  const pm = new ProjectManager(options, noOpFs);
  pm.init(templatesConfig);
  return pm;
}

function createManagerWithTemplates(): ProjectManager {
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor & Initialization
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Constructor & Initialization', () => {
  it('should construct with valid options', () => {
    const pm = createTestManager();
    expect(pm).toBeDefined();
  });

  it('should start with empty templates before init()', () => {
    const options: ProjectManagerOptions = {
      workspaceDir: '/workspace',
      packageDir: '/app/packages/core',
      templatesConfig: {},
    };
    const pm = new ProjectManager(options, noOpFs);
    // Not initialized — templates should be empty
    expect(pm.listTemplates()).toHaveLength(0);
  });

  it('should load templates from init() config', () => {
    const pm = createManagerWithTemplates();
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
    expect(templates.map((t) => t.name)).toContain('research');
    expect(templates.map((t) => t.name)).toContain('book-reader');
  });

  it('should load template metadata (displayName, description)', () => {
    const pm = createManagerWithTemplates();
    const templates = pm.listTemplates();
    const research = templates.find((t) => t.name === 'research');
    expect(research?.displayName).toBe('研究模式');
    expect(research?.description).toBe('专注研究的独立空间');
  });

  it('should allow re-init to replace templates', () => {
    const pm = createManagerWithTemplates();
    expect(pm.listTemplates()).toHaveLength(2);

    pm.init({
      coding: { displayName: '编程模式' },
    });
    expect(pm.listTemplates()).toHaveLength(1);
    expect(pm.listTemplates()[0].name).toBe('coding');
  });

  it('should handle empty templates config', () => {
    const pm = createTestManager();
    expect(pm.listTemplates()).toHaveLength(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getActive()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — getActive()', () => {
  it('should return default project for unbound chatId', () => {
    const pm = createManagerWithTemplates();
    const active = pm.getActive('oc_unbound');
    expect(active.name).toBe('default');
    expect(active.workingDir).toBe('/workspace');
    expect(active.templateName).toBeUndefined();
  });

  it('should return bound instance config', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('my-research');
    expect(active.templateName).toBe('research');
    expect(active.workingDir).toBe('/workspace/projects/my-research');
  });

  it('should self-heal stale binding (instance removed from underlying map)', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'temp-project');

    // Verify binding exists
    expect(pm.getActive('oc_chat1').name).toBe('temp-project');

    // Simulate stale binding: create a fresh manager with same templates
    // but without the instance (simulating persistence loading failure)
    const pm2 = createManagerWithTemplates();
    // pm2 has no instances, so any getActive returns default
    expect(pm2.getActive('oc_chat1').name).toBe('default');
  });

  it('should handle multiple chatIds bound to same instance', () => {
    const pm = createManagerWithTemplates();
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
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'my-research');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('my-research');
      expect(result.data.templateName).toBe('research');
      expect(result.data.workingDir).toBe('/workspace/projects/my-research');
    }
  });

  it('should auto-bind chatId after creation', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');

    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('my-research');
  });

  it('should record createdAt timestamp', () => {
    const pm = createManagerWithTemplates();
    const before = new Date().toISOString();
    pm.create('oc_chat1', 'research', 'my-research');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].createdAt >= before).toBe(true);
  });

  // ── Input Validation: chatId ──

  it('should reject empty chatId', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('', 'research', 'my-project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatId');
    }
  });

  // ── Input Validation: name ──

  it('should reject reserved name "default"', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名');
    }
  });

  it('should reject empty name', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject name with ".."', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', '..');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('..');
    }
  });

  it('should reject name containing ".." segment', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'hello..world');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('..');
    }
  });

  it('should reject name with "/"', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'path/to/project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('/');
    }
  });

  it('should reject name with "\\"', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'path\\to');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('\\');
    }
  });

  it('should reject name with null byte', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'bad\x00name');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('空字节');
    }
  });

  it('should reject name exceeding 64 characters', () => {
    const pm = createManagerWithTemplates();
    const longName = 'a'.repeat(65);
    const result = pm.create('oc_chat1', 'research', longName);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('64');
    }
  });

  it('should accept name at exactly 64 characters', () => {
    const pm = createManagerWithTemplates();
    const name64 = 'a'.repeat(64);
    const result = pm.create('oc_chat1', 'research', name64);
    expect(result.ok).toBe(true);
  });

  it('should reject whitespace-only name', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', '   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('空白');
    }
  });

  // ── Input Validation: templateName ──

  it('should reject non-existent template', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'nonexistent', 'my-project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  // ── Duplicate Prevention ──

  it('should reject duplicate instance name', () => {
    const pm = createManagerWithTemplates();
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
    const pm = createManagerWithTemplates();
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
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'shared-project');

    const result = pm.use('oc_chat2', 'shared-project');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('shared-project');
    }
  });

  it('should reject using "default" name', () => {
    const pm = createManagerWithTemplates();
    const result = pm.use('oc_chat1', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留名');
      expect(result.error).toContain('reset');
    }
  });

  it('should reject non-existent instance', () => {
    const pm = createManagerWithTemplates();
    const result = pm.use('oc_chat1', 'nonexistent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should reject empty chatId', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');

    const result = pm.use('', 'project-a');
    expect(result.ok).toBe(false);
  });

  it('should reject empty name', () => {
    const pm = createManagerWithTemplates();
    const result = pm.use('oc_chat1', '');
    expect(result.ok).toBe(false);
  });

  it('should allow rebinding chatId to different instance', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat1', 'book-reader', 'project-b');

    const result = pm.use('oc_chat1', 'project-a');
    expect(result.ok).toBe(true);

    const active = pm.getActive('oc_chat1');
    expect(active.name).toBe('project-a');
  });

  it('should support multiple chatIds binding to same instance', () => {
    const pm = createManagerWithTemplates();
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
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-project');

    const result = pm.reset('oc_chat1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('default');
      expect(result.data.workingDir).toBe('/workspace');
    }

    // Verify unbound
    expect(pm.getActive('oc_chat1').name).toBe('default');
  });

  it('should be silent no-op when already on default', () => {
    const pm = createManagerWithTemplates();
    const result = pm.reset('oc_unbound');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('default');
    }
  });

  it('should reject empty chatId', () => {
    const pm = createManagerWithTemplates();
    const result = pm.reset('');
    expect(result.ok).toBe(false);
  });

  it('should not affect other chatIds bound to same instance', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'shared-project');
    pm.use('oc_chat2', 'shared-project');

    pm.reset('oc_chat1');

    // chat1 should be on default
    expect(pm.getActive('oc_chat1').name).toBe('default');
    // chat2 should still be bound
    expect(pm.getActive('oc_chat2').name).toBe('shared-project');
  });

  it('should allow re-binding after reset', () => {
    const pm = createManagerWithTemplates();
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
    const pm = createManagerWithTemplates();
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(2);
  });

  it('should return empty array when no templates loaded', () => {
    const pm = createTestManager();
    expect(pm.listTemplates()).toEqual([]);
  });

  it('should include displayName and description when available', () => {
    const pm = createManagerWithTemplates();
    const research = pm.listTemplates().find((t) => t.name === 'research');
    expect(research).toBeDefined();
    expect(research!.displayName).toBe('研究模式');
    expect(research!.description).toBe('专注研究的独立空间');
  });

  it('should handle templates without optional fields', () => {
    const pm = createManagerWithTemplates();
    const bookReader = pm.listTemplates().find((t) => t.name === 'book-reader');
    expect(bookReader).toBeDefined();
    expect(bookReader!.displayName).toBe('读书助手');
    expect(bookReader!.description).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listInstances()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — listInstances()', () => {
  it('should return empty array when no instances created', () => {
    const pm = createManagerWithTemplates();
    expect(pm.listInstances()).toEqual([]);
  });

  it('should return created instances with their bindings', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');
    pm.use('oc_chat2', 'my-research');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);

    const [instance] = instances;
    expect(instance.name).toBe('my-research');
    expect(instance.templateName).toBe('research');
    expect(instance.chatIds).toContain('oc_chat1');
    expect(instance.chatIds).toContain('oc_chat2');
    expect(instance.workingDir).toBe('/workspace/projects/my-research');
    expect(instance.createdAt).toBeDefined();
  });

  it('should return instance with empty chatIds if not bound', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');

    // Reset the binding
    pm.reset('oc_chat1');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].chatIds).toEqual([]);
  });

  it('should list multiple instances', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat2', 'book-reader', 'project-b');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(2);
    expect(instances.map((i) => i.name)).toContain('project-a');
    expect(instances.map((i) => i.name)).toContain('project-b');
  });

  it('should not include default project in listing', () => {
    const pm = createManagerWithTemplates();
    expect(pm.listInstances()).toEqual([]);

    // Even after using default via getActive
    pm.getActive('oc_chat1');
    expect(pm.listInstances()).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProvider()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — createCwdProvider()', () => {
  it('should return undefined for default project', () => {
    const pm = createManagerWithTemplates();
    const cwdProvider = pm.createCwdProvider();

    expect(cwdProvider('oc_unbound')).toBeUndefined();
  });

  it('should return workingDir for bound project', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');

    const cwdProvider = pm.createCwdProvider();
    expect(cwdProvider('oc_chat1')).toBe('/workspace/projects/my-research');
  });

  it('should reflect dynamic binding changes', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'project-a');
    pm.create('oc_chat1', 'book-reader', 'project-b');

    const cwdProvider = pm.createCwdProvider();

    // Currently bound to project-b (latest create)
    expect(cwdProvider('oc_chat1')).toBe('/workspace/projects/project-b');

    // Switch to project-a
    pm.use('oc_chat1', 'project-a');
    expect(cwdProvider('oc_chat1')).toBe('/workspace/projects/project-a');

    // Reset to default
    pm.reset('oc_chat1');
    expect(cwdProvider('oc_chat1')).toBeUndefined();
  });

  it('should work as a closure independent of pm reference', () => {
    const pm = createManagerWithTemplates();
    pm.create('oc_chat1', 'research', 'my-research');

    const cwdProvider = pm.createCwdProvider();

    // The closure captures `this` (the pm instance)
    expect(cwdProvider('oc_chat1')).toBe('/workspace/projects/my-research');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Edge Cases & Integration Scenarios
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager — Edge Cases', () => {
  it('should handle creating from second template', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'book-reader', 'my-books');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.templateName).toBe('book-reader');
    }
  });

  it('should handle template name with hyphen', () => {
    const pm = createTestManager({
      'my-template': { displayName: 'My Template' },
    });
    const result = pm.create('oc_chat1', 'my-template', 'my-instance');
    expect(result.ok).toBe(true);
  });

  it('should show available templates in error when template not found', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'nonexistent', 'my-project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('research');
      expect(result.error).toContain('book-reader');
    }
  });

  it('should show "(无可用模板)" when no templates and template not found', () => {
    const pm = createTestManager();
    const result = pm.create('oc_chat1', 'anything', 'my-project');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('无可用模板');
    }
  });

  it('should handle instance name with hyphens and numbers', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'my-research-2026');
    expect(result.ok).toBe(true);
  });

  it('should handle instance name with underscores', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', 'my_research_project');
    expect(result.ok).toBe(true);
  });

  it('should handle instance name with unicode characters', () => {
    const pm = createManagerWithTemplates();
    const result = pm.create('oc_chat1', 'research', '我的研究');
    expect(result.ok).toBe(true);
  });
});
