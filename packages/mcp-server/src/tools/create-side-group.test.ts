/**
 * Tests for create_side_group tool (packages/mcp-server/src/tools/create-side-group.ts)
 *
 * Issue #2351: Context Offloading — side group for long-form content delivery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';

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
    if (type === 'ipc_unavailable') { return '❌ IPC 服务不可用。'; }
    return `❌ 操作失败: ${originalError ?? '未知错误'}`;
  }),
}));

// Mock execFile to be called by the tool
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { create_side_group } from './create-side-group.js';
import { getIpcClient } from '@disclaude/core';
import { isIpcAvailable } from './ipc-utils.js';

const mockExecFile = vi.mocked(execFile);

const mockIpcClient = {
  registerTempChat: vi.fn(),
};

/** Helper to mock successful lark-cli group creation */
function mockSuccessfulGroupCreation(chatId = 'oc_newgroup') {
  mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: any, cb: Function) => {
    const callback = typeof cb === 'function' ? cb : _opts;
    callback(null, { stdout: JSON.stringify({ data: { chat_id: chatId } }), stderr: '' });
  }) as any);
}

describe('create_side_group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
  });

  describe('input validation', () => {
    it('should return error when name is empty', async () => {
      const result = await create_side_group({ name: '', members: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('群名称');
    });

    it('should return error when name is not a string', async () => {
      const result = await create_side_group({ name: 123 as any, members: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('群名称');
    });

    it('should return error when members is empty array', async () => {
      const result = await create_side_group({ name: 'Test Group', members: [] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('成员');
    });

    it('should return error when members is not an array', async () => {
      const result = await create_side_group({ name: 'Test Group', members: 'ou_abc' as any });
      expect(result.success).toBe(false);
      expect(result.message).toContain('成员');
    });

    it('should return error when member ID has invalid format', async () => {
      const result = await create_side_group({ name: 'Test Group', members: ['invalid_id'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid_id');
    });

    it('should return error when member ID starts with wrong prefix', async () => {
      const result = await create_side_group({ name: 'Test Group', members: ['ui_abc123'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('ui_abc123');
    });

    it('should accept valid member IDs', async () => {
      mockSuccessfulGroupCreation();
      const result = await create_side_group({ name: 'Test', members: ['ou_abc123', 'ou_def456'] });
      expect(result.success).toBe(true);
    });
  });

  describe('lark-cli group creation', () => {
    it('should call lark-cli with correct arguments', async () => {
      mockSuccessfulGroupCreation();

      await create_side_group({ name: 'My Group', members: ['ou_user1', 'ou_user2'] });

      expect(mockExecFile).toHaveBeenCalledWith(
        'lark-cli',
        ['im', '+chat-create', '--name', 'My Group', '--users', 'ou_user1,ou_user2'],
        expect.objectContaining({ timeout: 30000, maxBuffer: 1048576 }),
        expect.any(Function),
      );
    });

    it('should return chatId on successful creation', async () => {
      mockSuccessfulGroupCreation('oc_created123');

      const result = await create_side_group({ name: 'Test Group', members: ['ou_abc123'] });
      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_created123');
      expect(result.message).toContain('Test Group');
      expect(result.message).toContain('oc_created123');
    });

    it('should return error when lark-cli fails', async () => {
      mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        const callback = typeof cb === 'function' ? cb : _opts;
        callback(Object.assign(new Error('Command failed'), { stderr: 'API rate limited' }), { stdout: '', stderr: 'API rate limited' });
      }) as any);

      const result = await create_side_group({ name: 'Test Group', members: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('API rate limited');
      expect(result.message).toContain('创建群聊失败');
    });

    it('should return error when lark-cli returns invalid JSON', async () => {
      mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        const callback = typeof cb === 'function' ? cb : _opts;
        callback(null, { stdout: 'not json at all', stderr: '' });
      }) as any);

      const result = await create_side_group({ name: 'Test Group', members: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to parse chat_id');
    });

    it('should return error when lark-cli returns JSON without chat_id', async () => {
      mockExecFile.mockImplementation(((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        const callback = typeof cb === 'function' ? cb : _opts;
        callback(null, { stdout: JSON.stringify({ data: {} }), stderr: '' });
      }) as any);

      const result = await create_side_group({ name: 'Test Group', members: ['ou_abc123'] });
      expect(result.success).toBe(false);
    });
  });

  describe('lifecycle registration', () => {
    it('should register temp chat by default', async () => {
      mockSuccessfulGroupCreation();
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true, chatId: 'oc_newgroup' });

      await create_side_group({ name: 'Test', members: ['ou_abc123'] });

      expect(mockIpcClient.registerTempChat).toHaveBeenCalledWith(
        'oc_newgroup',
        undefined,
        undefined,
        { source: 'create_side_group', groupName: 'Test' },
        { triggerMode: 'always' },
      );
    });

    it('should pass expiresAt to register_temp_chat', async () => {
      mockSuccessfulGroupCreation();
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });

      await create_side_group({
        name: 'Test',
        members: ['ou_abc123'],
        expiresAt: '2026-04-25T10:00:00Z',
      });

      expect(mockIpcClient.registerTempChat).toHaveBeenCalledWith(
        'oc_newgroup',
        '2026-04-25T10:00:00Z',
        undefined,
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('should pass creatorChatId to register_temp_chat', async () => {
      mockSuccessfulGroupCreation();
      mockIpcClient.registerTempChat.mockResolvedValue({ success: true });

      await create_side_group({
        name: 'Test',
        members: ['ou_abc123'],
        creatorChatId: 'oc_parent_chat',
      });

      expect(mockIpcClient.registerTempChat).toHaveBeenCalledWith(
        'oc_newgroup',
        undefined,
        'oc_parent_chat',
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('should skip lifecycle registration when registerTempChat is false', async () => {
      mockSuccessfulGroupCreation();

      await create_side_group({
        name: 'Test',
        members: ['ou_abc123'],
        registerTempChat: false,
      });

      expect(mockIpcClient.registerTempChat).not.toHaveBeenCalled();
    });

    it('should still return success when lifecycle registration fails', async () => {
      mockSuccessfulGroupCreation();
      mockIpcClient.registerTempChat.mockResolvedValue({
        success: false,
        error: 'Already exists',
        errorType: 'ipc_request_failed',
      });

      const result = await create_side_group({ name: 'Test', members: ['ou_abc123'] });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_newgroup');
    });

    it('should still return success when IPC is unavailable for registration', async () => {
      mockSuccessfulGroupCreation();
      vi.mocked(isIpcAvailable).mockResolvedValue(false);

      const result = await create_side_group({ name: 'Test', members: ['ou_abc123'] });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_newgroup');
      expect(mockIpcClient.registerTempChat).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should catch unexpected errors from lark-cli', async () => {
      mockExecFile.mockImplementation(() => {
        throw new Error('lark-cli not found');
      });

      const result = await create_side_group({ name: 'Test', members: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.error).toContain('lark-cli not found');
    });
  });
});
