/**
 * Tests for create_group tool (packages/mcp-server/src/tools/create-group.ts)
 * Issue #2351: Context Offloading — side group creation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @disclaude/core
vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));
vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { create_group } from './create-group.js';

describe('create_group', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('input validation', () => {
    it('should reject empty name', async () => {
      const result = await create_group({ name: '', memberIds: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('required');
    });

    it('should reject whitespace-only name', async () => {
      const result = await create_group({ name: '   ', memberIds: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('empty');
    });

    it('should reject name that is too long', async () => {
      const longName = 'A'.repeat(101);
      const result = await create_group({ name: longName, memberIds: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('too long');
    });

    it('should reject name with invalid characters', async () => {
      const result = await create_group({ name: 'Test<script>', memberIds: ['ou_abc123'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid characters');
    });

    it('should accept CJK characters in name', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ data: { chat_id: 'oc_new123' } }),
        stderr: '',
      });
      const result = await create_group({ name: '配置方案讨论', memberIds: ['ou_abc123'] });
      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_new123');
    });

    it('should accept name at max length boundary (100 chars)', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ data: { chat_id: 'oc_new123' } }),
        stderr: '',
      });
      const name100 = 'A'.repeat(100);
      const result = await create_group({ name: name100, memberIds: ['ou_abc123'] });
      expect(result.success).toBe(true);
    });

    it('should reject empty memberIds array', async () => {
      const result = await create_group({ name: 'Test Group', memberIds: [] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('At least one member');
    });

    it('should reject memberIds not in ou_ format', async () => {
      const result = await create_group({ name: 'Test Group', memberIds: ['invalid_id'] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid member ID');
      expect(result.message).toContain('ou_xxxxx');
    });

    it('should reject memberIds that are empty strings', async () => {
      const result = await create_group({ name: 'Test Group', memberIds: ['ou_abc', ''] });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Invalid member ID');
    });
  });

  describe('successful group creation', () => {
    it('should create group with single member', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ data: { chat_id: 'oc_newgroup1' } }),
        stderr: '',
      });

      const result = await create_group({
        name: 'Code Review',
        memberIds: ['ou_developer1'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_newgroup1');
      expect(result.name).toBe('Code Review');
      expect(result.message).toContain('Code Review');
      expect(result.message).toContain('oc_newgroup1');
      expect(result.message).toContain('send_text');

      // Verify lark-cli was called with correct arguments
      expect(mockExecFile).toHaveBeenCalledWith(
        'lark-cli',
        ['im', '+chat-create', '--name', 'Code Review', '--users', 'ou_developer1'],
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('should create group with multiple members', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ data: { chat_id: 'oc_multigroup' } }),
        stderr: '',
      });

      const result = await create_group({
        name: 'Team Discussion',
        memberIds: ['ou_user1', 'ou_user2', 'ou_user3'],
      });

      expect(result.success).toBe(true);
      expect(result.chatId).toBe('oc_multigroup');
      expect(mockExecFile).toHaveBeenCalledWith(
        'lark-cli',
        ['im', '+chat-create', '--name', 'Team Discussion', '--users', 'ou_user1,ou_user2,ou_user3'],
        expect.any(Object),
      );
    });

    it('should include description in success message when provided', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ data: { chat_id: 'oc_desc1' } }),
        stderr: '',
      });

      const result = await create_group({
        name: 'Config Files',
        memberIds: ['ou_user1'],
        description: 'LiteLLM configuration files',
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('LiteLLM configuration files');
    });

    it('should trim whitespace from group name', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ data: { chat_id: 'oc_trimmed' } }),
        stderr: '',
      });

      const result = await create_group({ name: '  Trimmed Name  ', memberIds: ['ou_user1'] });

      expect(result.success).toBe(true);
      expect(mockExecFile).toHaveBeenCalledWith(
        'lark-cli',
        expect.arrayContaining(['Trimmed Name']),
        expect.any(Object),
      );
    });
  });

  describe('lark-cli errors', () => {
    it('should return error when lark-cli is not found (ENOENT)', async () => {
      const enoentError = new Error('spawn lark-cli ENOENT');
      (enoentError as unknown as { code: string }).code = 'ENOENT';
      mockExecFile.mockRejectedValue(enoentError);

      const result = await create_group({ name: 'Test', memberIds: ['ou_user1'] });

      expect(result.success).toBe(false);
      expect(result.message).toContain('lark-cli not found');
    });

    it('should return error when lark-cli returns non-zero exit', async () => {
      mockExecFile.mockRejectedValue({
        stderr: 'Error: permission denied',
        code: 1,
        message: 'Command failed',
      });

      const result = await create_group({ name: 'Test', memberIds: ['ou_user1'] });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to create group');
    });

    it('should return error when lark-cli returns invalid JSON', async () => {
      mockExecFile.mockResolvedValue({
        stdout: 'Not JSON at all',
        stderr: '',
      });

      const result = await create_group({ name: 'Test', memberIds: ['ou_user1'] });

      expect(result.success).toBe(false);
      expect(result.message).toContain('failed to extract chat ID');
    });

    it('should return error when lark-cli returns JSON without chat_id', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ data: { some_other_field: 'value' } }),
        stderr: '',
      });

      const result = await create_group({ name: 'Test', memberIds: ['ou_user1'] });

      expect(result.success).toBe(false);
      expect(result.message).toContain('failed to extract chat ID');
    });

    it('should return error when lark-cli times out', async () => {
      const timeoutError = new Error('spawn lark-cli ETIMEDOUT');
      mockExecFile.mockRejectedValue(timeoutError);

      const result = await create_group({ name: 'Test', memberIds: ['ou_user1'] });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to create group');
    });
  });

  describe('edge cases', () => {
    it('should handle non-Error objects in catch', async () => {
      mockExecFile.mockImplementation(() => { throw new Error('string error'); });

      const result = await create_group({ name: 'Test', memberIds: ['ou_user1'] });

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to create group');
    });

    it('should accept names with hyphens, underscores, and dots', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ data: { chat_id: 'oc_special1' } }),
        stderr: '',
      });

      const result = await create_group({ name: 'PR-Review_v2.0', memberIds: ['ou_user1'] });

      expect(result.success).toBe(true);
    });

    it('should accept names with parentheses', async () => {
      mockExecFile.mockResolvedValue({
        stdout: JSON.stringify({ data: { chat_id: 'oc_parens1' } }),
        stderr: '',
      });

      const result = await create_group({ name: 'Config (Phase 1)', memberIds: ['ou_user1'] });

      expect(result.success).toBe(true);
    });
  });
});
