/**
 * Tests for FeishuFileHandler.
 *
 * Tests the file handling functionality for Feishu platform:
 * - File message processing
 * - Image message processing
 * - Upload prompt generation
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FeishuFileHandler, type FileDownloadFunction } from './feishu-file-handler.js';
import type { IAttachmentManager, FileAttachment } from '../../channels/adapters/types.js';

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
}));

describe('FeishuFileHandler', () => {
  let handler: FeishuFileHandler;
  let mockAttachmentManager: IAttachmentManager;
  let mockDownloadFile: FileDownloadFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAttachmentManager = {
      hasAttachments: vi.fn(),
      getAttachments: vi.fn().mockReturnValue([]),
      addAttachment: vi.fn(),
      clearAttachments: vi.fn(),
    };

    mockDownloadFile = vi.fn();

    handler = new FeishuFileHandler({
      attachmentManager: mockAttachmentManager,
      downloadFile: mockDownloadFile,
    });
  });

  describe('handleFileMessage', () => {
    it('should handle image message correctly', async () => {
      const mockDownload = mockDownloadFile as ReturnType<typeof vi.fn>;
      mockDownload.mockResolvedValue({
        success: true,
        filePath: '/tmp/test_image.png',
      });

      const result = await handler.handleFileMessage(
        'chat-123',
        'image',
        JSON.stringify({ image_key: 'img_key_123' }),
        'msg-456'
      );

      expect(result.success).toBe(true);
      expect(result.filePath).toBe('/tmp/test_image.png');
      expect(result.fileKey).toBe('img_key_123');
      expect(mockDownload).toHaveBeenCalledWith(
        'img_key_123',
        'image',
        'image_img_key_123',
        'msg-456'
      );
    });

    it('should handle file message correctly', async () => {
      const mockDownload = mockDownloadFile as ReturnType<typeof vi.fn>;
      mockDownload.mockResolvedValue({
        success: true,
        filePath: '/tmp/document.pdf',
      });

      const result = await handler.handleFileMessage(
        'chat-123',
        'file',
        JSON.stringify({ file_key: 'file_key_789', file_name: 'document.pdf' }),
        'msg-456'
      );

      expect(result.success).toBe(true);
      expect(result.filePath).toBe('/tmp/document.pdf');
      expect(result.fileKey).toBe('file_key_789');
      expect(mockDownload).toHaveBeenCalledWith(
        'file_key_789',
        'file',
        'document.pdf',
        'msg-456'
      );
    });

    it('should handle media message correctly', async () => {
      const mockDownload = mockDownloadFile as ReturnType<typeof vi.fn>;
      mockDownload.mockResolvedValue({
        success: true,
        filePath: '/tmp/video.mp4',
      });

      const result = await handler.handleFileMessage(
        'chat-123',
        'media',
        JSON.stringify({ file_key: 'media_key_abc', file_name: 'video.mp4' }),
        'msg-456'
      );

      expect(result.success).toBe(true);
      expect(result.filePath).toBe('/tmp/video.mp4');
    });

    it('should return error when no file_key found', async () => {
      const result = await handler.handleFileMessage(
        'chat-123',
        'image',
        JSON.stringify({ other_field: 'value' }),
        'msg-456'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('No file_key found');
    });

    it('should return error when download fails', async () => {
      const mockDownload = mockDownloadFile as ReturnType<typeof vi.fn>;
      mockDownload.mockResolvedValue({
        success: false,
      });

      const result = await handler.handleFileMessage(
        'chat-123',
        'file',
        JSON.stringify({ file_key: 'key_123', file_name: 'test.txt' }),
        'msg-456'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Download failed');
    });

    it('should handle invalid JSON content', async () => {
      const result = await handler.handleFileMessage(
        'chat-123',
        'image',
        'not valid json',
        'msg-456'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should add attachment to manager on success', async () => {
      const mockDownload = mockDownloadFile as ReturnType<typeof vi.fn>;
      mockDownload.mockResolvedValue({
        success: true,
        filePath: '/tmp/test.png',
      });

      await handler.handleFileMessage(
        'chat-123',
        'image',
        JSON.stringify({ image_key: 'img_key' }),
        'msg-456'
      );

      const mockAdd = mockAttachmentManager.addAttachment as ReturnType<typeof vi.fn>;
      expect(mockAdd).toHaveBeenCalled();

      const [[chatId, attachment]] = mockAdd.mock.calls;
      expect(chatId).toBe('chat-123');
      expect(attachment.fileKey).toBe('img_key');
      expect(attachment.messageId).toBe('msg-456');
    });
  });

  describe('buildUploadPrompt', () => {
    it('should generate prompt with basic file info', () => {
      const attachment: FileAttachment = {
        fileKey: 'key_123',
        fileName: 'test.pdf',
        localPath: '/tmp/test.pdf',
        fileType: 'file',
        messageId: 'msg-456',
        timestamp: Date.now(),
      };

      const prompt = handler.buildUploadPrompt(attachment);

      expect(prompt).toContain('User uploaded a file');
      expect(prompt).toContain('file_name: test.pdf');
      expect(prompt).toContain('file_type: file');
      expect(prompt).toContain('file_key: key_123');
      expect(prompt).toContain('local_path: /tmp/test.pdf');
    });

    it('should include file size when available', () => {
      const attachment: FileAttachment = {
        fileKey: 'key_123',
        fileName: 'large.zip',
        localPath: '/tmp/large.zip',
        fileType: 'file',
        messageId: 'msg-456',
        timestamp: Date.now(),
        fileSize: 5 * 1024 * 1024, // 5 MB
      };

      const prompt = handler.buildUploadPrompt(attachment);

      expect(prompt).toContain('file_size_mb: 5.00');
    });

    it('should include mime type when available', () => {
      const attachment: FileAttachment = {
        fileKey: 'key_123',
        fileName: 'doc.pdf',
        localPath: '/tmp/doc.pdf',
        fileType: 'file',
        messageId: 'msg-456',
        timestamp: Date.now(),
        mimeType: 'application/pdf',
      };

      const prompt = handler.buildUploadPrompt(attachment);

      expect(prompt).toContain('mime_type: application/pdf');
    });

    it('should handle image file type', () => {
      const attachment: FileAttachment = {
        fileKey: 'img_key',
        fileName: 'photo.png',
        localPath: '/tmp/photo.png',
        fileType: 'image',
        messageId: 'msg-456',
        timestamp: Date.now(),
      };

      const prompt = handler.buildUploadPrompt(attachment);

      expect(prompt).toContain('file_type: image');
    });

    it('should include instruction text', () => {
      const attachment: FileAttachment = {
        fileKey: 'key',
        fileName: 'test.txt',
        fileType: 'file',
        messageId: 'msg',
        timestamp: Date.now(),
      };

      const prompt = handler.buildUploadPrompt(attachment);

      expect(prompt).toContain('wait for the user\'s instructions');
    });
  });
});
