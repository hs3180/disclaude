/**
 * Tests for create_side_group tool (packages/mcp-server/src/tools/create-side-group.ts)
 * Issue #2351: Context Offloading — auto-create side group for long-form content.
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

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
  getIpcErrorMessage: vi.fn((type?: string, originalError?: string) => {
    if (type === 'ipc_unavailable') {return '❌ IPC 服务不可用。';}
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

import { create_side_group } from './create-side-group.js';
import { getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  createGroup: vi.fn(),
  sendMessage: vi.fn(),
  registerTempChat: vi.fn(),
};

describe('create_side_group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  // ---- Input validation ----

  describe('input validation', () => {
    it('should return error when name is missing', async () => {
      const result = await create_side_group({ name: '', members: ['ou_abc'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('name is required');
    });

    it('should return error when members is empty', async () => {
      const result = await create_side_group({ name: 'Test Group', members: [] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('At least one member');
    });

    it('should return error for invalid member ID format', async () => {
      const result = await create_side_group({ name: 'Test Group', members: ['invalid_id'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid member ID');
    });

    it('should return error for invalid parentChatId', async () => {
      const result = await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
        parentChatId: 'invalid-chat-id',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('parentChatId');
    });

    it('should return error for invalid member ID format', async () => {
      // Invalid: doesn't match ou_xxxxx pattern
      const result = await create_side_group({ name: 'Test Group', members: ['invalid_id'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid member ID');
    });
  });

  // ---- IPC availability ----

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await create_side_group({ name: 'Test', members: ['ou_abc'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC');
    });
  });

  // ---- Successful creation ----

  describe('successful creation', () => {
    it('should create group with minimal params', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_new123',
      });

      const result = await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new123');
      expect(result.message).toContain('Test Group');
      expect(mockIpcClient.createGroup).toHaveBeenCalledWith('Test Group', ['ou_abc'], undefined);
    });

    it('should create group with description', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_new123',
      });

      await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
        description: 'A test group',
      });

      expect(mockIpcClient.createGroup).toHaveBeenCalledWith('Test Group', ['ou_abc'], 'A test group');
    });

    it('should truncate long group names', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_new123',
      });

      const longName = 'A'.repeat(100);
      await create_side_group({
        name: longName,
        members: ['ou_abc'],
      });

      const [[calledName]] = mockIpcClient.createGroup.mock.calls;
      expect(calledName.length).toBe(64);
    });

    it('should send content messages after creation', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_new123',
      });
      mockIpcClient.sendMessage.mockResolvedValue({ success: true });

      const result = await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
        messages: ['Message 1', 'Message 2'],
      });

      expect(result.success).toBe(true);
      expect(mockIpcClient.sendMessage).toHaveBeenCalledTimes(2);
      expect(mockIpcClient.sendMessage).toHaveBeenCalledWith('oc_new123', 'Message 1');
      expect(mockIpcClient.sendMessage).toHaveBeenCalledWith('oc_new123', 'Message 2');
    });

    it('should register as temp chat when parentChatId and expiresAt provided', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_new123456789012345678901234567',
      });
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: true, expiresAt: '2026-04-26T10:00:00Z',
      });

      const result = await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
        parentChatId: 'oc_parent12345678901234567890123456',
        expiresAt: '2026-04-26T10:00:00Z',
      });

      expect(result.success).toBe(true);
      expect(mockIpcClient.registerTempChat).toHaveBeenCalledWith(
        'oc_new123456789012345678901234567',
        '2026-04-26T10:00:00Z',
        'oc_parent12345678901234567890123456',
        { type: 'context_offload', parentChatId: 'oc_parent12345678901234567890123456' },
        { triggerMode: 'always' },  // default triggerMode
      );
    });

    it('should use provided triggerMode for temp chat registration', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_new123456789012345678901234567',
      });
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: true, expiresAt: '2026-04-26T10:00:00Z',
      });

      await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
        parentChatId: 'oc_parent12345678901234567890123456',
        expiresAt: '2026-04-26T10:00:00Z',
        triggerMode: 'mention',
      });

      expect(mockIpcClient.registerTempChat).toHaveBeenCalledWith(
        'oc_new123456789012345678901234567',
        '2026-04-26T10:00:00Z',
        'oc_parent12345678901234567890123456',
        { type: 'context_offload', parentChatId: 'oc_parent12345678901234567890123456' },
        { triggerMode: 'mention' },
      );
    });

    it('should not register temp chat when only parentChatId is provided (no expiresAt)', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_new123456789012345678901234567',
      });

      await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
        parentChatId: 'oc_parent12345678901234567890123456',
        // No expiresAt
      });

      expect(mockIpcClient.registerTempChat).not.toHaveBeenCalled();
    });

    it('should continue sending messages even if one fails', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_new123',
      });
      mockIpcClient.sendMessage
        .mockResolvedValueOnce({ success: false, error: 'rate limited' })
        .mockResolvedValueOnce({ success: true });

      const result = await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
        messages: ['Message 1', 'Message 2'],
      });

      expect(result.success).toBe(true);
      expect(mockIpcClient.sendMessage).toHaveBeenCalledTimes(2);
    });

    it('should skip empty messages', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_new123',
      });

      await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
        messages: ['Hello', '', 'World'],
      });

      // Only 2 calls (empty string skipped)
      expect(mockIpcClient.sendMessage).toHaveBeenCalledTimes(2);
    });
  });

  // ---- IPC failure ----

  describe('IPC failure', () => {
    it('should return error when group creation fails', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: false, error: 'Permission denied', errorType: 'ipc_request_failed',
      });

      const result = await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('群聊创建失败');
    });

    it('should return error when createGroup returns no chatId', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: undefined,
      });

      const result = await create_side_group({
        name: 'Test Group',
        members: ['ou_abc'],
      });

      expect(result.success).toBe(false);
    });
  });

  // ---- Error handling ----

  describe('error handling', () => {
    it('should catch unexpected errors and return error result', async () => {
      vi.mocked(getIpcClient).mockImplementation(() => { throw new Error('Unexpected'); });
      const result = await create_side_group({ name: 'Test', members: ['ou_abc'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unexpected');
    });

    it('should handle non-Error objects in catch', async () => {
      // eslint-disable-next-line no-throw-literal
      vi.mocked(getIpcClient).mockImplementation(() => { throw 'string error'; });
      const result = await create_side_group({ name: 'Test', members: ['ou_abc'] });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });
});
