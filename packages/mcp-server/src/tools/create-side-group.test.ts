/**
 * Tests for create_side_group tool (packages/mcp-server/src/tools/create-side-group.ts)
 *
 * Issue #2351: Context Offloading - Auto-create side group for long-form content delivery.
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
    if (type === 'ipc_unavailable') { return '❌ IPC 服务不可用。'; }
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

import { create_side_group } from './create-side-group.js';
import { getIpcClient } from '@disclaude/core';
import { getFeishuCredentials } from './credentials.js';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  createSideGroup: vi.fn(),
  sendMessage: vi.fn(),
  registerTempChat: vi.fn(),
};

describe('create_side_group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'test-app-id', appSecret: 'test-secret' });
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  describe('parameter validation', () => {
    it('should return error when name is empty', async () => {
      const result = await create_side_group({ name: '', members: ['ou_test123'] });
      expect(result.success).toBe(false);
      expect(result.error).toBe('name is required');
    });

    it('should return error when name is not provided', async () => {
      const result = await create_side_group({ name: undefined as any, members: ['ou_test123'] });
      expect(result.success).toBe(false);
      expect(result.error).toBe('name is required');
    });

    it('should truncate name exceeding max length', async () => {
      const longName = 'A'.repeat(100);
      const truncatedName = 'A'.repeat(64);
      mockIpcClient.createSideGroup.mockResolvedValue({ success: true, chatId: 'oc_new_group', name: truncatedName });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });
      const result = await create_side_group({ name: longName, members: ['ou_test123'] });
      expect(result.success).toBe(true);
      expect(mockIpcClient.createSideGroup).toHaveBeenCalledWith(truncatedName, ['ou_test123'], undefined);
    });

    it('should accept name at exactly max length', async () => {
      const exactName = 'A'.repeat(64);
      mockIpcClient.createSideGroup.mockResolvedValue({ success: true, chatId: 'oc_new_group', name: exactName });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true, expiresAt: '2099-12-31T23:59:59Z' });
      const result = await create_side_group({ name: exactName, members: ['ou_test123'] });
      expect(result.success).toBe(true);
    });

    it('should return error when members is empty array', async () => {
      const result = await create_side_group({ name: 'Test Group', members: [] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('non-empty array');
    });

    it('should return error when members is not provided', async () => {
      const result = await create_side_group({ name: 'Test Group', members: undefined as any });
      expect(result.success).toBe(false);
      expect(result.error).toContain('non-empty array');
    });

    it('should return error when member IDs are invalid format', async () => {
      const result = await create_side_group({ name: 'Test', members: ['invalid_id', 'ou_valid'] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid member IDs');
      expect(result.error).toContain('invalid_id');
    });

    it('should return error when Feishu credentials are missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: '', appSecret: '' });
      const result = await create_side_group({ name: 'Test', members: ['ou_test123'] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Feishu credentials');
    });

    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await create_side_group({ name: 'Test', members: ['ou_test123'] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC');
    });
  });

  describe('successful group creation', () => {
    it('should create group and return chatId', async () => {
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: true,
        chatId: 'oc_new_side_group',
        name: 'Test Group',
      });
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: true,
        expiresAt: '2099-12-31T23:59:59Z',
      });

      const result = await create_side_group({
        name: 'Test Group',
        members: ['ou_user1'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_side_group');
      expect(result.name).toBe('Test Group');
      expect(result.message).toContain('Test Group');
      expect(mockIpcClient.createSideGroup).toHaveBeenCalledWith('Test Group', ['ou_user1'], undefined);
    });

    it('should send content to the new group when provided', async () => {
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: 'Test',
      });
      mockIpcClient.sendMessage.mockResolvedValue({ success: true });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });

      const result = await create_side_group({
        name: 'Test',
        members: ['ou_user1'],
        content: 'Hello, this is the content!',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('内容已发送');
      expect(mockIpcClient.sendMessage).toHaveBeenCalledWith('oc_new_group', 'Hello, this is the content!');
    });

    it('should handle content delivery failure gracefully', async () => {
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: 'Test',
      });
      mockIpcClient.sendMessage.mockResolvedValue({ success: false, error: 'send failed' });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });

      const result = await create_side_group({
        name: 'Test',
        members: ['ou_user1'],
        content: 'Content that fails to send',
      });

      // Should still succeed — group was created
      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_group');
    });

    it('should register temp chat with correct params', async () => {
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: 'Test',
      });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });

      const result = await create_side_group({
        name: 'Test',
        members: ['ou_user1'],
        parentChatId: 'oc_parent',
        expiresInHours: 48,
      });

      expect(result.success).toBe(true);
      expect(mockIpcClient.registerTempChat).toHaveBeenCalledWith(
        'oc_new_group',
        expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/),
        'oc_parent',
        { source: 'side-group', name: 'Test' },
        { triggerMode: 'always' },
      );
    });

    it('should handle temp chat registration failure gracefully', async () => {
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: 'Test',
      });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: false, error: 'registration failed' });

      const result = await create_side_group({
        name: 'Test',
        members: ['ou_user1'],
      });

      // Should still succeed — group was created
      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new_group');
    });

    it('should truncate long group names', async () => {
      const longName = 'A'.repeat(100);
      const truncatedName = 'A'.repeat(64);
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: truncatedName,
      });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });

      const result = await create_side_group({
        name: longName,
        members: ['ou_user1'],
      });

      expect(result.success).toBe(true);
      expect(mockIpcClient.createSideGroup).toHaveBeenCalledWith(truncatedName, ['ou_user1'], undefined);
    });

    it('should pass description to IPC', async () => {
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: 'Test',
      });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });

      await create_side_group({
        name: 'Test',
        members: ['ou_user1'],
        description: 'A test group',
      });

      expect(mockIpcClient.createSideGroup).toHaveBeenCalledWith('Test', ['ou_user1'], 'A test group');
    });

    it('should support multiple members', async () => {
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: 'Team Group',
      });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });

      const result = await create_side_group({
        name: 'Team Group',
        members: ['ou_user1', 'ou_user2', 'ou_user3'],
      });

      expect(result.success).toBe(true);
      expect(mockIpcClient.createSideGroup).toHaveBeenCalledWith(
        'Team Group',
        ['ou_user1', 'ou_user2', 'ou_user3'],
        undefined,
      );
    });
  });

  describe('group creation failure', () => {
    it('should return error when IPC createSideGroup fails', async () => {
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: false,
        error: 'Group creation failed: API error',
        errorType: 'ipc_request_failed',
      });

      const result = await create_side_group({
        name: 'Test',
        members: ['ou_user1'],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('群聊创建失败');
      expect(mockIpcClient.sendMessage).not.toHaveBeenCalled();
      expect(mockIpcClient.registerTempChat).not.toHaveBeenCalled();
    });

    it('should return error when IPC createSideGroup returns no chatId', async () => {
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: true,
        chatId: undefined,
      });

      const result = await create_side_group({
        name: 'Test',
        members: ['ou_user1'],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('群聊创建失败');
    });
  });

  describe('edge cases', () => {
    it('should use default 24h expiry when expiresInHours not specified', async () => {
      mockIpcClient.createSideGroup.mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: 'Test',
      });
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });

      const now = Date.now();
      await create_side_group({ name: 'Test', members: ['ou_user1'] });

      const expiresAt = new Date(mockIpcClient.registerTempChat.mock.calls[0][1]).getTime();
      const expectedMin = now + 23 * 60 * 60 * 1000; // ~23h
      const expectedMax = now + 25 * 60 * 60 * 1000; // ~25h
      expect(expiresAt).toBeGreaterThan(expectedMin);
      expect(expiresAt).toBeLessThan(expectedMax);
    });

    it('should handle unexpected errors', async () => {
      mockIpcClient.createSideGroup.mockRejectedValue(new Error('Unexpected error'));

      const result = await create_side_group({
        name: 'Test',
        members: ['ou_user1'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unexpected error');
    });
  });
});
