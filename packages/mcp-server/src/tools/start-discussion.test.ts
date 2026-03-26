/**
 * Tests for start_discussion tool.
 *
 * Issue #1317: Tests the start_discussion MCP tool.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Mock credentials module to use a temp directory
const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'start-discussion-test-'));

vi.mock('./credentials.js', () => ({
  getWorkspaceDir: () => tempDir,
}));

// Mock IPC utilities
const mockIpcClient = {
  createChat: vi.fn(),
  sendInteractive: vi.fn(),
  sendMessage: vi.fn(),
};

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getIpcClient: () => mockIpcClient,
}));

// Mock isIpcAvailable to return true by default
vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn().mockResolvedValue(true),
  getIpcErrorMessage: (type: string, error?: string) => {
    const messages: Record<string, string> = {
      ipc_unavailable: '❌ IPC 服务不可用',
      ipc_timeout: '❌ IPC 请求超时',
    };
    return messages[type] ?? `❌ Error: ${error ?? 'unknown'}`;
  },
}));

import { start_discussion } from './start-discussion.js';
import { readSession } from './temporary-session.js';

describe('start_discussion', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Clean up temp directory
    try {
      const sessionsDir = path.join(tempDir, 'temporary-sessions');
      const files = await fsPromises.readdir(sessionsDir);
      for (const file of files) {
        await fsPromises.unlink(path.join(sessionsDir, file));
      }
    } catch {
      // Ignore
    }
  });

  afterEach(async () => {
    try {
      const sessionsDir = path.join(tempDir, 'temporary-sessions');
      const files = await fsPromises.readdir(sessionsDir);
      for (const file of files) {
        await fsPromises.unlink(path.join(sessionsDir, file));
      }
    } catch {
      // Ignore
    }
  });

  const defaultOptions = [
    { text: '✅ Approve', value: 'approve', type: 'primary' as const },
    { text: '❌ Reject', value: 'reject', type: 'danger' as const },
  ];

  describe('parameter validation', () => {
    it('should reject empty topic', async () => {
      const result = await start_discussion({
        topic: '',
        message: 'test message',
        options: defaultOptions,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('topic');
    });

    it('should reject empty message', async () => {
      const result = await start_discussion({
        topic: 'Test Topic',
        message: '',
        options: defaultOptions,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('message');
    });

    it('should reject empty options', async () => {
      const result = await start_discussion({
        topic: 'Test Topic',
        message: 'test message',
        options: [],
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('options');
    });

    it('should reject non-array options', async () => {
      const result = await start_discussion({
        topic: 'Test Topic',
        message: 'test message',
        options: undefined as any,
      });
      expect(result.success).toBe(false);
    });
  });

  describe('happy path with existing chatId', () => {
    it('should create session and send interactive card to existing chat', async () => {
      mockIpcClient.sendInteractive.mockResolvedValue({
        success: true,
        messageId: 'om_test_msg',
      });

      const result = await start_discussion({
        topic: 'PR #123 Review',
        message: 'Please review this PR',
        options: defaultOptions,
        chatId: 'oc_existing_chat',
        context: { prNumber: 123 },
      });

      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(result.chatId).toBe('oc_existing_chat');

      // Should NOT call createChat
      expect(mockIpcClient.createChat).not.toHaveBeenCalled();

      // Should call sendInteractive
      expect(mockIpcClient.sendInteractive).toHaveBeenCalledWith(
        'oc_existing_chat',
        expect.objectContaining({
          question: 'Please review this PR',
          title: 'PR #123 Review',
        })
      );

      // Session file should be written with status 'active'
      const session = await readSession(result.sessionId!);
      expect(session).not.toBeNull();
      expect(session!.status).toBe('active');
      expect(session!.chatId).toBe('oc_existing_chat');
      expect(session!.messageId).toBe('om_test_msg');
      expect(session!.topic).toBe('PR #123 Review');
      expect(session!.context).toEqual({ prNumber: 123 });
      expect(session!.response).toBeNull();
    });
  });

  describe('happy path with new group creation', () => {
    it('should create group, send card, and update session', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: true,
        chatId: 'oc_new_group',
        name: 'PR #456 Discussion',
      });
      mockIpcClient.sendInteractive.mockResolvedValue({
        success: true,
        messageId: 'om_new_msg',
      });

      const result = await start_discussion({
        topic: 'PR #456 Discussion',
        message: 'Review PR #456',
        options: defaultOptions,
        memberIds: ['ou_user1', 'ou_user2'],
        groupName: 'PR #456 Discussion',
      });

      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(result.chatId).toBe('oc_new_group');

      // Should call createChat
      expect(mockIpcClient.createChat).toHaveBeenCalledWith(
        'PR #456 Discussion',
        undefined,
        ['ou_user1', 'ou_user2']
      );

      // Should call sendInteractive with the new chat ID
      expect(mockIpcClient.sendInteractive).toHaveBeenCalledWith(
        'oc_new_group',
        expect.objectContaining({
          question: 'Review PR #456',
        })
      );

      // Session file should have active status
      const session = await readSession(result.sessionId!);
      expect(session!.status).toBe('active');
      expect(session!.chatId).toBe('oc_new_group');
    });
  });

  describe('error handling', () => {
    it('should handle group creation failure', async () => {
      mockIpcClient.createChat.mockResolvedValue({
        success: false,
        error: 'Permission denied',
        errorType: 'permission_denied',
      });

      const result = await start_discussion({
        topic: 'Test',
        message: 'test',
        options: defaultOptions,
        memberIds: ['ou_user1'],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Permission denied');

      // Session was created before group creation attempt, verify it's in pending state
      const { listSessions } = await import('./temporary-session.js');
      const pendingSessions = await listSessions('pending');
      expect(pendingSessions.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle interactive card send failure', async () => {
      mockIpcClient.sendInteractive.mockResolvedValue({
        success: false,
        error: 'Rate limited',
        errorType: 'rate_limited',
      });

      const result = await start_discussion({
        topic: 'Test',
        message: 'test',
        options: defaultOptions,
        chatId: 'oc_test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limited');
    });

    it('should use default expiry of 24 hours', async () => {
      mockIpcClient.sendInteractive.mockResolvedValue({
        success: true,
        messageId: 'om_msg',
      });

      const beforeCall = Date.now();
      const result = await start_discussion({
        topic: 'Test',
        message: 'test',
        options: defaultOptions,
        chatId: 'oc_test',
      });

      const session = await readSession(result.sessionId!);
      const expiresAt = new Date(session!.expiresAt).getTime();
      const expectedMin = beforeCall + 24 * 60 * 60 * 1000; // ~24h
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin - 1000); // 1s tolerance
    });

    it('should use custom expiry time', async () => {
      mockIpcClient.sendInteractive.mockResolvedValue({
        success: true,
        messageId: 'om_msg',
      });

      const beforeCall = Date.now();
      const result = await start_discussion({
        topic: 'Test',
        message: 'test',
        options: defaultOptions,
        chatId: 'oc_test',
        expiresInMinutes: 30,
      });

      const session = await readSession(result.sessionId!);
      const expiresAt = new Date(session!.expiresAt).getTime();
      const expectedMin = beforeCall + 30 * 60 * 1000; // ~30min
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin - 1000);
    });
  });
});
