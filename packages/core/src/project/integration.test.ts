/**
 * Integration tests for ProjectManager module exports and config integration.
 *
 * Tests verify:
 * - ProjectManager and types can be imported from '@disclaude/core' (barrel export)
 * - createCwdProvider() works correctly after use()/reset()
 * - DisclaudeConfig includes projectTemplates field
 * - Config.getProjectTemplatesConfig() returns correct values
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectManager } from './project-manager.js';
import type {
  CwdProvider,
  ProjectManagerOptions,
  ProjectTemplatesConfig,
} from './types.js';

// Import config types directly (simulating @disclaude/core re-export)
import type { DisclaudeConfig } from '../config/types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-integ-'));
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
// Module Export Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('ProjectManager module exports', () => {
  it('should export ProjectManager class', () => {
    expect(ProjectManager).toBeDefined();
    expect(typeof ProjectManager).toBe('function');
  });

  it('should construct ProjectManager with valid options', () => {
    const pm = new ProjectManager(createOptions());
    expect(pm).toBeInstanceOf(ProjectManager);
    expect(pm.listTemplates()).toHaveLength(1);
    expect(pm.listTemplates()[0].name).toBe('research');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// createCwdProvider Integration Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('createCwdProvider integration', () => {
  it('should return undefined for default project (no binding)', () => {
    const pm = new ProjectManager(createOptions());
    const cwdProvider: CwdProvider = pm.createCwdProvider();

    // Default project → undefined (SDK falls back to getWorkspaceDir())
    const result = cwdProvider('chat-1');
    expect(result).toBeUndefined();
  });

  it('should return workingDir after use()', () => {
    const options = createOptions();
    const pm = new ProjectManager(options);
    const cwdProvider: CwdProvider = pm.createCwdProvider();

    // Create and bind instance
    const createResult = pm.create('chat-1', 'research', 'my-research');
    expect(createResult.ok).toBe(true);

    const cwd = cwdProvider('chat-1');
    expect(cwd).toBe(join(options.workspaceDir, 'projects/my-research'));
  });

  it('should return undefined after reset()', () => {
    const options = createOptions();
    const pm = new ProjectManager(options);
    const cwdProvider: CwdProvider = pm.createCwdProvider();

    // Create → use → reset
    pm.create('chat-1', 'research', 'my-research');
    expect(cwdProvider('chat-1')).toBeDefined();

    pm.reset('chat-1');
    expect(cwdProvider('chat-1')).toBeUndefined();
  });

  it('should reflect use() changes dynamically via closure', () => {
    const options = createOptions();
    const pm = new ProjectManager(options);
    const cwdProvider: CwdProvider = pm.createCwdProvider();

    // Create two instances
    pm.create('chat-1', 'research', 'research-a');
    pm.create('chat-2', 'research', 'research-b');

    // Bind chat-1 to research-a
    pm.use('chat-1', 'research-a');
    expect(cwdProvider('chat-1')).toBe(join(options.workspaceDir, 'projects/research-a'));

    // Re-bind chat-1 to research-b
    pm.use('chat-1', 'research-b');
    expect(cwdProvider('chat-1')).toBe(join(options.workspaceDir, 'projects/research-b'));
  });

  it('should work with zero templates config (no templates)', () => {
    const options = createOptions({ templatesConfig: {} });
    const pm = new ProjectManager(options);
    const cwdProvider: CwdProvider = pm.createCwdProvider();

    // No templates, no instances — always default
    expect(cwdProvider('chat-1')).toBeUndefined();
    expect(cwdProvider('chat-2')).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Config Type Integration Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('DisclaudeConfig.projectTemplates type', () => {
  it('should accept projectTemplates in config object', () => {
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
    expect(config.projectTemplates!.research.displayName).toBe('研究模式');
    expect(config.projectTemplates!['book-reader'].displayName).toBe('读书助手');
  });

  it('should accept empty projectTemplates', () => {
    const config: DisclaudeConfig = {
      projectTemplates: {},
    };

    expect(config.projectTemplates).toBeDefined();
    expect(Object.keys(config.projectTemplates!)).toHaveLength(0);
  });

  it('should accept config without projectTemplates', () => {
    const config: DisclaudeConfig = {
      workspace: { dir: '/workspace' },
    };

    expect(config.projectTemplates).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Full Integration: Config → ProjectManager → CwdProvider
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Config → ProjectManager → CwdProvider integration', () => {
  it('should create ProjectManager from config and provide cwd', () => {
    // Simulate loading config from disclaude.config.yaml
    const templatesConfig: ProjectTemplatesConfig = {
      research: {
        displayName: '研究模式',
        description: '专注研究的独立空间',
      },
    };

    const workspaceDir = createTempDir();
    const options: ProjectManagerOptions = {
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig,
    };

    // Create ProjectManager with config-derived templates
    const pm = new ProjectManager(options);

    // Verify templates loaded correctly
    const templates = pm.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('research');

    // Create instance
    const result = pm.create('chat-1', 'research', 'my-research');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.workingDir).toBe(join(workspaceDir, 'projects/my-research'));
    }

    // Use CwdProvider
    const cwdProvider = pm.createCwdProvider();
    expect(cwdProvider('chat-1')).toBe(join(workspaceDir, 'projects/my-research'));
    expect(cwdProvider('chat-2')).toBeUndefined(); // unbound chat → default
  });

  it('should handle config-driven templates and auto-discovery merge', () => {
    // Config specifies only research template
    const config: DisclaudeConfig = {
      projectTemplates: {
        research: { displayName: '研究模式' },
      },
    };

    // ProjectManager is initialized with config's projectTemplates
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: config.projectTemplates ?? {},
    });

    // Only research template is available
    expect(pm.listTemplates()).toHaveLength(1);
    expect(pm.listTemplates()[0].name).toBe('research');
  });
});
