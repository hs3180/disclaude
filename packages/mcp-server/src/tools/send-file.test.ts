/**
 * Tests for send_file tool (packages/mcp-server/src/tools/send-file.ts)
 *
 * Issue #1619: Added tests for parentMessageId (thread reply) support.
 */

import * as fs from 'fs/promises';
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
  getWorkspaceDir: vi.fn(() => '/workspace'),
}));

vi.mock('./ipc-utils.js', () => ({
  isIpcAvailable: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
}));

import { send_file } from './send-file.js';
import { getIpcClient } from '@disclaude/core';
import { getFeishuCredentials, getWorkspaceDir } from './credentials.js';
import { isIpcAvailable } from './ipc-utils.js';

const mockIpcClient = {
  uploadFile: vi.fn(),
};

describe('send_file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getIpcClient).mockReturnValue(mockIpcClient as any);
    vi.mocked(getFeishuCredentials).mockReturnValue({ appId: 'test-app-id', appSecret: 'test-secret' });
    vi.mocked(getWorkspaceDir).mockReturnValue('/workspace');
    vi.mocked(isIpcAvailable).mockResolvedValue(true);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 * 1024 } as any);
  });

  describe('parameter validation', () => {
    it('should return error when chatId is empty', async () => {
      const result = await send_file({ filePath: '/test/file.txt', chatId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('chatId is required');
    });
  });

  describe('credential validation', () => {
    it('should return error when appId is missing', async () => {
      vi.mocked(getFeishuCredentials).mockReturnValue({ appId: undefined, appSecret: 'secret' });
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('Platform is not configured');
    });
  });

  describe('file path resolution', () => {
    it('should resolve relative paths using workspace dir', async () => {
      mockIpcClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'txt', fileName: 'file.txt', fileSize: 1024,
      });
      await send_file({ filePath: 'file.txt', chatId: 'oc_test' });
      expect(mockIpcClient.uploadFile).toHaveBeenCalledWith('oc_test', '/workspace/file.txt', undefined);
    });

    it('should use absolute paths directly', async () => {
      mockIpcClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'txt', fileName: 'file.txt', fileSize: 1024,
      });
      await send_file({ filePath: '/absolute/path/file.txt', chatId: 'oc_test' });
      expect(mockIpcClient.uploadFile).toHaveBeenCalledWith('oc_test', '/absolute/path/file.txt', undefined);
    });
  });

  describe('file validation', () => {
    it('should return error when path is not a file', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ isFile: () => false } as any);
      const result = await send_file({ filePath: '/test/dir', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not a file');
    });

    it('should return error when file does not exist', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('ENOENT: no such file'));
      const result = await send_file({ filePath: '/test/nonexistent.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('ENOENT');
    });
  });

  describe('IPC availability', () => {
    it('should return error when IPC is unavailable', async () => {
      vi.mocked(isIpcAvailable).mockResolvedValue(false);
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('IPC connection');
    });
  });

  describe('successful send', () => {
    it('should send file successfully and return file info', async () => {
      mockIpcClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'file_key_123', fileType: 'pdf', fileName: 'doc.pdf', fileSize: 2048000,
      });
      const result = await send_file({ filePath: '/test/doc.pdf', chatId: 'oc_test' });
      expect(result.success).toBe(true);
      expect(result.fileName).toBe('doc.pdf');
      expect(result.fileSize).toBe(2048000);
      expect(result.sizeMB).toBe('1.95');
      expect(result.message).toContain('doc.pdf');
    });

    it('should calculate correct sizeMB', async () => {
      mockIpcClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'txt', fileName: 'file.txt', fileSize: 512000,
      });
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.sizeMB).toBe('0.49');
    });
  });

  describe('IPC failure', () => {
    it('should return error when IPC upload fails', async () => {
      mockIpcClient.uploadFile.mockResolvedValue({ success: false });
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload file via IPC');
    });

    it('should include IPC error details in error message (Issue #2300)', async () => {
      mockIpcClient.uploadFile.mockResolvedValue({
        success: false,
        error: 'IPC_REQUEST_FAILED: Request failed with status code 400',
        errorType: 'ipc_request_failed' as const,
      });
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload file via IPC');
      expect(result.error).toContain('IPC_REQUEST_FAILED');
    });
  });

  describe('platform error handling', () => {
    it('should extract platform error details from response', async () => {
      const platformError = new Error('API Error') as Error & {
        response: { data: [{ code: 99991668, msg: 'file type not allowed', log_id: 'log_123', troubleshooter: 'https://example.com' }] };
      };
      platformError.response = { data: [{ code: 99991668, msg: 'file type not allowed', log_id: 'log_123', troubleshooter: 'https://example.com' }] };
      mockIpcClient.uploadFile.mockRejectedValue(platformError);
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.platformCode).toBe(99991668);
      expect(result.platformMsg).toBe('file type not allowed');
      expect(result.platformLogId).toBe('log_123');
      expect(result.troubleshooterUrl).toBe('https://example.com');
    });

    it('should extract error code from numeric code property', async () => {
      const codeError = new Error('API Error') as Error & { code: 1001 };
      codeError.code = 1001;
      mockIpcClient.uploadFile.mockRejectedValue(codeError);
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.platformCode).toBe(1001);
    });

    it('should handle non-Error objects in catch', async () => {
      mockIpcClient.uploadFile.mockRejectedValue('string error');
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });

  describe('thread reply support (Issue #1619)', () => {
    it('should pass parentMessageId to IPC uploadFile', async () => {
      mockIpcClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'pdf', fileName: 'doc.pdf', fileSize: 2048,
      });
      await send_file({ filePath: '/test/doc.pdf', chatId: 'oc_test', parentMessageId: 'thread_123' });
      expect(mockIpcClient.uploadFile).toHaveBeenCalledWith('oc_test', '/test/doc.pdf', 'thread_123');
    });

    it('should pass undefined when parentMessageId is not provided', async () => {
      mockIpcClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'txt', fileName: 'file.txt', fileSize: 1024,
      });
      await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(mockIpcClient.uploadFile).toHaveBeenCalledWith('oc_test', '/test/file.txt', undefined);
    });

    it('should send file successfully with thread reply', async () => {
      mockIpcClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'file_key_456', fileType: 'png', fileName: 'image.png', fileSize: 512000,
      });
      const result = await send_file({ filePath: '/test/image.png', chatId: 'oc_test', parentMessageId: 'root_msg_789' });
      expect(result.success).toBe(true);
      expect(result.fileName).toBe('image.png');
    });
  });
});
