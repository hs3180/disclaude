/**
 * Tests for Feishu file uploader (src/feishu/file-uploader.ts)
 *
 * Tests the following functionality:
 * - File type detection from extensions
 * - File upload functionality
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectFileType, uploadFile } from './file-uploader.js';
import * as fs from 'fs/promises';
import * as fsStream from 'fs';

// Mock dependencies
vi.mock('fs/promises');
vi.mock('fs');
vi.mock('@larksuiteoapi/node-sdk', () => ({
  default: {
    Client: vi.fn(),
  },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

const mockedFs = vi.mocked(fs);
const mockedFsStream = vi.mocked(fsStream);

describe('Feishu File Uploader', () => {
  describe('detectFileType', () => {
    it('should detect image files correctly', () => {
      const imageFiles = [
        'test.jpg',
        'test.jpeg',
        'test.png',
        'test.gif',
        'test.webp',
        'test.bmp',
        'test.ico',
        'test.heic',
        'test.tiff',
        'test.tif',
      ];

      imageFiles.forEach((file) => {
        expect(detectFileType(file)).toBe('image');
      });
    });

    it('should detect audio files correctly', () => {
      const audioFiles = [
        'test.mp3',
        'test.wav',
        'test.ogg',
        'test.m4a',
        'test.aac',
        'test.flac',
        'test.wma',
        'test.amr',
      ];

      audioFiles.forEach((file) => {
        expect(detectFileType(file)).toBe('audio');
      });
    });

    it('should detect video files correctly', () => {
      const videoFiles = [
        'test.mp4',
        'test.mov',
        'test.avi',
        'test.mkv',
        'test.webm',
        'test.flv',
        'test.wmv',
        'test.m4v',
      ];

      videoFiles.forEach((file) => {
        expect(detectFileType(file)).toBe('video');
      });
    });

    it('should return file type for unknown extensions', () => {
      const unknownFiles = [
        'test.pdf',
        'test.doc',
        'test.txt',
        'test.zip',
        'test.json',
        'test.unknown',
      ];

      unknownFiles.forEach((file) => {
        expect(detectFileType(file)).toBe('file');
      });
    });

    it('should handle case-insensitive extensions', () => {
      expect(detectFileType('test.JPG')).toBe('image');
      expect(detectFileType('test.PNG')).toBe('image');
      expect(detectFileType('test.MP4')).toBe('video');
      expect(detectFileType('test.MP3')).toBe('audio');
    });

    it('should handle files with multiple dots', () => {
      expect(detectFileType('test.file.jpg')).toBe('image');
      expect(detectFileType('test.file.tar.gz')).toBe('file');
    });

    it('should handle files without extensions', () => {
      expect(detectFileType('testfile')).toBe('file');
      expect(detectFileType('testfile.')).toBe('file');
    });

    it('should handle empty string', () => {
      expect(detectFileType('')).toBe('file');
    });

    it('should handle paths with directories', () => {
      expect(detectFileType('/path/to/file.jpg')).toBe('image');
      expect(detectFileType('./relative/test.mp4')).toBe('video');
    });
  });

  describe('uploadFile', () => {
    let mockClient: any;

    beforeEach(() => {
      vi.clearAllMocks();

      // Mock Lark client
      mockClient = {
        im: {
          file: {
            create: vi.fn(),
          },
          image: {
            create: vi.fn(),
          },
        },
      };

      // Mock file system
      mockedFs.stat.mockResolvedValue({
        size: 1024,
      } as any);

      mockedFsStream.createReadStream = vi.fn(() => ({
        on: vi.fn(),
        pipe: vi.fn(),
      })) as any;
    });

    it('should upload image files using image API', async () => {
      mockClient.im.image.create.mockResolvedValue({
        image_key: 'img_test_key',
      });

      const result = await uploadFile(mockClient, '/path/to/image.jpg', 'oc_chat123');

      expect(result).toEqual({
        fileKey: 'img_test_key',
        fileType: 'image',
        fileName: 'image.jpg',
        fileSize: 1024,
      });

      expect(mockClient.im.image.create).toHaveBeenCalled();
    });

    it('should upload regular files using file API', async () => {
      mockClient.im.file.create.mockResolvedValue({
        file_key: 'file_test_key',
      });

      const result = await uploadFile(mockClient, '/path/to/document.pdf', 'oc_chat123');

      expect(result).toEqual({
        fileKey: 'file_test_key',
        fileType: 'file',
        fileName: 'document.pdf',
        fileSize: 1024,
        apiFileType: 'pdf',
      });

      expect(mockClient.im.file.create).toHaveBeenCalled();
    });

    it('should handle upload errors gracefully', async () => {
      mockClient.im.image.create.mockRejectedValue(new Error('Upload failed'));

      await expect(
        uploadFile(mockClient, '/path/to/image.jpg', 'oc_chat123')
      ).rejects.toThrow();
    });

    it('should get file stats before upload', async () => {
      mockClient.im.file.create.mockResolvedValue({
        file_key: 'test_key',
      });

      await uploadFile(mockClient, '/path/to/file.pdf', 'oc_chat123');

      expect(mockedFs.stat).toHaveBeenCalledWith('/path/to/file.pdf');
    });

    it('should handle files with various extensions', async () => {
      mockClient.im.image.create.mockResolvedValue({
        image_key: 'img_key',
      });

      await uploadFile(mockClient, '/path/to/photo.png', 'oc_chat123');

      expect(mockClient.im.image.create).toHaveBeenCalled();
    });
  });

  describe('file type detection edge cases', () => {
    it('should handle mixed case extensions', () => {
      expect(detectFileType('test.JpEg')).toBe('image');
      expect(detectFileType('test.Mp4')).toBe('video');
    });

    it('should handle files with query parameters', () => {
      expect(detectFileType('test.jpg?width=200')).toBe('file');
    });

    it('should handle very long extensions', () => {
      expect(detectFileType('test.aaaaaaaaaaaaaaaaaa')).toBe('file');
    });
  });

  describe('upload integration', () => {
    let mockClient: any;

    beforeEach(() => {
      mockClient = {
        im: {
          file: {
            create: vi.fn(),
          },
          image: {
            create: vi.fn(),
          },
        },
      };

      mockedFs.stat.mockResolvedValue({
        size: 2048,
      } as any);
    });

    it('should use correct API for each file type', async () => {
      mockClient.im.image.create.mockResolvedValue({ image_key: 'key' });
      mockClient.im.file.create.mockResolvedValue({ file_key: 'key' });

      // Image
      await uploadFile(mockClient, 'test.jpg', 'chat1');
      expect(mockClient.im.image.create).toHaveBeenCalled();

      // File
      await uploadFile(mockClient, 'test.pdf', 'chat2');
      expect(mockClient.im.file.create).toHaveBeenCalled();
    });

    it('should handle zero-size files', async () => {
      mockedFs.stat.mockResolvedValue({
        size: 0,
      } as any);

      mockClient.im.file.create.mockResolvedValue({
        file_key: 'empty_key',
      });

      const result = await uploadFile(mockClient, 'empty.txt', 'chat1');

      expect(result.fileSize).toBe(0);
    });

    it('should handle large files', async () => {
      const largeSize = 100 * 1024 * 1024; // 100 MB
      mockedFs.stat.mockResolvedValue({
        size: largeSize,
      } as any);

      mockClient.im.file.create.mockResolvedValue({
        file_key: 'large_key',
      });

      const result = await uploadFile(mockClient, 'large.zip', 'chat1');

      expect(result.fileSize).toBe(largeSize);
    });
  });
});
