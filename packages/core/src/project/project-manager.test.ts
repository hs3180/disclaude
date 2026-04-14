/**
 * Tests for ProjectManager core logic (pure in-memory operations).
 *
 * All tests run without filesystem dependency — ProjectManager operates
 * entirely in memory. No directory creation or file copying occurs.
 *
 * @see Issue #2224 (Sub-Issue B — ProjectManager core logic)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ProjectManager } from './project-manager.js';
import type {
  ProjectManagerOptions,
  ProjectTemplatesConfig,
} from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Standard test options */
const defaultOptions: ProjectManagerOptions = {
  workspaceDir: '/workspace',
  packageDir: '/app/packages/core',
  templatesConfig: {
    research: {
      displayName: '研究模式',
      description: '专注研究的独立空间',
    },
    'book-reader': {
      displayName: '读书助手',
    },
  },
};

/** Create a ProjectManager with default test options */
function createManager(
  overrides?: Partial<ProjectManagerOptions>,
  templatesOverride?: ProjectTemplatesConfig | null,
): ProjectManager {
  const templatesConfig: ProjectTemplatesConfig =
    templatesOverride !== undefined
      ? (templatesOverride ?? {})
      : (overrides?.templatesConfig ?? defaultOptions.templatesConfig);
  const options: ProjectManagerOptions = {
    workspaceDir: overrides?.workspaceDir ?? defaultOptions.workspaceDir,
    packageDir: overrides?.packageDir ?? defaultOptions.packageDir,
    templatesConfig,
  };
  return new ProjectManager(options);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Constructor & Init
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager constructor', () => {
  it('should initialize with templates from config', () => {
    const pm = createManager();
    const templates = pm.listTemplates();

    expect(templates).toHaveLength(2);
    const names = templates.map((t) => t.name).sort();
    expect(names).toEqual(['book-reader', 'research']);
  });

  it('should initialize with empty templates config', () => {
    const pm = createManager({}, {});
    expect(pm.listTemplates()).toEqual([]);
  });

  it('should initialize with no templates config (undefined)', () => {
    const pm = createManager({}, null);
    expect(pm.listTemplates()).toEqual([]);
  });

  it('should store workspaceDir and packageDir', () => {
    const pm = createManager({
      workspaceDir: '/custom-workspace',
      packageDir: '/custom-package',
    });
    expect(pm.getWorkspaceDir()).toBe('/custom-workspace');
    expect(pm.getPackageDir()).toBe('/custom-package');
  });
});

