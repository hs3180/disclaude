/**
 * Integration tests for ProjectManager module exports.
 *
 * Verifies Issue #2227 acceptance criteria:
 * - `import { ProjectManager } from '@disclaude/core'` is available
 * - All types are correctly exported
 * - Config loading works with projectTemplates
 * - createCwdProvider returns updated results after use()/reset()
 *
 * @see Issue #2227 — E — Integration (index.ts + config + createCwdProvider)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Verify re-exports from project/index.ts ──
import {
  ProjectManager,
  discoverTemplates,
  discoveryResultToConfig,
  discoverTemplatesAsConfig,
  type ProjectManagerOptions,
  type ProjectResult,
  type ProjectTemplate,
  type ProjectTemplatesConfig,
} from './index.js';

// ── Verify re-exports from @disclaude/core (packages/core/src/index.ts) ──
// These imports verify the barrel re-export chain works end-to-end.
// We import from the relative path since @disclaude/core resolves to the same file.
import {
  ProjectManager as CoreProjectManager,
  type ProjectTemplatesConfig as CoreProjectTemplatesConfig,
} from '../index.js';

// ── Verify DisclaudeConfig includes projectTemplates ──
import type { DisclaudeConfig } from '../config/types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-export-test-'));
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
// Acceptance Criteria Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227 — Module re-exports', () => {
  it('should export ProjectManager from project/index.ts', () => {
    expect(ProjectManager).toBeDefined();
    expect(typeof ProjectManager).toBe('function');
  });

  it('should export ProjectManager from core index (barrel)', () => {
    // Verifies: import { ProjectManager } from '@disclaude/core' is available
    expect(CoreProjectManager).toBeDefined();
    expect(CoreProjectManager).toBe(ProjectManager);
  });

  it('should export all types correctly', () => {
    // Type-level verification — these compile-time checks pass if no TS errors
    // Runtime check: ensure we can construct using imported types
    const config: ProjectTemplatesConfig = {
      research: { displayName: '研究模式' },
    };
    expect(config.research.displayName).toBe('研究模式');

    const result: ProjectResult<string> = { ok: true, data: 'test' };
    expect(result.ok).toBe(true);

    const template: ProjectTemplate = { name: 'research' };
    expect(template.name).toBe('research');
  });

  it('should export types from core barrel', () => {
    // Verifies type re-exports work through the barrel
    const config: CoreProjectTemplatesConfig = {
      research: { displayName: '研究' },
    };
    expect(config.research.displayName).toBe('研究');
  });

  it('should export discoverTemplates and helpers', () => {
    expect(discoverTemplates).toBeDefined();
    expect(typeof discoverTemplates).toBe('function');
    expect(discoveryResultToConfig).toBeDefined();
    expect(typeof discoveryResultToConfig).toBe('function');
    expect(discoverTemplatesAsConfig).toBeDefined();
    expect(typeof discoverTemplatesAsConfig).toBe('function');
  });
});

describe('Issue #2227 — DisclaudeConfig.projectTemplates', () => {
  it('should accept projectTemplates in DisclaudeConfig', () => {
    const config: DisclaudeConfig = {
      projectTemplates: {
        research: {
          displayName: '研究模式',
          description: '专注研究的独立空间',
        },
        'book-reader': {
          displayName: '读书助手',
        },
      },
    };
    expect(config.projectTemplates).toBeDefined();
    expect(config.projectTemplates?.research.displayName).toBe('研究模式');
  });

  it('should allow DisclaudeConfig without projectTemplates (zero-config)', () => {
    const config: DisclaudeConfig = {
      workspace: { dir: './workspace' },
    };
    expect(config.projectTemplates).toBeUndefined();
  });
});

describe('Issue #2227 — createCwdProvider integration', () => {
  it('should return updated cwd after use() and reset()', () => {
    const pm = new ProjectManager(createOptions());
    const cwdProvider = pm.createCwdProvider();

    const chatId = 'test-chat-001';

    // Default: returns undefined (workspace root)
    expect(cwdProvider(chatId)).toBeUndefined();

    // Create a project instance
    const createResult = pm.create(chatId, 'research', 'my-research');
    expect(createResult.ok).toBe(true);

    // After create: cwdProvider should return the instance workingDir
    const cwdAfterCreate = cwdProvider(chatId);
    expect(cwdAfterCreate).toBeDefined();
    expect(cwdAfterCreate).toContain('projects/my-research');

    // Use a different chatId on the same instance
    const chatId2 = 'test-chat-002';
    const useResult = pm.use(chatId2, 'my-research');
    expect(useResult.ok).toBe(true);

    const cwdAfterUse = cwdProvider(chatId2);
    expect(cwdAfterUse).toBeDefined();
    expect(cwdAfterUse).toContain('projects/my-research');

    // Reset chatId
    const resetResult = pm.reset(chatId);
    expect(resetResult.ok).toBe(true);

    // After reset: returns undefined (back to default)
    expect(cwdProvider(chatId)).toBeUndefined();
  });

  it('should reflect dynamic changes via cwdProvider closure', () => {
    const pm = new ProjectManager(createOptions());
    const cwdProvider = pm.createCwdProvider();
    const chatId = 'closure-test';

    // Default
    expect(cwdProvider(chatId)).toBeUndefined();

    // Create
    pm.create(chatId, 'research', 'proj-a');
    expect(cwdProvider(chatId)).toContain('projects/proj-a');

    // Switch to another instance
    pm.create('other-chat', 'research', 'proj-b');
    pm.use(chatId, 'proj-b');
    expect(cwdProvider(chatId)).toContain('projects/proj-b');

    // Reset
    pm.reset(chatId);
    expect(cwdProvider(chatId)).toBeUndefined();
  });
});

describe('Issue #2227 — Config loading integration', () => {
  it('should initialize ProjectManager from config-like projectTemplates', () => {
    const config: DisclaudeConfig = {
      projectTemplates: {
        research: { displayName: '研究模式' },
      },
    };

    const pm = new ProjectManager({
      workspaceDir: createTempDir(),
      packageDir: '/nonexistent',
      templatesConfig: config.projectTemplates ?? {},
    });

    const templates = pm.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('research');
    expect(templates[0].displayName).toBe('研究模式');
  });
});
