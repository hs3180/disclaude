/**
 * Integration tests for Project module export and config integration.
 *
 * Tests the acceptance criteria from Issue #2227:
 * - `import { ProjectManager } from '@disclaude/core'` 可用
 * - 所有类型正确导出
 * - 从 config 加载 templates 正确工作
 * - createCwdProvider 在 use()/reset() 后返回更新结果
 *
 * @see Issue #2227 (Sub-Issue E — integration)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Acceptance Criterion 1: ProjectManager 可从 project 模块导入
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import { ProjectManager } from './project-manager.js';
import type {
  CwdProvider,
  ProjectManagerOptions,
  ProjectTemplatesConfig,
} from './types.js';

import {
  discoverTemplates,
  discoveryResultToConfig,
  discoverTemplatesAsConfig,
} from './template-discovery.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Acceptance Criterion 2: Config 类型包含 projectTemplates
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import type { DisclaudeConfig, ProjectTemplateConfig } from '../config/types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Helpers
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
    packageDir: '',
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
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('Issue #2227 — Module exports', () => {
  it('should export ProjectManager class', () => {
    expect(ProjectManager).toBeDefined();
    expect(typeof ProjectManager).toBe('function');
  });

  it('should construct ProjectManager and use it', () => {
    const pm = new ProjectManager(createOptions());
    expect(pm.listTemplates()).toHaveLength(2);
  });

  it('should export all required types (type-level check)', () => {
    // These type assignments verify the types are correctly exported.
    // If any import is missing, TypeScript compilation would fail.

    const _cwdProvider: CwdProvider = (_chatId: string) => undefined;
    const _templatesConfig: ProjectTemplatesConfig = {
      research: { displayName: '研究模式' },
    };
    const _templateConfig: ProjectTemplateConfig = { displayName: 'test' };

    // DisclaudeConfig should accept projectTemplates
    const _config: DisclaudeConfig = {
      projectTemplates: {
        research: { displayName: '研究模式', description: 'desc' },
      },
    };

    // Verify runtime values
    expect(_cwdProvider).toBeDefined();
    expect(_templatesConfig).toBeDefined();
    expect(_templateConfig).toBeDefined();
    expect(_config).toBeDefined();
  });

  it('should export template discovery functions', () => {
    expect(discoverTemplates).toBeDefined();
    expect(typeof discoverTemplates).toBe('function');
    expect(discoveryResultToConfig).toBeDefined();
    expect(typeof discoveryResultToConfig).toBe('function');
    expect(discoverTemplatesAsConfig).toBeDefined();
    expect(typeof discoverTemplatesAsConfig).toBe('function');
  });
});

describe('Issue #2227 — Config type integration', () => {
  it('should accept projectTemplates in DisclaudeConfig', () => {
    const config: DisclaudeConfig = {
      projectTemplates: {
        research: { displayName: '研究模式', description: '专注研究' },
        'code-review': { displayName: '代码审查' },
      },
    };

    expect(config.projectTemplates).toBeDefined();
    expect(Object.keys(config.projectTemplates!)).toHaveLength(2);
    expect(config.projectTemplates!.research.displayName).toBe('研究模式');
  });

  it('should allow empty projectTemplates', () => {
    const config: DisclaudeConfig = {
      projectTemplates: {},
    };

    expect(config.projectTemplates).toBeDefined();
    expect(Object.keys(config.projectTemplates!)).toHaveLength(0);
  });

  it('should allow config without projectTemplates', () => {
    const config: DisclaudeConfig = {
      agent: { provider: 'glm' },
    };

    expect(config.projectTemplates).toBeUndefined();
  });
});

describe('Issue #2227 — createCwdProvider integration', () => {
  it('should return undefined for default project', () => {
    const pm = new ProjectManager(createOptions());
    const cwdProvider = pm.createCwdProvider();

    expect(cwdProvider('chat-1')).toBeUndefined();
  });

  it('should return workingDir after use()', () => {
    const pm = new ProjectManager(createOptions());
    pm.create('chat-1', 'research', 'my-research');
    const cwdProvider = pm.createCwdProvider();

    const cwd = cwdProvider('chat-1');
    expect(cwd).toBeDefined();
    expect(cwd).toContain('projects/my-research');
  });

  it('should return undefined after reset()', () => {
    const pm = new ProjectManager(createOptions());
    pm.create('chat-1', 'research', 'my-research');
    const cwdProvider = pm.createCwdProvider();

    // Before reset: has working dir
    expect(cwdProvider('chat-1')).toContain('projects/my-research');

    // Reset binding
    pm.reset('chat-1');

    // After reset: returns undefined (default)
    expect(cwdProvider('chat-1')).toBeUndefined();
  });

  it('should dynamically reflect binding changes', () => {
    const pm = new ProjectManager(createOptions());
    const cwdProvider = pm.createCwdProvider();

    // Initially default
    expect(cwdProvider('chat-1')).toBeUndefined();

    // Create and bind
    pm.create('chat-1', 'research', 'my-research');
    expect(cwdProvider('chat-1')).toContain('projects/my-research');

    // Switch to another instance
    pm.create('chat-2', 'book-reader', 'my-books');
    pm.use('chat-1', 'my-books');
    expect(cwdProvider('chat-1')).toContain('projects/my-books');

    // Reset back to default
    pm.reset('chat-1');
    expect(cwdProvider('chat-1')).toBeUndefined();
  });

  it('should work with multiple chatIds independently', () => {
    const pm = new ProjectManager(createOptions());
    pm.create('chat-1', 'research', 'my-research');
    pm.create('chat-2', 'book-reader', 'my-books');
    const cwdProvider = pm.createCwdProvider();

    expect(cwdProvider('chat-1')).toContain('projects/my-research');
    expect(cwdProvider('chat-2')).toContain('projects/my-books');
    expect(cwdProvider('chat-3')).toBeUndefined(); // No binding
  });
});

describe('Issue #2227 — Template discovery integration', () => {
  it('should discover templates from filesystem and create config', () => {
    const tempDir = createTempDir();
    const templatesDir = join(tempDir, 'templates');
    mkdirSync(join(templatesDir, 'research'), { recursive: true });
    writeFileSync(join(templatesDir, 'research', 'CLAUDE.md'), '# Research');
    mkdirSync(join(templatesDir, 'writer'), { recursive: true });
    writeFileSync(join(templatesDir, 'writer', 'CLAUDE.md'), '# Writer');

    const result = discoverTemplates(tempDir);
    expect(result.templates).toHaveLength(2);
    expect(result.errors).toHaveLength(0);

    const config = discoveryResultToConfig(result);
    expect(config.research).toBeDefined();
    expect(config.writer).toBeDefined();
  });

  it('should create ProjectManager from discovered templates', () => {
    const tempDir = createTempDir();
    const templatesDir = join(tempDir, 'templates');
    mkdirSync(join(templatesDir, 'research'), { recursive: true });
    writeFileSync(join(templatesDir, 'research', 'CLAUDE.md'), '# Research');

    const config = discoverTemplatesAsConfig(tempDir);
    const pm = new ProjectManager({
      workspaceDir: createTempDir(),
      packageDir: '',
      templatesConfig: config,
    });

    const templates = pm.listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe('research');
  });
});