describe('ProjectManager.init()', () => {
  it('should reload templates from new config', () => {
    const pm = createManager();
    expect(pm.listTemplates()).toHaveLength(2);

    pm.init({
      newTemplate: { displayName: 'New Template' },
    });
    expect(pm.listTemplates()).toHaveLength(1);
    expect(pm.listTemplates()[0].name).toBe('newTemplate');
  });

  it('should clear templates when called with empty config', () => {
    const pm = createManager();
    expect(pm.listTemplates()).toHaveLength(2);

    pm.init({});
    expect(pm.listTemplates()).toEqual([]);
  });

  it('should NOT clear existing instances when re-initializing templates', () => {
    const pm = createManager();
    const result = pm.create('chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);

    pm.init({});
    expect(pm.listTemplates()).toEqual([]);
    // Instance should still exist
    const active = pm.getActive('chat1');
    expect(active.name).toBe('my-research');
  });

  it('should preserve instances and bindings across template reload', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');
    pm.create('chat2', 'book-reader', 'my-books');

    pm.init({
      research: { displayName: 'Updated Research' },
    });

    // Only research template, but book-reader instance should still exist
    expect(pm.listTemplates()).toHaveLength(1);
    const instances = pm.listInstances();
    expect(instances).toHaveLength(2);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// getActive()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('getActive()', () => {
  it('should return default project for unbound chatId', () => {
    const pm = createManager();
    const active = pm.getActive('unknown-chat');

    expect(active.name).toBe('default');
    expect(active.workingDir).toBe('/workspace');
    expect(active.templateName).toBeUndefined();
  });

  it('should return bound project instance', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');

    const active = pm.getActive('chat1');
    expect(active.name).toBe('my-research');
    expect(active.templateName).toBe('research');
    expect(active.workingDir).toBe('/workspace/projects/my-research');
  });

  it('should self-heal stale binding (instance deleted)', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');

    // Delete instance directly
    pm.deleteInstance('my-research');

    // getActive should self-heal: remove stale binding, return default
    const active = pm.getActive('chat1');
    expect(active.name).toBe('default');
    expect(active.workingDir).toBe('/workspace');
  });

  it('should only self-heal once (binding removed after first call)', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');
    pm.deleteInstance('my-research');

    // First call: self-heals
    const active1 = pm.getActive('chat1');
    expect(active1.name).toBe('default');

    // Second call: binding already cleaned, still default
    const active2 = pm.getActive('chat1');
    expect(active2.name).toBe('default');
  });

  it('should return correct project after use()', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');
    pm.use('chat2', 'my-research');

    const active = pm.getActive('chat2');
    expect(active.name).toBe('my-research');
  });

  it('should return default after reset()', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');

    const active1 = pm.getActive('chat1');
    expect(active1.name).toBe('my-research');

    pm.reset('chat1');

    const active2 = pm.getActive('chat1');
    expect(active2.name).toBe('default');
  });

  it('should handle multiple chatIds bound to same instance', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');
    pm.use('chat2', 'my-research');
    pm.use('chat3', 'my-research');

    expect(pm.getActive('chat1').name).toBe('my-research');
    expect(pm.getActive('chat2').name).toBe('my-research');
    expect(pm.getActive('chat3').name).toBe('my-research');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// create()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('create()', () => {
  it('should create instance and bind to chatId', () => {
    const pm = createManager();
    const result = pm.create('chat1', 'research', 'my-research');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('my-research');
      expect(result.data.templateName).toBe('research');
      expect(result.data.workingDir).toBe('/workspace/projects/my-research');
    }
  });

  it('should bind chatId to created instance', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');

    const active = pm.getActive('chat1');
    expect(active.name).toBe('my-research');
  });

  it('should appear in listInstances()', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe('my-research');
    expect(instances[0].templateName).toBe('research');
    expect(instances[0].chatIds).toEqual(['chat1']);
    expect(instances[0].createdAt).toBeTruthy();
  });

  it('should fail for non-existent template', () => {
    const pm = createManager();
    const result = pm.create('chat1', 'nonexistent', 'my-project');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('nonexistent');
      expect(result.error).toContain('不存在');
    }
  });

  it('should fail for duplicate instance name', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');

    const result = pm.create('chat2', 'research', 'my-research');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('已存在');
    }
  });

  it('should fail for reserved name "default"', () => {
    const pm = createManager();
    const result = pm.create('chat1', 'research', 'default');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留');
    }
  });

  it('should fail for empty chatId', () => {
    const pm = createManager();
    const result = pm.create('', 'research', 'my-research');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatId');
    }
  });

  it('should create multiple independent instances', () => {
    const pm = createManager();
    const r1 = pm.create('chat1', 'research', 'project-a');
    const r2 = pm.create('chat2', 'book-reader', 'project-b');

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const instances = pm.listInstances();
    expect(instances).toHaveLength(2);
  });

  it('should allow creating from different templates', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'r1');
    pm.create('chat2', 'book-reader', 'b1');

    const i1 = pm.getActive('chat1');
    const i2 = pm.getActive('chat2');

    expect(i1.templateName).toBe('research');
    expect(i2.templateName).toBe('book-reader');
  });

  it('should reassign chatId binding when creating again', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'project-a');

    // Create another project for the same chatId
    const result = pm.create('chat1', 'book-reader', 'project-b');
    expect(result.ok).toBe(true);

    // chat1 should now be bound to project-b
    const active = pm.getActive('chat1');
    expect(active.name).toBe('project-b');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// use()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('use()', () => {
  it('should bind chatId to existing instance', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');

    const result = pm.use('chat2', 'my-research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('my-research');
    }

    expect(pm.getActive('chat2').name).toBe('my-research');
  });

  it('should fail for non-existent instance', () => {
    const pm = createManager();
    const result = pm.use('chat1', 'nonexistent');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不存在');
    }
  });

  it('should fail for reserved name "default"', () => {
    const pm = createManager();
    const result = pm.use('chat1', 'default');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留');
    }
  });

  it('should fail for empty chatId', () => {
    const pm = createManager();
    const result = pm.use('', 'my-research');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatId');
    }
  });

  it('should support multiple chatIds binding to same instance', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'shared-project');

    pm.use('chat2', 'shared-project');
    pm.use('chat3', 'shared-project');

    expect(pm.getActive('chat1').name).toBe('shared-project');
    expect(pm.getActive('chat2').name).toBe('shared-project');
    expect(pm.getActive('chat3').name).toBe('shared-project');

    const instances = pm.listInstances();
    expect(instances[0].chatIds).toHaveLength(3);
  });

  it('should reassign chatId to different instance', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'r1');
    pm.create('chat2', 'book-reader', 'b1');

    // chat1 starts on r1
    expect(pm.getActive('chat1').name).toBe('r1');

    // Reassign chat1 to b1
    const result = pm.use('chat1', 'b1');
    expect(result.ok).toBe(true);
    expect(pm.getActive('chat1').name).toBe('b1');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// reset()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('reset()', () => {
  it('should unbind chatId and return default', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');

    const result = pm.reset('chat1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('default');
    }

    expect(pm.getActive('chat1').name).toBe('default');
  });

  it('should be no-op when already on default', () => {
    const pm = createManager();
    const result = pm.reset('chat1');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe('default');
    }
  });

  it('should fail for empty chatId', () => {
    const pm = createManager();
    const result = pm.reset('');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('chatId');
    }
  });

  it('should not affect other chatIds', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'shared');
    pm.use('chat2', 'shared');

    pm.reset('chat1');

    expect(pm.getActive('chat1').name).toBe('default');
    expect(pm.getActive('chat2').name).toBe('shared');
  });

  it('should update listInstances bindings after reset', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');
    pm.use('chat2', 'my-research');

    pm.reset('chat1');

    const instances = pm.listInstances();
    expect(instances[0].chatIds).toEqual(['chat2']);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listTemplates()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('listTemplates()', () => {
  it('should return all templates from config', () => {
    const pm = createManager();
    const templates = pm.listTemplates();

    expect(templates).toHaveLength(2);
    const research = templates.find((t) => t.name === 'research');
    expect(research).toEqual({
      name: 'research',
      displayName: '研究模式',
      description: '专注研究的独立空间',
    });
  });

  it('should return empty array for no templates', () => {
    const pm = createManager({}, {});
    expect(pm.listTemplates()).toEqual([]);
  });

  it('should reflect changes after init()', () => {
    const pm = createManager();
    pm.init({ newOne: { displayName: 'New' } });

    const templates = pm.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('newOne');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// listInstances()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('listInstances()', () => {
  it('should return empty array when no instances', () => {
    const pm = createManager();
    expect(pm.listInstances()).toEqual([]);
  });

  it('should return created instances with bindings', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'r1');
    pm.create('chat2', 'book-reader', 'b1');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(2);

    const r1 = instances.find((i) => i.name === 'r1');
    expect(r1).toBeDefined();
    expect(r1!.templateName).toBe('research');
    expect(r1!.chatIds).toEqual(['chat1']);
    expect(r1!.workingDir).toBe('/workspace/projects/r1');
    expect(r1!.createdAt).toBeTruthy();
  });

  it('should include multiple chatIds per instance', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'shared');
    pm.use('chat2', 'shared');
    pm.use('chat3', 'shared');

    const instances = pm.listInstances();
    expect(instances).toHaveLength(1);
    expect(instances[0].chatIds).toHaveLength(3);
    expect(instances[0].chatIds).toContain('chat1');
    expect(instances[0].chatIds).toContain('chat2');
    expect(instances[0].chatIds).toContain('chat3');
  });

  it('should NOT include default project', () => {
    const pm = createManager();
    // Even after resetting, default should not appear
    pm.reset('chat1');

    expect(pm.listInstances()).toEqual([]);
  });

  it('should reflect unbound chatIds correctly', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'r1');
    pm.use('chat2', 'r1');

    pm.reset('chat1');

    const instances = pm.listInstances();
    expect(instances[0].chatIds).toEqual(['chat2']);
  });

  it('should include ISO 8601 creation timestamp', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'r1');

    const [instance] = pm.listInstances();
    const { createdAt } = instance;

    // Should be a valid ISO 8601 date string
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProvider()
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('createCwdProvider()', () => {
  it('should return undefined for default project', () => {
    const pm = createManager();
    const cwdProvider = pm.createCwdProvider();

    expect(cwdProvider('any-chat')).toBeUndefined();
  });

  it('should return workingDir for bound project', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');
    const cwdProvider = pm.createCwdProvider();

    expect(cwdProvider('chat1')).toBe('/workspace/projects/my-research');
  });

  it('should return undefined after reset', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');
    const cwdProvider = pm.createCwdProvider();

    expect(cwdProvider('chat1')).toBe('/workspace/projects/my-research');

    pm.reset('chat1');
    expect(cwdProvider('chat1')).toBeUndefined();
  });

  it('should reflect live state changes', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'r1');
    pm.create('chat2', 'book-reader', 'b1');
    const cwdProvider = pm.createCwdProvider();

    expect(cwdProvider('chat1')).toBe('/workspace/projects/r1');
    expect(cwdProvider('chat2')).toBe('/workspace/projects/b1');

    pm.use('chat1', 'b1');
    expect(cwdProvider('chat1')).toBe('/workspace/projects/b1');
  });

  it('should return undefined for self-healed stale binding', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');
    pm.deleteInstance('my-research');
    const cwdProvider = pm.createCwdProvider();

    expect(cwdProvider('chat1')).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Input Validation — Path Traversal Protection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('name validation', () => {
  let pm: ProjectManager;

  beforeEach(() => {
    pm = createManager();
  });

  it('should reject empty name', () => {
    const result = pm.create('chat1', 'research', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('不能为空');
    }
  });

  it('should reject "default" as name', () => {
    const result = pm.create('chat1', 'research', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留');
    }
  });

  it('should reject name containing ".."', () => {
    const result = pm.create('chat1', 'research', 'evil..traversal');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('..');
    }
  });

  it('should reject name that IS ".."', () => {
    const result = pm.create('chat1', 'research', '..');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('..');
    }
  });

  it('should reject name with forward slash', () => {
    const result = pm.create('chat1', 'research', 'path/separator');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('路径分隔符');
    }
  });

  it('should reject name with backslash', () => {
    const result = pm.create('chat1', 'research', 'path\\separator');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('路径分隔符');
    }
  });

  it('should reject name with null byte', () => {
    const result = pm.create('chat1', 'research', 'name\x00evil');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('路径分隔符');
    }
  });

  it('should reject whitespace-only name', () => {
    const result = pm.create('chat1', 'research', '   ');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('空白');
    }
  });

  it('should reject name exceeding 64 characters', () => {
    const longName = 'a'.repeat(65);
    const result = pm.create('chat1', 'research', longName);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('64');
    }
  });

  it('should accept name at exactly 64 characters', () => {
    const maxName = 'a'.repeat(64);
    const result = pm.create('chat1', 'research', maxName);
    expect(result.ok).toBe(true);
  });

  it('should accept hyphens in name', () => {
    const result = pm.create('chat1', 'research', 'my-research-project');
    expect(result.ok).toBe(true);
  });

  it('should accept underscores in name', () => {
    const result = pm.create('chat1', 'research', 'my_research_project');
    expect(result.ok).toBe(true);
  });

  it('should accept unicode in name', () => {
    const result = pm.create('chat1', 'research', '研究项目');
    expect(result.ok).toBe(true);
  });

  it('should reject name starting with ".." indirectly', () => {
    const result = pm.create('chat1', 'research', '..hidden');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('..');
    }
  });

  it('should also validate name in use()', () => {
    pm.create('chat1', 'research', 'my-research');
    const result = pm.use('chat2', 'default');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('保留');
    }
  });

  it('should also validate name in use() with path traversal', () => {
    pm.create('chat1', 'research', 'my-research');
    const result = pm.use('chat2', '..');
    expect(result.ok).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Integration Scenarios
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('integration scenarios', () => {
  it('should handle full lifecycle: create → use → reset → use', () => {
    const pm = createManager();

    // Create
    const r1 = pm.create('chat1', 'research', 'r1');
    expect(r1.ok).toBe(true);
    expect(pm.getActive('chat1').name).toBe('r1');

    // Another chat uses the same instance
    const r2 = pm.use('chat2', 'r1');
    expect(r2.ok).toBe(true);

    // chat1 resets
    pm.reset('chat1');
    expect(pm.getActive('chat1').name).toBe('default');
    expect(pm.getActive('chat2').name).toBe('r1');

    // chat1 uses again
    pm.use('chat1', 'r1');
    expect(pm.getActive('chat1').name).toBe('r1');
  });

  it('should handle switching between multiple projects', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'r1');
    pm.create('chat1', 'book-reader', 'b1'); // reassigns chat1

    expect(pm.getActive('chat1').name).toBe('b1');

    pm.use('chat1', 'r1');
    expect(pm.getActive('chat1').name).toBe('r1');

    pm.reset('chat1');
    expect(pm.getActive('chat1').name).toBe('default');
  });

  it('should handle create after instance was deleted (D phase rollback)', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');
    pm.deleteInstance('my-research');

    // chat1 self-heals to default
    expect(pm.getActive('chat1').name).toBe('default');

    // Can create a new instance with same name
    const result = pm.create('chat1', 'research', 'my-research');
    expect(result.ok).toBe(true);
    expect(pm.getActive('chat1').name).toBe('my-research');
  });

  it('should maintain isolation between chatIds', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'r1');
    pm.create('chat2', 'book-reader', 'b1');

    expect(pm.getActive('chat1').name).toBe('r1');
    expect(pm.getActive('chat2').name).toBe('b1');

    pm.reset('chat1');
    expect(pm.getActive('chat1').name).toBe('default');
    expect(pm.getActive('chat2').name).toBe('b1');
  });

  it('should handle CwdProvider integration end-to-end', () => {
    const pm = createManager();
    const cwdProvider = pm.createCwdProvider();

    // No projects: all chatIds get undefined
    expect(cwdProvider('chat1')).toBeUndefined();

    // Create project
    pm.create('chat1', 'research', 'my-research');
    expect(cwdProvider('chat1')).toBe('/workspace/projects/my-research');

    // Reset
    pm.reset('chat1');
    expect(cwdProvider('chat1')).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// deleteInstance() (internal, for D phase rollback)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('deleteInstance()', () => {
  it('should remove instance from memory', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');

    expect(pm.listInstances()).toHaveLength(1);
    expect(pm.deleteInstance('my-research')).toBe(true);
    expect(pm.listInstances()).toHaveLength(0);
  });

  it('should return false for non-existent instance', () => {
    const pm = createManager();
    expect(pm.deleteInstance('nonexistent')).toBe(false);
  });

  it('should NOT unbind chatIds (self-healing handles that)', () => {
    const pm = createManager();
    pm.create('chat1', 'research', 'my-research');
    pm.use('chat2', 'my-research');

    pm.deleteInstance('my-research');

    // Both chatIds still have stale bindings, but getActive self-heals
    expect(pm.getActive('chat1').name).toBe('default');
    expect(pm.getActive('chat2').name).toBe('default');
  });
});
