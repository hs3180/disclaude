/**
 * Tests for /taste command handler.
 *
 * @see Issue #2335 — feat(project): auto-summarize user taste
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ControlCommand } from '../../types/channel.js';
import type { ControlHandlerContext } from '../types.js';
import { TasteManager } from '../../taste/taste-manager.js';
import { createTasteHandler } from './taste.js';

describe('/taste command', () => {
  let tmpDir: string;
  let tasteManager: TasteManager;
  let handler: ReturnType<typeof createTasteHandler>;
  let mockContext: ControlHandlerContext;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-cmd-test-'));
    tasteManager = new TasteManager({ workspaceDir: tmpDir });
    handler = createTasteHandler(tasteManager);
    mockContext = {
      agentPool: { reset: () => {}, stop: () => false },
      node: {
        nodeId: 'test-node',
        getExecNodes: () => [],
        getDebugGroup: () => null,
        setDebugGroup: () => {},
        clearDebugGroup: () => null,
      },
    };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeCommand(subcommand: string, chatId = 'chat1'): ControlCommand {
    return {
      type: 'taste',
      chatId,
      data: { text: subcommand },
    };
  }

  describe('list', () => {
    it('should show empty list when no rules', () => {
      const result = handler(makeCommand('list'), mockContext);
      expect(result.success).toBe(true);
      expect(result.message).toContain('没有已记录的偏好规则');
    });

    it('should list existing rules', () => {
      tasteManager.addRule('chat1', 'code_style', 'Use const', 'manual');
      tasteManager.addRule('chat1', 'interaction', 'Be concise', 'manual');

      const result = handler(makeCommand('list'), mockContext);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Use const');
      expect(result.message).toContain('Be concise');
      expect(result.message).toContain('代码风格');
      expect(result.message).toContain('交互偏好');
    });

    it('should default to list when no subcommand', () => {
      const result = handler(makeCommand(''), mockContext);
      expect(result.success).toBe(true);
    });
  });

  describe('add', () => {
    it('should add a new rule', () => {
      const result = handler(
        makeCommand('add code_style Use const/let only'),
        mockContext,
      );
      expect(result.success).toBe(true);
      expect(result.message).toContain('已添加偏好规则');
      expect(result.message).toContain('Use const/let only');
    });

    it('should reject missing arguments', () => {
      const result = handler(makeCommand('add'), mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('用法');
    });

    it('should reject invalid category', () => {
      const result = handler(makeCommand('add invalid_category some rule'), mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('未知分类');
    });
  });

  describe('remove', () => {
    it('should remove an existing rule', () => {
      const addResult = tasteManager.addRule('chat1', 'code_style', 'Use const', 'manual');
      const ruleId = addResult.data!.id;

      const result = handler(makeCommand(`remove ${ruleId}`), mockContext);
      expect(result.success).toBe(true);
      expect(result.message).toContain('已删除');

      // Verify it's gone
      const listResult = tasteManager.listRules('chat1');
      expect(listResult.data).toHaveLength(0);
    });

    it('should reject missing rule ID', () => {
      const result = handler(makeCommand('remove'), mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('用法');
    });
  });

  describe('reset', () => {
    it('should clear all rules', () => {
      tasteManager.addRule('chat1', 'code_style', 'Rule A');
      tasteManager.addRule('chat1', 'interaction', 'Rule B');

      const result = handler(makeCommand('reset'), mockContext);
      expect(result.success).toBe(true);
      expect(result.message).toContain('2 条');
    });
  });

  describe('unknown subcommand', () => {
    it('should return error for unknown subcommand', () => {
      const result = handler(makeCommand('unknown'), mockContext);
      expect(result.success).toBe(false);
      expect(result.error).toContain('未知子命令');
    });
  });
});
