/**
 * Tests for rename_chat tool (packages/mcp-server/src/tools/rename-group.ts)
 *
 * Issue #2284: Auto-rename group when bot is added and assigned a task.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  getIpcClient: vi.fn(),
}));

vi.mock('./credentials.js', () => ({
  getFeishuCredentials: vi.fn(),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type?: string, originalError?: string) => {
    if (type === 'ipc_unavailable') {return '❌ IPC 服务不可用。';}
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

import { rename_chat } from './rename-group.js';
import { getIpcClient } from '@disclaude/core';
import { getFeishuCredentials } from './credentials.js';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  renameGroup: vi.fn(),
};

describe('rename_chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'test-app-id', appSecret: 'test-secret' });
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  describe('parameter validation', () => {
    it('should return error when chatId is empty', async () => {
      const result = await rename_chat({ chatId: '', groupName: 'Test Group' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('chatId is required');
    });

    it('should return error when groupName is empty', async () => {
      const result = await rename_chat({ chatId: 'oc_test', groupName: '' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('groupName is required and cannot be empty');
    });

    it('should return error when groupName is only whitespace', async () => {
      const result = await rename_chat({ chatId: 'oc_test', groupName: '   ' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('groupName is required and cannot be empty');
    });
  });

  describe('credential validation', () => {
    it('should return error when appId is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: undefined, appSecret: 'secret' });
      const result = await rename_chat({ chatId: 'oc_test', groupName: 'Test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('credentials not configured');
    });

    it('should return error when appSecret is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'app-id', appSecret: undefined });
      const result = await rename_chat({ chatId: 'oc_test', groupName: 'Test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('credentials not configured');
    });
  });

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await rename_chat({ chatId: 'oc_test', groupName: 'Test Group' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC');
    });
  });

  describe('successful rename', () => {
    it('should rename group successfully', async () => {
      mockIpcClient.renameGroup.mockResolvedValue({ success: true });
      const result = await rename_chat({ chatId: 'oc_test', groupName: 'New Task Group' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('New Task Group');
      expect(mockIpcClient.renameGroup).toHaveBeenCalledWith('oc_test', 'New Task Group');
    });

    it('should truncate group name to 64 characters', async () => {
      const longName = 'A'.repeat(100);
      const expectedTruncated = 'A'.repeat(64);
      mockIpcClient.renameGroup.mockResolvedValue({ success: true });
      const result = await rename_chat({ chatId: 'oc_test', groupName: longName });
      expect(result.success).toBe(true);
      expect(mockIpcClient.renameGroup).toHaveBeenCalledWith('oc_test', expectedTruncated);
    });

    it('should handle CJK characters in group name correctly', async () => {
      const cjkName = '任务群：用户登录优化需求分析';
      mockIpcClient.renameGroup.mockResolvedValue({ success: true });
      const result = await rename_chat({ chatId: 'oc_test', groupName: cjkName });
      expect(result.success).toBe(true);
      expect(mockIpcClient.renameGroup).toHaveBeenCalledWith('oc_test', cjkName);
    });
  });

  describe('IPC errors', () => {
    it('should return error when IPC rename fails', async () => {
      mockIpcClient.renameGroup.mockResolvedValue({
        success: false,
        error: 'Permission denied',
      });
      const result = await rename_chat({ chatId: 'oc_test', groupName: 'Test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('操作失败');
    });
  });
});
