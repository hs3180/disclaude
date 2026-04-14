/**
 * Tests for create_side_chat tool (packages/mcp-server/src/tools/create-side-chat.ts)
 *
 * Issue #2351: Context Offloading - Auto-create side group for long-form content delivery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { execFile } from 'node:child_process';
import { create_side_chat, _internal } from './create-side-chat.js';

const mockExecFile = vi.mocked(execFile);

// Helper to create a successful lark-cli response
function mockLarkSuccess(chatId: string) {
  const callback = (_cmd: string, _args: string[], opts: any, cb: Function) => {
    if (typeof opts === 'function') {
      cb = opts;
    }
    cb(null, { stdout: JSON.stringify({ data: { chat_id: chatId } }), stderr: '' });
  };
  return callback;
}

// Helper to create a failed lark-cli response
function mockLarkError(stderr: string) {
  const callback = (_cmd: string, _args: string[], opts: any, cb: Function) => {
    if (typeof opts === 'function') {
      cb = opts;
    }
    const err = new Error('Command failed') as any;
    err.stdout = '';
    err.stderr = stderr;
    cb(err, { stdout: '', stderr });
  };
  return callback;
}

describe('create_side_chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation', () => {
    it('should reject empty name', async () => {
      const result = await create_side_chat({ name: '', members: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('群名称不能为空');
    });

    it('should reject invalid group name characters', async () => {
      const result = await create_side_chat({ name: 'test<script>', members: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('不安全字符');
    });

    it('should accept valid group name with CJK characters', async () => {
      mockExecFile.mockImplementation(mockLarkSuccess('oc_new123') as any);
      const result = await create_side_chat({ name: '配置方案 2024', members: ['ou_abc123'] });
      expect(result.success).toBe(true);
    });

    it('should reject empty members array', async () => {
      const result = await create_side_chat({ name: 'Test Group', members: [] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('至少一个成员');
    });

    it('should reject invalid member ID format', async () => {
      const result = await create_side_chat({ name: 'Test Group', members: ['invalid_id'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('成员 ID 格式错误');
    });

    it('should reject mix of valid and invalid member IDs', async () => {
      const result = await create_side_chat({ name: 'Test Group', members: ['ou_valid123', 'bad_id'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('成员 ID 格式错误');
    });
  });

  describe('successful group creation', () => {
    it('should create group and return chatId', async () => {
      mockExecFile.mockImplementation(mockLarkSuccess('oc_newchat123456789') as any);

      const result = await create_side_chat({
        name: 'LiteLLM 配置方案',
        members: ['ou_abc123', 'ou_def456'],
        parentChatId: 'oc_parent123',
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_newchat123456789');
      expect(result.message).toContain('oc_newchat123456789');
      expect(result.message).toContain('LiteLLM 配置方案');
    });

    it('should call lark-cli with correct arguments', async () => {
      mockExecFile.mockImplementation(mockLarkSuccess('oc_new') as any);

      await create_side_chat({
        name: 'Test Group',
        members: ['ou_abc123'],
      });

      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const call = mockExecFile.mock.calls[0]!;
      expect(call[0]).toBe('lark-cli');
      expect(call[1]).toEqual(['im', '+chat-create', '--name', 'Test Group', '--users', 'ou_abc123']);
    });

    it('should truncate long group names', async () => {
      mockExecFile.mockImplementation(mockLarkSuccess('oc_new') as any);

      const longName = 'A'.repeat(100);
      await create_side_chat({
        name: longName,
        members: ['ou_abc123'],
      });

      const call = mockExecFile.mock.calls[0]!;
      const nameArg = call[1]![4] as string;
      expect(nameArg.length).toBeLessThanOrEqual(64);
    });

    it('should work without parentChatId', async () => {
      mockExecFile.mockImplementation(mockLarkSuccess('oc_newchat') as any);

      const result = await create_side_chat({
        name: 'Test Group',
        members: ['ou_abc123'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_newchat');
    });
  });

  describe('lark-cli failure', () => {
    it('should handle lark-cli execution error', async () => {
      mockExecFile.mockImplementation(mockLarkError('rate limit exceeded') as any);

      const result = await create_side_chat({
        name: 'Test Group',
        members: ['ou_abc123'],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('创建群聊失败');
    });

    it('should handle non-JSON response from lark-cli', async () => {
      const callback = (_cmd: string, _args: string[], opts: any, cb: Function) => {
        if (typeof opts === 'function') { cb = opts; }
        cb(null, { stdout: 'not json', stderr: '' });
      };
      mockExecFile.mockImplementation(callback as any);

      const result = await create_side_chat({
        name: 'Test Group',
        members: ['ou_abc123'],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('未获得群聊 ID');
    });

    it('should handle JSON response without chat_id', async () => {
      const callback = (_cmd: string, _args: string[], opts: any, cb: Function) => {
        if (typeof opts === 'function') { cb = opts; }
        cb(null, { stdout: JSON.stringify({ data: {} }), stderr: '' });
      };
      mockExecFile.mockImplementation(callback as any);

      const result = await create_side_chat({
        name: 'Test Group',
        members: ['ou_abc123'],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('未获得群聊 ID');
    });
  });

  describe('unexpected errors', () => {
    it('should catch unexpected errors and return error result', async () => {
      mockExecFile.mockImplementation(() => { throw new Error('Unexpected'); });

      const result = await create_side_chat({
        name: 'Test Group',
        members: ['ou_abc123'],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Unexpected');
    });

    it('should handle execFile throwing non-Error objects', async () => {
      // eslint-disable-next-line no-throw-literal
      mockExecFile.mockImplementation((() => { throw 'string error'; }) as any);

      const result = await create_side_chat({
        name: 'Test Group',
        members: ['ou_abc123'],
      });

      expect(result.success).toBe(false);
      // The inner catch around lark-cli handles this
      expect(result.message).toContain('创建群聊失败');
    });
  });
});

describe('create_side_chat _internal helpers', () => {
  describe('isValidMemberId', () => {
    it('should accept valid ou_ format', () => {
      expect(_internal.isValidMemberId('ou_abc123')).toBe(true);
    });

    it('should reject invalid formats', () => {
      expect(_internal.isValidMemberId('invalid')).toBe(false);
      expect(_internal.isValidMemberId('ou_')).toBe(false);
      expect(_internal.isValidMemberId('oc_abc123')).toBe(false);
      expect(_internal.isValidMemberId('')).toBe(false);
    });
  });

  describe('isValidGroupName', () => {
    it('should accept valid group names', () => {
      expect(_internal.isValidGroupName('Test Group')).toBe(true);
      expect(_internal.isValidGroupName('配置方案 (v2)')).toBe(true);
      expect(_internal.isValidGroupName('project-v1.0')).toBe(true);
    });

    it('should reject names with unsafe characters', () => {
      expect(_internal.isValidGroupName('<script>')).toBe(false);
      expect(_internal.isValidGroupName('test$var')).toBe(false);
    });
  });

  describe('truncateGroupName', () => {
    it('should truncate to max length', () => {
      const name = 'A'.repeat(100);
      const truncated = _internal.truncateGroupName(name);
      expect(truncated.length).toBe(_internal.MAX_GROUP_NAME_LENGTH);
    });

    it('should not truncate short names', () => {
      const name = 'Short Name';
      expect(_internal.truncateGroupName(name)).toBe(name);
    });
  });
});
