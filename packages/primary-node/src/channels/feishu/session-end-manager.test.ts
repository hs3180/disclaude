/**
 * Tests for SessionEndManager.
 *
 * Simplified version — no file system dependencies, no session records.
 *
 * @see Issue #1229 - 智能会话结束 - 判断讨论何时可以关闭
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SessionEndManager } from './session-end-manager.js';
import type { TriggerResult } from './trigger-detector.js';

// Mock chat-ops
vi.mock('../../platforms/feishu/chat-ops.js', () => ({
  dissolveChat: vi.fn().mockResolvedValue(undefined),
}));

describe('SessionEndManager', () => {
  let sessionEndManager: SessionEndManager;
  let mockGroupService: any;
  let mockClient: any;

  beforeEach(() => {
    mockGroupService = {
      getGroup: vi.fn(),
      isManaged: vi.fn().mockReturnValue(true),
      unregisterGroup: vi.fn().mockReturnValue(true),
    };

    mockClient = {};

    sessionEndManager = new SessionEndManager(mockGroupService);
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

    it('should not process unmanaged groups', async () => {
      mockGroupService.isManaged.mockReturnValue(false);

      const result = await sessionEndManager.handleSessionEnd('oc_unknown', normalTrigger, mockClient);

      expect(result).toBe(false);
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

  describe('edge cases', () => {
    it('should handle group with no info', async () => {
      mockGroupService.isManaged.mockReturnValue(false);
      mockGroupService.getGroup.mockReturnValue(undefined);

      const result = await sessionEndManager.handleSessionEnd(
        'oc_unknown',
        { detected: true, rawMatch: '[DISCUSSION_END]' },
        mockClient
      );

      expect(result).toBe(false);
      expect(mockGroupService.unregisterGroup).not.toHaveBeenCalled();
    });
  });
});
