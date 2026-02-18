/**
 * Tests for file-handler (src/feishu/file-handler.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FileHandler } from './file-handler.js';
import type { FileAttachment } from './attachment-manager.js';

describe('FileHandler', () => {
  let handler: FileHandler;
  let mockAttachmentManager: {
    hasAttachments: ReturnType<typeof vi.fn>;
    getAttachments: ReturnType<typeof vi.fn>;
    addAttachment: ReturnType<typeof vi.fn>;
    clearAttachments: ReturnType<typeof vi.fn>;
  };
  let mockDownloadFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockAttachmentManager = {
      hasAttachments: vi.fn().mockReturnValue(false),
      getAttachments: vi.fn().mockReturnValue([]),
      addAttachment: vi.fn(),
      clearAttachments: vi.fn(),
    };

    mockDownloadFile = vi.fn().mockResolvedValue({
      success: true,
      filePath: '/tmp/downloads/test-file.txt',
    });

    handler = new FileHandler(mockAttachmentManager, mockDownloadFile);
  });

  describe('handleFileMessage', () => {
    describe('image messages', () => {
      it('should handle image message successfully', async () => {
        const content = JSON.stringify({ image_key: 'img_12345' });

        const result = await handler.handleFileMessage(
          'chat_001',
          'image',
          content,
          'msg_001'
        );

        expect(result.success).toBe(true);
        expect(result.filePath).toBe('/tmp/downloads/test-file.txt');
        expect(result.fileKey).toBe('img_12345');

        expect(mockDownloadFile).toHaveBeenCalledWith(
          'img_12345',
          'image',
          'image_img_12345',
          'msg_001'
        );
      });

      it('should generate filename from image_key', async () => {
        const content = JSON.stringify({ image_key: 'my_image_key' });

        await handler.handleFileMessage('chat_001', 'image', content, 'msg_001');

        expect(mockDownloadFile).toHaveBeenCalledWith(
          'my_image_key',
          'image',
          'image_my_image_key',
          'msg_001'
        );
      });
    });

    describe('file messages', () => {
      it('should handle file message successfully', async () => {
        const content = JSON.stringify({
          file_key: 'file_12345',
          file_name: 'document.pdf',
        });

        const result = await handler.handleFileMessage(
          'chat_001',
          'file',
          content,
          'msg_001'
        );

        expect(result.success).toBe(true);
        expect(result.fileKey).toBe('file_12345');

        expect(mockDownloadFile).toHaveBeenCalledWith(
          'file_12345',
          'file',
          'document.pdf',
          'msg_001'
        );
      });

      it('should handle file without file_name', async () => {
        const content = JSON.stringify({ file_key: 'file_no_name' });

        await handler.handleFileMessage('chat_001', 'file', content, 'msg_001');

        expect(mockDownloadFile).toHaveBeenCalledWith(
          'file_no_name',
          'file',
          undefined,
          'msg_001'
        );
      });
    });

    describe('media messages', () => {
      it('should handle media message like file message', async () => {
        const content = JSON.stringify({
          file_key: 'media_12345',
          file_name: 'video.mp4',
        });

        const result = await handler.handleFileMessage(
          'chat_001',
          'media',
          content,
          'msg_001'
        );

        expect(result.success).toBe(true);
        expect(result.fileKey).toBe('media_12345');
      });
    });

    describe('attachment storage', () => {
      it('should store attachment with correct metadata', async () => {
        const content = JSON.stringify({
          file_key: 'file_123',
          file_name: 'test.txt',
        });

        await handler.handleFileMessage('chat_001', 'file', content, 'msg_001');

        expect(mockAttachmentManager.addAttachment).toHaveBeenCalledWith(
          'chat_001',
          expect.objectContaining({
            fileKey: 'file_123',
            fileName: 'test.txt',
            localPath: '/tmp/downloads/test-file.txt',
            fileType: 'file',
            messageId: 'msg_001',
            timestamp: expect.any(Number),
          })
        );
      });

      it('should use fileKey as fileName when not provided', async () => {
        const content = JSON.stringify({ file_key: 'no_name_key' });

        await handler.handleFileMessage('chat_001', 'file', content, 'msg_001');

        expect(mockAttachmentManager.addAttachment).toHaveBeenCalledWith(
          'chat_001',
          expect.objectContaining({
            fileName: 'no_name_key',
          })
        );
      });
    });

    describe('error handling', () => {
      it('should return failure when no file_key in content', async () => {
        const content = JSON.stringify({ other_field: 'value' });

        const result = await handler.handleFileMessage(
          'chat_001',
          'file',
          content,
          'msg_001'
        );

        expect(result.success).toBe(false);
        expect(mockDownloadFile).not.toHaveBeenCalled();
      });

      it('should return failure when download fails', async () => {
        mockDownloadFile.mockResolvedValueOnce({ success: false });

        const content = JSON.stringify({
          file_key: 'file_123',
          file_name: 'test.txt',
        });

        const result = await handler.handleFileMessage(
          'chat_001',
          'file',
          content,
          'msg_001'
        );

        expect(result.success).toBe(false);
        expect(mockAttachmentManager.addAttachment).not.toHaveBeenCalled();
      });

      it('should return failure when download returns no filePath', async () => {
        mockDownloadFile.mockResolvedValueOnce({ success: true });

        const content = JSON.stringify({
          file_key: 'file_123',
          file_name: 'test.txt',
        });

        const result = await handler.handleFileMessage(
          'chat_001',
          'file',
          content,
          'msg_001'
        );

        expect(result.success).toBe(false);
      });

      it('should handle JSON parse error', async () => {
        const result = await handler.handleFileMessage(
          'chat_001',
          'file',
          'not valid json',
          'msg_001'
        );

        expect(result.success).toBe(false);
      });

      it('should handle unexpected errors', async () => {
        mockDownloadFile.mockRejectedValueOnce(new Error('Network error'));

        const content = JSON.stringify({
          file_key: 'file_123',
          file_name: 'test.txt',
        });

        const result = await handler.handleFileMessage(
          'chat_001',
          'file',
          content,
          'msg_001'
        );

        expect(result.success).toBe(false);
      });
    });
  });

  describe('buildUploadPrompt', () => {
    it('should build prompt with file metadata', () => {
      const attachment: FileAttachment = {
        fileKey: 'file_123',
        fileName: 'document.pdf',
        localPath: '/tmp/doc.pdf',
        fileType: 'file',
        messageId: 'msg_001',
        timestamp: Date.now(),
      };

      const prompt = handler.buildUploadPrompt(attachment);

      expect(prompt).toContain('SYSTEM: User uploaded a file');
      expect(prompt).toContain('file_name: document.pdf');
      expect(prompt).toContain('file_type: file');
      expect(prompt).toContain('file_key: file_123');
      expect(prompt).toContain('local_path: /tmp/doc.pdf');
      expect(prompt).toContain('Please wait for the user\'s instructions');
    });

    it('should include file size when available', () => {
      const attachment: FileAttachment = {
        fileKey: 'file_123',
        fileName: 'large.bin',
        localPath: '/tmp/large.bin',
        fileType: 'file',
        messageId: 'msg_001',
        timestamp: Date.now(),
        fileSize: 5 * 1024 * 1024, // 5 MB
      };

      const prompt = handler.buildUploadPrompt(attachment);

      expect(prompt).toContain('file_size_mb: 5.00');
    });

    it('should include mime type when available', () => {
      const attachment: FileAttachment = {
        fileKey: 'file_123',
        fileName: 'doc.pdf',
        localPath: '/tmp/doc.pdf',
        fileType: 'file',
        messageId: 'msg_001',
        timestamp: Date.now(),
        mimeType: 'application/pdf',
      };

      const prompt = handler.buildUploadPrompt(attachment);

      expect(prompt).toContain('mime_type: application/pdf');
    });

    it('should handle attachment without optional fields', () => {
      const attachment: FileAttachment = {
        fileKey: 'minimal',
        fileName: 'minimal.txt',
        localPath: undefined,
        fileType: 'file',
        messageId: 'msg_001',
        timestamp: Date.now(),
      };

      const prompt = handler.buildUploadPrompt(attachment);

      expect(prompt).not.toContain('local_path:');
      expect(prompt).not.toContain('file_size_mb:');
      expect(prompt).not.toContain('mime_type:');
    });

    it('should use correct code block format', () => {
      const attachment: FileAttachment = {
        fileKey: 'file_123',
        fileName: 'test.txt',
        fileType: 'file',
        messageId: 'msg_001',
        timestamp: Date.now(),
      };

      const prompt = handler.buildUploadPrompt(attachment);

      expect(prompt).toContain('```file_metadata');
      expect(prompt).toContain('```');
    });
  });

  describe('notifyFileUpload', () => {
    it('should log debug message', () => {
      const attachment: FileAttachment = {
        fileKey: 'file_123',
        fileName: 'test.txt',
        fileType: 'file',
        messageId: 'msg_001',
        timestamp: Date.now(),
      };

      // This method doesn't do much currently, but we test it exists
      handler.notifyFileUpload('chat_001', attachment);

      // Method doesn't throw
    });
  });
});
