/**
 * Tests for SessionEndManager.
 *
 * @see Issue #1229 - 智能会话结束 - 判断讨论何时可以关闭
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionEndManager } from './session-end-manager.js';
import type { TriggerResult } from './trigger-detector.js';

// Mock chat-ops
vi.mock('../../platforms/feishu/chat-ops.js', () => ({
  dissolveChat: vi.fn().mockResolvedValue(undefined),
}));

describe('SessionEndManager', () => {
  let tempDir: string;
  let sessionEndManager: SessionEndManager;
  let mockGroupService: any;
  let mockClient: any;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-end-test-'));

    mockGroupService = {
      getGroup: vi.fn(),
      isManaged: vi.fn().mockReturnValue(true),
      unregisterGroup: vi.fn().mockReturnValue(true),
    };

    mockClient = {};

    sessionEndManager = new SessionEndManager({
      groupService: mockGroupService,
      workspaceDir: tempDir,
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('handleSessionEnd', () => {
    const normalTrigger: TriggerResult = {
      detected: true,
      rawMatch: '[DISCUSSION_END]',
    };

    const timeoutTrigger: TriggerResult = {
      detected: true,
      reason: 'timeout',
      rawMatch: '[DISCUSSION_END:timeout]',
    };

    const summaryTrigger: TriggerResult = {
      detected: true,
      summary: '达成共识，选择方案A',
      rawMatch: '[DISCUSSION_END:summary=达成共识，选择方案A]',
    };

    it('should unregister group from GroupService', async () => {
      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_test123',
        name: 'Test Discussion',
        createdAt: Date.now() - 60000,
      });

      await sessionEndManager.handleSessionEnd('oc_test123', normalTrigger, mockClient);

      expect(mockGroupService.unregisterGroup).toHaveBeenCalledWith('oc_test123');
    });

    it('should not unregister if group is not managed', async () => {
      mockGroupService.isManaged.mockReturnValue(false);
      mockGroupService.getGroup.mockReturnValue(undefined);

      await sessionEndManager.handleSessionEnd('oc_unknown', normalTrigger, mockClient);

      expect(mockGroupService.unregisterGroup).not.toHaveBeenCalled();
    });

    it('should call dissolveChat for managed group', async () => {
      const { dissolveChat } = await import('../../platforms/feishu/chat-ops.js');

      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_test123',
        name: 'Test Discussion',
        createdAt: Date.now() - 60000,
      });

      await sessionEndManager.handleSessionEnd('oc_test123', normalTrigger, mockClient);

      expect(dissolveChat).toHaveBeenCalledWith(mockClient, 'oc_test123');
    });

    it('should return true on success', async () => {
      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_test123',
        name: 'Test Discussion',
        createdAt: Date.now() - 60000,
      });

      const result = await sessionEndManager.handleSessionEnd('oc_test123', normalTrigger, mockClient);

      expect(result).toBe(true);
    });

    it('should handle timeout trigger', async () => {
      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_timeout',
        name: 'Timeout Discussion',
        createdAt: Date.now() - 120000,
      });

      await sessionEndManager.handleSessionEnd('oc_timeout', timeoutTrigger, mockClient);

      expect(mockGroupService.unregisterGroup).toHaveBeenCalledWith('oc_timeout');
    });

    it('should handle trigger with summary', async () => {
      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_summary',
        name: 'Summary Discussion',
        createdAt: Date.now() - 180000,
      });

      await sessionEndManager.handleSessionEnd('oc_summary', summaryTrigger, mockClient);

      expect(mockGroupService.unregisterGroup).toHaveBeenCalledWith('oc_summary');
    });

    it('should return false when dissolveChat fails', async () => {
      const { dissolveChat } = await import('../../platforms/feishu/chat-ops.js');
      (dissolveChat as any).mockRejectedValueOnce(new Error('API error'));

      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_fail',
        name: 'Fail Discussion',
        createdAt: Date.now(),
      });

      const result = await sessionEndManager.handleSessionEnd('oc_fail', normalTrigger, mockClient);

      expect(result).toBe(false);
    });

    it('should still unregister group even if dissolveChat fails', async () => {
      const { dissolveChat } = await import('../../platforms/feishu/chat-ops.js');
      (dissolveChat as any).mockRejectedValueOnce(new Error('API error'));

      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_fail2',
        name: 'Fail Discussion 2',
        createdAt: Date.now(),
      });

      await sessionEndManager.handleSessionEnd('oc_fail2', normalTrigger, mockClient);

      expect(mockGroupService.unregisterGroup).toHaveBeenCalledWith('oc_fail2');
    });
  });

  describe('session records', () => {
    const summaryTrigger: TriggerResult = {
      detected: true,
      summary: '讨论结果：采用方案A',
      rawMatch: '[DISCUSSION_END:summary=讨论结果：采用方案A]',
    };

    it('should save session record to file', async () => {
      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_record',
        name: 'Record Test',
        createdAt: Date.now() - 300000,
      });

      await sessionEndManager.handleSessionEnd('oc_record', summaryTrigger, mockClient);

      const recordsPath = path.join(tempDir, 'workspace', 'session-records.md');
      expect(fs.existsSync(recordsPath)).toBe(true);

      const content = fs.readFileSync(recordsPath, 'utf-8');
      expect(content).toContain('会话记录');
      expect(content).toContain('Record Test');
      expect(content).toContain('讨论结果：采用方案A');
    });

    it('should append to existing session records', async () => {
      const recordsDir = path.join(tempDir, 'workspace');
      fs.mkdirSync(recordsDir, { recursive: true });
      const recordsPath = path.join(recordsDir, 'session-records.md');
      fs.writeFileSync(recordsPath, '# 会话记录\n\nPrevious record.\n', 'utf-8');

      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_append',
        name: 'Append Test',
        createdAt: Date.now() - 60000,
      });

      await sessionEndManager.handleSessionEnd('oc_append', summaryTrigger, mockClient);

      const content = fs.readFileSync(recordsPath, 'utf-8');
      expect(content).toContain('Previous record');
      expect(content).toContain('Append Test');
    });

    it('should calculate session duration', async () => {
      const createdAt = Date.now() - 600000; // 10 minutes ago
      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_duration',
        name: 'Duration Test',
        createdAt,
      });

      await sessionEndManager.handleSessionEnd('oc_duration', summaryTrigger, mockClient);

      const recordsPath = path.join(tempDir, 'workspace', 'session-records.md');
      const content = fs.readFileSync(recordsPath, 'utf-8');
      expect(content).toContain('10分钟');
    });

    it('should not fail if workspace dir does not exist', async () => {
      // Use a non-existent temp directory
      const nonExistentDir = path.join(tempDir, 'nonexistent', 'deep');
      const manager = new SessionEndManager({
        groupService: mockGroupService,
        workspaceDir: nonExistentDir,
      });

      mockGroupService.getGroup.mockReturnValue({
        chatId: 'oc_mkdir',
        name: 'Mkdir Test',
        createdAt: Date.now(),
      });

      await expect(
        manager.handleSessionEnd('oc_mkdir', summaryTrigger, mockClient as any)
      ).resolves.toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle group with no info', async () => {
      mockGroupService.isManaged.mockReturnValue(false);
      mockGroupService.getGroup.mockReturnValue(undefined);

      await sessionEndManager.handleSessionEnd(
        'oc_unknown',
        { detected: true, rawMatch: '[DISCUSSION_END]' },
        mockClient
      );

      // Should not throw, just skip unregister
      expect(mockGroupService.unregisterGroup).not.toHaveBeenCalled();
    });
  });
});
