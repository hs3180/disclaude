/**
 * Unit tests for /project command handler.
 *
 * @see Issue #1916 — unified ProjectContext system
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleProject } from './project.js';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import { ProjectManager } from '../../project/project-manager.js';
import type { ProjectManagerOptions } from '../../project/types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'project-cmd-test-'));
  tempDirs.push(dir);
  return dir;
}

function createProjectManager(): ProjectManager {
  const workspaceDir = createTempDir();
  const opts: ProjectManagerOptions = {
    workspaceDir,
    packageDir: join(workspaceDir, 'packages/core'),
    templatesConfig: {
      research: { displayName: '研究模式', description: '专注研究的独立空间' },
      'book-reader': { displayName: '读书助手' },
    },
  };
  return new ProjectManager(opts);
}

function createContext(pm?: ProjectManager): ControlHandlerContext {
  return {
    agentPool: {
      reset: (): void => {},
      stop: (): boolean => false,
    },
    node: {
      nodeId: 'test-node',
      getExecNodes: () => [],
      getDebugGroup: () => null,
      setDebugGroup: () => {},
      clearDebugGroup: () => null,
    },
    projectManager: pm,
  };
}

function makeCommand(chatId: string, args: string[] = [], text?: string): ControlCommand {
  return {
    type: 'project',
    chatId,
    data: {
      args,
      text: text ?? args.join(' '),
    },
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
// /project list
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('/project list', () => {
  it('should list available templates', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(makeCommand('chat_1', ['list']), ctx);

    expect(result.success).toBe(true);
    expect(result.message).toContain('research');
    expect(result.message).toContain('研究模式');
    expect(result.message).toContain('book-reader');
  });

  it('should list created instances', () => {
    const pm = createProjectManager();
    pm.create('chat_1', 'research', 'my-research');
    const ctx = createContext(pm);
    const result = handleProject(makeCommand('chat_1', ['list']), ctx);

    expect(result.success).toBe(true);
    expect(result.message).toContain('my-research');
  });

  it('should default to list when no args', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(makeCommand('chat_1'), ctx);

    expect(result.success).toBe(true);
    expect(result.message).toContain('Project 列表');
  });

  it('should show "no templates" when empty config', () => {
    const workspaceDir = createTempDir();
    const pm = new ProjectManager({
      workspaceDir,
      packageDir: join(workspaceDir, 'packages/core'),
      templatesConfig: {},
    });
    const ctx = createContext(pm);
    const result = handleProject(makeCommand('chat_1', ['list']), ctx);

    expect(result.success).toBe(true);
    expect(result.message).toContain('暂无可用模板');
  });

  it('should return error when projectManager not configured', () => {
    const ctx = createContext(undefined);
    const result = handleProject(makeCommand('chat_1', ['list']), ctx);

    expect(result.success).toBe(false);
    expect(result.error).toContain('未启用');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// /project create
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('/project create', () => {
  it('should create instance from template', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['create', 'research', 'my-research']),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('my-research');
    expect(result.message).toContain('research');

    // Verify binding
    expect(pm.getActive('chat_1').name).toBe('my-research');
  });

  it('should reject missing arguments', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['create', 'research']),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('用法');
  });

  it('should reject non-existent template', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['create', 'nonexistent', 'test']),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('创建失败');
  });

  it('should reject duplicate instance name', () => {
    const pm = createProjectManager();
    pm.create('chat_1', 'research', 'my-research');
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_2', ['create', 'research', 'my-research']),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('创建失败');
  });

  it('should return error when projectManager not configured', () => {
    const ctx = createContext(undefined);
    const result = handleProject(
      makeCommand('chat_1', ['create', 'research', 'test']),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('未启用');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// /project use
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('/project use', () => {
  it('should bind chatId to existing instance', () => {
    const pm = createProjectManager();
    pm.create('chat_1', 'research', 'my-research');
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_2', ['use', 'my-research']),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('my-research');

    // Verify binding
    expect(pm.getActive('chat_2').name).toBe('my-research');
  });

  it('should reject non-existent instance', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['use', 'nonexistent']),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('切换失败');
  });

  it('should reject missing argument', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['use']),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('用法');
  });

  it('should return error when projectManager not configured', () => {
    const ctx = createContext(undefined);
    const result = handleProject(
      makeCommand('chat_1', ['use', 'test']),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('未启用');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// /project info
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('/project info', () => {
  it('should show default project for unbound chatId', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['info']),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('默认');
  });

  it('should show active project details', () => {
    const pm = createProjectManager();
    pm.create('chat_1', 'research', 'my-research');
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['info']),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('my-research');
    expect(result.message).toContain('research');
  });

  it('should return error when projectManager not configured', () => {
    const ctx = createContext(undefined);
    const result = handleProject(
      makeCommand('chat_1', ['info']),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('未启用');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// /project reset
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('/project reset', () => {
  it('should reset to default project', () => {
    const pm = createProjectManager();
    pm.create('chat_1', 'research', 'my-research');
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['reset']),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('默认');

    // Verify unbound
    expect(pm.getActive('chat_1').name).toBe('default');
  });

  it('should be idempotent for unbound chatId', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['reset']),
      ctx,
    );

    expect(result.success).toBe(true);
  });

  it('should return error when projectManager not configured', () => {
    const ctx = createContext(undefined);
    const result = handleProject(
      makeCommand('chat_1', ['reset']),
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('未启用');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Sub-command aliases
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('/project sub-command aliases', () => {
  it('should accept "new" as alias for "create"', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['new', 'research', 'alias-test']),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(pm.getActive('chat_1').name).toBe('alias-test');
  });

  it('should accept "switch" as alias for "use"', () => {
    const pm = createProjectManager();
    pm.create('chat_1', 'research', 'my-research');
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_2', ['switch', 'my-research']),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(pm.getActive('chat_2').name).toBe('my-research');
  });

  it('should accept "show" as alias for "info"', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['show']),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('当前 Project');
  });

  it('should accept "default" as alias for "reset"', () => {
    const pm = createProjectManager();
    pm.create('chat_1', 'research', 'my-research');
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['default']),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(pm.getActive('chat_1').name).toBe('default');
  });

  it('should treat unrecognized sub-command as list', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      makeCommand('chat_1', ['foobar']),
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.message).toContain('Project 列表');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Text-based argument parsing
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('/project text-based parsing', () => {
  it('should parse create from text when args array is empty', () => {
    const pm = createProjectManager();
    const ctx = createContext(pm);
    const result = handleProject(
      { type: 'project', chatId: 'chat_1', data: { args: [], text: 'create research text-parsed' } },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(pm.getActive('chat_1').name).toBe('text-parsed');
  });
});
