/**
 * Tests for register_temp_chat tool (packages/mcp-server/src/tools/register-temp-chat.ts)
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
    if (type === 'ipc_unavailable') return '❌ IPC 服务不可用。';
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

import { register_temp_chat } from './register-temp-chat.js';
import { getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  registerTempChat: vi.fn(),
};

describe('register_temp_chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await register_temp_chat({ chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC');
    });
  });

  describe('successful registration', () => {
    it('should register temp chat with chatId only', async () => {
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: true, chatId: 'oc_test', expiresAt: '2026-04-05T12:00:00Z',
      });
      const result = await register_temp_chat({ chatId: 'oc_test' });
      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_test');
      expect(result.expiresAt).toBe('2026-04-05T12:00:00Z');
    });

    it('should pass all optional parameters to IPC', async () => {
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: true, chatId: 'oc_test', expiresAt: '2026-04-05T12:00:00Z',
      });
      const context = { source: 'scheduler', taskId: '123' };
      await register_temp_chat({
        chatId: 'oc_test',
        expiresAt: '2026-04-05T12:00:00Z',
        creatorChatId: 'oc_creator',
        context,
      });
      expect(mockIpcClient.registerTempChat).toHaveBeenCalledWith(
        'oc_test', '2026-04-05T12:00:00Z', 'oc_creator', context
      );
    });

    it('should use default expiresAt when not provided', async () => {
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: true, chatId: 'oc_test', expiresAt: undefined,
      });
      const result = await register_temp_chat({ chatId: 'oc_test' });
      expect(result.message).toContain('24h default');
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC registration fails', async () => {
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: false, error: 'Already exists', errorType: 'ipc_request_failed',
      });
      const result = await register_temp_chat({ chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Already exists');
    });
  });

  describe('error handling', () => {
    it('should catch unexpected errors and return error result', async () => {
      vi.mocked(getIpcClient).mockImplementation(() => { throw new Error('Unexpected'); });
      const result = await register_temp_chat({ chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Unexpected');
    });

    it('should handle non-Error objects in catch', async () => {
      vi.mocked(getIpcClient).mockImplementation(() => { throw 'string error'; });
      const result = await register_temp_chat({ chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });
});
