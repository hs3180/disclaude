/**
 * Tests for rename_chat tool (packages/mcp-server/src/tools/rename-chat.ts)
 * Issue #2284: Auto-rename group when bot is added and given a task.
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

import { rename_chat } from './rename-chat.js';
import { getIpcClient } from '@disclaude/core';
import { getFeishuCredentials } from './credentials.js';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  renameChat: vi.fn(),
};

describe('rename_chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'test-app-id', appSecret: 'test-secret' });
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  it('should rename a group chat successfully', async () => {
    mockIpcClient.renameChat.mockResolvedValue({ success: true });

    const result = await rename_chat({
      chatId: 'oc_test123',
      name: '需求分析 - 用户系统重构',
    });

    expect(result.success).toBe(true);
    expect(result.message).toContain('需求分析 - 用户系统重构');
    expect(mockIpcClient.renameChat).toHaveBeenCalledWith('oc_test123', '需求分析 - 用户系统重构');
  });

  it('should reject non-group chat IDs', async () => {
    const result = await rename_chat({
      chatId: 'ou_test123',
      name: 'Test',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('group chats');
    expect(mockIpcClient.renameChat).not.toHaveBeenCalled();
  });

  it('should reject empty name', async () => {
    const result = await rename_chat({
      chatId: 'oc_test123',
      name: '',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('name is required');
  });

  it('should reject missing chatId', async () => {
    const result = await rename_chat({
      chatId: '',
      name: 'Test Name',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('chatId is required');
  });

  it('should handle IPC unavailable', async () => {
    vi.mocked(isIpcAvailable).mockResolvedValue(false);

    const result = await rename_chat({
      chatId: 'oc_test123',
      name: 'Test Name',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('IPC');
  });

  it('should handle IPC failure', async () => {
    mockIpcClient.renameChat.mockResolvedValue({
      success: false,
      error: 'API error',
      errorType: 'ipc_request_failed',
    });

    const result = await rename_chat({
      chatId: 'oc_test123',
      name: 'Test Name',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('API error');
  });

  it('should handle missing Feishu credentials', async () => {
    vi.mocked(getFeishuCredentials).mockReturnValueOnce({ appId: '', appSecret: '' });

    const result = await rename_chat({
      chatId: 'oc_test123',
      name: 'Test Name',
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain('credentials');
  });
});
