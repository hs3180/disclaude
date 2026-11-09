/**
 * Tests for send_file tool.
 *
 * Issue #1619: Added tests for parentMessageId (thread reply) support.
 */

import * as fs from 'fs/promises';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
// Issue #4129: uploadFile is now a standalone function exported from @disclaude/core.
// Production calls uploadFile(client, ...). Mock it to drop the client arg and delegate
// to the same spy as the legacy client.uploadFile(...) instance method.
const { mockChannelApiClient, mockUploadFile, mockGetChannelApiClient } = vi.hoisted(() => {
  const mockUploadFile = vi.fn();
  const mockChannelApiClient = { uploadFile: mockUploadFile };
  const mockGetChannelApiClient = vi.fn().mockReturnValue(mockChannelApiClient);
  return { mockChannelApiClient, mockUploadFile, mockGetChannelApiClient };
});

vi.mock('@disclaude/core', () => ({
  Config: { getWorkspaceDir: vi.fn(() => '/workspace') },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  uploadFile: (...args: unknown[]) => mockUploadFile(...args.slice(1)),
}));

vi.mock('./channel-api-utils.js', () => ({
  // Issue #4280 (Phase 3, part 3): REST client factory — returns the shared mock.
  getChannelApiClient: () => mockGetChannelApiClient(),
  isChannelApiAvailable: vi.fn(),
  // Issue #4576: deterministic stub — the unavailable-branch tests assert the
  // fallback hint (thread-preserving +messages-reply) is appended. Mirrors
  // the real signature: filePath rides along as --file.
  buildChannelApiFallbackHint: (parentMessageId?: string, options?: { filePath?: string }) =>
    `HINT:lark-cli im +messages-reply --message-id ${parentMessageId ?? '<om_...>'}${options?.filePath ? ` --file ${options.filePath}` : ''}`,
}));

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
}));

import { send_file } from './send-file.js';
import { isChannelApiAvailable } from './channel-api-utils.js';

