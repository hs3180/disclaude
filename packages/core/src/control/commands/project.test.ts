/**
 * Tests for /project command handlers.
 *
 * Issue #1916: Tests for project management commands.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  handleProjectList,
  handleProjectSwitch,
  handleProjectInfo,
} from './project.js';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import { ProjectManager } from '../../project/project-manager.js';

function createCommand(type: string, chatId: string, data?: Record<string, unknown>): ControlCommand {
  return { type: type as ControlCommand['type'], chatId, data };
}

describe('handleProjectList', () => {
  it('should return no-PM response when no ProjectManager', () => {
    const ctx: ControlHandlerContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: { nodeId: 'test', getExecNodes: () => [], getDebugGroup: () => null, clearDebugGroup: () => {} },
    };

    const result = handleProjectList(createCommand('project-list', 'chat-1'), ctx);
    expect(result.success).toBe(false);
    expect(result.message).toContain('not configured');
  });

  it('should list all projects', () => {
    const pm = new ProjectManager({
      default: { instructionsPath: './CLAUDE.md' },
      custom: { knowledge: ['./docs/'] },
    }, '/workspace');

    const ctx: ControlHandlerContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: { nodeId: 'test', getExecNodes: () => [], getDebugGroup: () => null, clearDebugGroup: () => {} },
      projectManager: pm,
    } as ControlHandlerContext;

    const result = handleProjectList(createCommand('project-list', 'chat-1'), ctx);
    expect(result.success).toBe(true);
    expect(result.message).toContain('default');
    expect(result.message).toContain('custom');
    expect(result.message).toContain('2)');
  });

  it('should show message when no projects configured', () => {
    const pm = new ProjectManager({}, '/workspace');

    const ctx: ControlHandlerContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: { nodeId: 'test', getExecNodes: () => [], getDebugGroup: () => null, clearDebugGroup: () => {} },
      projectManager: pm,
    } as ControlHandlerContext;

    const result = handleProjectList(createCommand('project-list', 'chat-1'), ctx);
    expect(result.success).toBe(true);
    expect(result.message).toContain('No projects');
  });
});

describe('handleProjectSwitch', () => {
  it('should return no-PM response when no ProjectManager', () => {
    const ctx: ControlHandlerContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: { nodeId: 'test', getExecNodes: () => [], getDebugGroup: () => null, clearDebugGroup: () => {} },
    };

    const result = handleProjectSwitch(createCommand('project-switch', 'chat-1'), ctx);
    expect(result.success).toBe(false);
  });

  it('should require project name', () => {
    const pm = new ProjectManager({}, '/workspace');
    const ctx: ControlHandlerContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: { nodeId: 'test', getExecNodes: () => [], getDebugGroup: () => null, clearDebugGroup: () => {} },
      projectManager: pm,
    } as ControlHandlerContext;

    const result = handleProjectSwitch(createCommand('project-switch', 'chat-1'), ctx);
    expect(result.success).toBe(false);
    expect(result.message).toContain('Usage');
  });

  it('should reject non-existent project', () => {
    const pm = new ProjectManager({ default: {} }, '/workspace');
    const ctx: ControlHandlerContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: { nodeId: 'test', getExecNodes: () => [], getDebugGroup: () => null, clearDebugGroup: () => {} },
      projectManager: pm,
    } as ControlHandlerContext;

    const result = handleProjectSwitch(
      createCommand('project-switch', 'chat-1', { name: 'nonexistent' }),
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain('not found');
  });

  it('should switch to valid project', () => {
    const pm = new ProjectManager({ default: {}, custom: {} }, '/workspace');
    const ctx: ControlHandlerContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: { nodeId: 'test', getExecNodes: () => [], getDebugGroup: () => null, clearDebugGroup: () => {} },
      projectManager: pm,
    } as ControlHandlerContext;

    const result = handleProjectSwitch(
      createCommand('project-switch', 'chat-1', { name: 'custom' }),
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.message).toContain('custom');
    expect(pm.getProjectForChat('chat-1')).toBe('custom');
  });
});

describe('handleProjectInfo', () => {
  it('should return no-PM response when no ProjectManager', () => {
    const ctx: ControlHandlerContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: { nodeId: 'test', getExecNodes: () => [], getDebugGroup: () => null, clearDebugGroup: () => {} },
    };

    const result = handleProjectInfo(createCommand('project-info', 'chat-1'), ctx);
    expect(result.success).toBe(false);
  });

  it('should show current project info', () => {
    const pm = new ProjectManager({
      default: { instructionsPath: './CLAUDE.md', knowledge: ['./docs/'] },
    }, '/workspace');

    const ctx: ControlHandlerContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: { nodeId: 'test', getExecNodes: () => [], getDebugGroup: () => null, clearDebugGroup: () => {} },
      projectManager: pm,
    } as ControlHandlerContext;

    const result = handleProjectInfo(createCommand('project-info', 'chat-1'), ctx);
    expect(result.success).toBe(true);
    expect(result.message).toContain('default');
    expect(result.message).toContain('CLAUDE.md');
    expect(result.message).toContain('./docs/');
  });
});
