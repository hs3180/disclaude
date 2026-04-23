/**
 * Tests for create_group tool (packages/mcp-server/src/tools/create-group.ts)
 *
 * Issue #2351: Context Offloading — side group creation.
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

import { create_group } from './create-group.js';
import { getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  createGroup: vi.fn(),
};

describe('create_group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  describe('input validation', () => {
    it('should return error when name is empty', async () => {
      const result = await create_group({ name: '' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('required');
    });

    it('should return error when name is missing', async () => {
      const result = await create_group({ name: undefined as unknown as string });
      expect(result.success).toBe(false);
      expect(result.message).toContain('required');
    });
  });

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await create_group({ name: 'Test Group' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC');
    });
  });

  describe('successful group creation', () => {
    it('should create group with name only', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_newgroup123',
      });
      const result = await create_group({ name: 'Test Group' });
      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_newgroup123');
      expect(result.message).toContain('Test Group');
      expect(result.message).toContain('oc_newgroup123');
      expect(mockIpcClient.createGroup).toHaveBeenCalledWith('Test Group', undefined, undefined);
    });

    it('should create group with description and members', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: true, chatId: 'oc_newgroup456',
      });
      const result = await create_group({
        name: 'Config Review',
        description: 'Configuration files for review',
        members: ['ou_user1', 'ou_user2'],
      });
      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_newgroup456');
      expect(result.message).toContain('2 member(s)');
      expect(mockIpcClient.createGroup).toHaveBeenCalledWith(
        'Config Review',
        'Configuration files for review',
        ['ou_user1', 'ou_user2'],
      );
    });
  });

  describe('error handling', () => {
    it('should handle IPC failure', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: false, error: 'Permission denied', errorType: 'ipc_request_failed',
      });
      const result = await create_group({ name: 'Test Group' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');
    });

    it('should handle IPC timeout', async () => {
      mockIpcClient.createGroup.mockResolvedValue({
        success: false, error: 'IPC_TIMEOUT', errorType: 'ipc_timeout',
      });
      const result = await create_group({ name: 'Test Group' });
      expect(result.success).toBe(false);
    });

    it('should handle unexpected errors', async () => {
      mockIpcClient.createGroup.mockRejectedValue(new Error('Unexpected error'));
      const result = await create_group({ name: 'Test Group' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unexpected error');
    });
  });
});