describe('send_file', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetChannelApiClient.mockReturnValue(mockChannelApiClient);
    vi.mocked(isChannelApiAvailable).mockResolvedValue(true);
    vi.mocked(fs.stat).mockResolvedValue({ isFile: () => true, size: 1024 * 1024 } as any);
  });

  describe('parameter validation', () => {
    it('should return error when chatId is empty', async () => {
      const result = await send_file({ filePath: '/test/file.txt', chatId: '' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('chatId is required');
    });
  });

  describe('file path resolution', () => {
    it('should resolve relative paths using workspace dir', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'txt', fileName: 'file.txt', fileSize: 1024,
      });
      await send_file({ filePath: 'file.txt', chatId: 'oc_test' });
      expect(mockChannelApiClient.uploadFile).toHaveBeenCalledWith(
        'oc_test', '/workspace/file.txt', undefined, { idempotencyKey: expect.any(String) },
      );
    });

    it('should use absolute paths directly', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'txt', fileName: 'file.txt', fileSize: 1024,
      });
      await send_file({ filePath: '/absolute/path/file.txt', chatId: 'oc_test' });
      expect(mockChannelApiClient.uploadFile).toHaveBeenCalledWith(
        'oc_test', '/absolute/path/file.txt', undefined, { idempotencyKey: expect.any(String) },
      );
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

  describe('REST API availability', () => {
    it('should return error when REST API is unavailable', async () => {
      vi.mocked(isChannelApiAvailable).mockResolvedValue(false);
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.message).toContain('REST API connection');
    });

    it('should append the thread-preserving lark-cli fallback hint (Issue #4576)', async () => {
      vi.mocked(isChannelApiAvailable).mockResolvedValue(false);
      const result = await send_file({
        filePath: '/test/file.txt',
        chatId: 'oc_test',
        parentMessageId: 'om_parent123',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('+messages-reply --message-id om_parent123');
    });

    it('should pass the original filePath into the hint as --file (Issue #4576 review nit)', async () => {
      vi.mocked(isChannelApiAvailable).mockResolvedValue(false);
      const result = await send_file({
        filePath: './report.pdf',
        chatId: 'oc_test',
        parentMessageId: 'om_parent123',
      });
      expect(result.message).toContain('--file ./report.pdf');
    });
  });

  describe('successful send', () => {
    it('should send file successfully and return file info', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
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
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'txt', fileName: 'file.txt', fileSize: 512000,
      });
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.sizeMB).toBe('0.49');
    });
  });

  describe('progress reporting (#4568)', () => {
    it('reports the file size once before the upload starts', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'file_key_123', fileType: 'pdf', fileName: 'doc.pdf', fileSize: 2048000,
      });
      const onProgress = vi.fn();
      const result = await send_file({ filePath: '/test/doc.pdf', chatId: 'oc_test', onProgress });

      expect(result.success).toBe(true);
      expect(onProgress).toHaveBeenCalledTimes(1);
      // stat is mocked to 1 MB — the pre-upload report carries name + size
      expect(onProgress).toHaveBeenCalledWith({
        message: 'Uploading doc.pdf (1.00 MB)…',
      });
    });

    it('does not report progress when REST API is unavailable', async () => {
      vi.mocked(isChannelApiAvailable).mockResolvedValue(false);
      const onProgress = vi.fn();
      const result = await send_file({ filePath: '/test/doc.pdf', chatId: 'oc_test', onProgress });

      expect(result.success).toBe(false);
      expect(onProgress).not.toHaveBeenCalled();
    });

    it('behaves identically without a callback (back-compat, Claude backend)', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'file_key_123', fileType: 'pdf', fileName: 'doc.pdf', fileSize: 2048000,
      });
      // No onProgress arg — must not throw.
      const result = await send_file({ filePath: '/test/doc.pdf', chatId: 'oc_test' });
      expect(result.success).toBe(true);
    });
  });

  describe('REST API failure', () => {
    it('should return error when REST API upload fails', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({ success: false });
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload file via REST API');
    });

    it('should include REST API error details in error message (Issue #2300)', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: false,
        error: 'CHANNEL_API_REQUEST_FAILED: Request failed with status code 400',
        errorType: 'channel_api_request_failed' as const,
      });
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to upload file via REST API');
      expect(result.error).toContain('CHANNEL_API_REQUEST_FAILED');
    });
  });

  describe('platform error handling', () => {
    it('should extract platform error details from response', async () => {
      const platformError = new Error('API Error') as Error & {
        response: { data: [{ code: 99991668, msg: 'file type not allowed', log_id: 'log_123', troubleshooter: 'https://example.com' }] };
      };
      platformError.response = { data: [{ code: 99991668, msg: 'file type not allowed', log_id: 'log_123', troubleshooter: 'https://example.com' }] };
      mockChannelApiClient.uploadFile.mockRejectedValue(platformError);
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
      mockChannelApiClient.uploadFile.mockRejectedValue(codeError);
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.platformCode).toBe(1001);
    });

    it('should handle non-Error objects in catch', async () => {
      mockChannelApiClient.uploadFile.mockRejectedValue('string error');
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error');
    });
  });

  describe('thread reply support (Issue #1619)', () => {
    it('should pass parentMessageId to REST API uploadFile', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'pdf', fileName: 'doc.pdf', fileSize: 2048,
      });
      await send_file({ filePath: '/test/doc.pdf', chatId: 'oc_test', parentMessageId: 'thread_123' });
      expect(mockChannelApiClient.uploadFile).toHaveBeenCalledWith(
        'oc_test', '/test/doc.pdf', 'thread_123', { idempotencyKey: expect.any(String) },
      );
    });

    it('should pass undefined when parentMessageId is not provided', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'txt', fileName: 'file.txt', fileSize: 1024,
      });
      await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(mockChannelApiClient.uploadFile).toHaveBeenCalledWith(
        'oc_test', '/test/file.txt', undefined, { idempotencyKey: expect.any(String) },
      );
    });

    it('should send file successfully with thread reply', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'file_key_456', fileType: 'png', fileName: 'image.png', fileSize: 512000,
      });
      const result = await send_file({ filePath: '/test/image.png', chatId: 'oc_test', parentMessageId: 'root_msg_789' });
      expect(result.success).toBe(true);
      expect(result.fileName).toBe('image.png');
    });
  });

  describe('delivery position echo (#5722)', () => {
    it('topic-group in-topic reply (with --parent): success message marks the thread reply', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: '', fileType: 'pdf', fileName: 'doc.pdf', fileSize: 2048,
        messageId: 'om_reply_1', deliveryPosition: 'thread-reply', threadId: 'om_topic_root',
      });
      const result = await send_file({ filePath: '/test/doc.pdf', chatId: 'oc_topic_group', parentMessageId: 'om_topic_root' });
      expect(result.success).toBe(true);
      expect(result.message).toBe('✅ File sent: doc.pdf (0.00 MB) — thread reply to om_topic_root (messageId om_reply_1)');
      expect(result.deliveryPosition).toBe('thread-reply');
      expect(result.parentMessageId).toBe('om_topic_root');
      expect(result.messageId).toBe('om_reply_1');
      // No warning: the file provably landed inside the requested topic.
      expect(result.message).not.toContain('⚠️');
    });

    it('topic group without --parent: success message marks chat root and warns about the NEW topic', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: '', fileType: 'pdf', fileName: 'doc.pdf', fileSize: 2048,
        messageId: 'om_new_topic_root', deliveryPosition: 'chat-root', rootId: 'om_new_topic_root',
      });
      const result = await send_file({ filePath: '/test/doc.pdf', chatId: 'oc_topic_group' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('— chat root (messageId om_new_topic_root)');
      expect(result.message).toContain('⚠️ Sent without --parent');
      expect(result.message).toContain('NEW topic');
      expect(result.deliveryPosition).toBe('chat-root');
    });

    it('non-topic chat without --parent: same chat-root echo (the CLI cannot distinguish chat types offline)', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: '', fileType: 'pdf', fileName: 'doc.pdf', fileSize: 2048,
        messageId: 'om_p2p_1', deliveryPosition: 'chat-root', rootId: 'om_p2p_1',
      });
      const result = await send_file({ filePath: '/test/doc.pdf', chatId: 'ou_peer' });
      expect(result.success).toBe(true);
      expect(result.message).toContain('— chat root (messageId om_p2p_1)');
      expect(result.deliveryPosition).toBe('chat-root');
    });

    it('derives the position from --parent when an older service reports no deliveryPosition', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: '', fileType: 'pdf', fileName: 'doc.pdf', fileSize: 2048,
        messageId: 'om_reply_2',
      });
      const result = await send_file({ filePath: '/test/doc.pdf', chatId: 'oc_test', parentMessageId: 'om_parent_2' });
      expect(result.success).toBe(true);
      expect(result.message).toBe('✅ File sent: doc.pdf (0.00 MB) — thread reply to om_parent_2 (messageId om_reply_2)');
      expect(result.deliveryPosition).toBe('thread-reply');
    });
  });

  describe('platform error edge cases', () => {
    it('should not extract platform code when err.code is a string', async () => {
      const error = new Error('API Error') as Error & { code: string };
      error.code = 'EACCES';
      mockChannelApiClient.uploadFile.mockRejectedValue(error);
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.platformCode).toBeUndefined();
    });

    it('should handle non-array response data gracefully', async () => {
      const error = new Error('API Error') as Error & { response: { data: object } };
      error.response = { data: { code: 123, msg: 'error' } };
      mockChannelApiClient.uploadFile.mockRejectedValue(error);
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.platformCode).toBeUndefined();
    });

    it('should use err.msg fallback when platform msg is not set from response data', async () => {
      const error = new Error('Default message') as Error & {
        msg: string;
        response: { data: Array<{ code?: number; msg?: string }> };
      };
      error.msg = 'Fallback message';
      error.response = { data: [{ code: 9999 }] };
      mockChannelApiClient.uploadFile.mockRejectedValue(error);
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.platformMsg).toBe('Fallback message');
    });

    it('should use err.message as final fallback when both response data msg and err.msg are missing', async () => {
      const error = new Error('Final fallback message') as Error & {
        response: { data: Array<{ code?: number }> };
      };
      error.response = { data: [{ code: 1001 }] };
      mockChannelApiClient.uploadFile.mockRejectedValue(error);
      const result = await send_file({ filePath: '/test/file.txt', chatId: 'oc_test' });
      expect(result.success).toBe(false);
      expect(result.platformMsg).toBe('Final fallback message');
    });
  });

  describe('REST API upload fallback fields', () => {
    it('should use fallbacks when REST API upload returns success with missing fields', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({ success: true });
      const result = await send_file({ filePath: '/test/doc.pdf', chatId: 'oc_test' });
      expect(result.success).toBe(true);
      expect(result.fileSize).toBe(0);
      expect(result.sizeMB).toBe('0.00');
    });
  });

  // Issue #5630: a timed-out upload is an UNKNOWN outcome, not a failure —
  // the service may still deliver. The result must say so and carry the
  // retry-dedup idempotency key instead of inviting a blind resend.
  describe('ambiguous timeout outcome (#5630)', () => {
    it('reports the unknown outcome with retry guidance instead of a plain failure', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: false,
        error: 'CHANNEL_API_TIMEOUT: REST uploadFile (The operation was aborted due to timeout)',
        errorType: 'channel_api_timeout' as const,
        outcomeUnknown: true,
        idempotencyKey: 'idem-timeout',
      });
      // A retry re-passes the key from the timed-out attempt (documented flow).
      const result = await send_file({
        filePath: '/test/slow.png', chatId: 'oc_test', idempotencyKey: 'idem-timeout',
      });

      expect(result.success).toBe(false);
      expect(result.outcomeUnknown).toBe(true);
      expect(result.idempotencyKey).toBe('idem-timeout');
      expect(result.message).toContain('UNKNOWN');
      expect(result.message).toContain('idempotencyKey "idem-timeout"');
      expect(result.message).toContain('may still arrive');
    });

    it('reports a tool-generated key when the caller passed none', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: false,
        error: 'CHANNEL_API_TIMEOUT: REST uploadFile (The operation was aborted due to timeout)',
        errorType: 'channel_api_timeout' as const,
        outcomeUnknown: true,
      });
      const result = await send_file({ filePath: '/test/slow.png', chatId: 'oc_test' });

      expect(result.outcomeUnknown).toBe(true);
      expect(result.idempotencyKey).toMatch(/^send-file-/);
      expect(result.message).toContain(`idempotencyKey "${result.idempotencyKey}"`);
    });

    it('generates a fresh dedup key per logical send', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'png', fileName: 'a.png', fileSize: 1024,
      });
      await send_file({ filePath: '/test/a.png', chatId: 'oc_test' });
      await send_file({ filePath: '/test/a.png', chatId: 'oc_test' });

      const firstKey = mockChannelApiClient.uploadFile.mock.calls[0][3]?.idempotencyKey;
      const secondKey = mockChannelApiClient.uploadFile.mock.calls[1][3]?.idempotencyKey;
      expect(firstKey).toMatch(/^send-file-/);
      expect(secondKey).toMatch(/^send-file-/);
      expect(firstKey).not.toBe(secondKey);
    });

    it('reuses an explicitly passed idempotencyKey (retry-safe call)', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'png', fileName: 'a.png', fileSize: 1024,
      });
      await send_file({ filePath: '/test/a.png', chatId: 'oc_test', idempotencyKey: 'idem-fixed' });

      expect(mockChannelApiClient.uploadFile).toHaveBeenCalledWith(
        'oc_test', '/test/a.png', undefined, { idempotencyKey: 'idem-fixed' },
      );
    });

    it('surfaces the confirmed messageId on success', async () => {
      mockChannelApiClient.uploadFile.mockResolvedValue({
        success: true, fileKey: 'key', fileType: 'png', fileName: 'a.png', fileSize: 1024, messageId: 'om_ok',
      });
      const result = await send_file({ filePath: '/test/a.png', chatId: 'oc_test' });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('om_ok');
    });
  });
});
