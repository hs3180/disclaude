/**
 * Tests for Feishu file uploader (src/feishu/file-uploader.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectFileType, uploadFile, sendFileMessage, uploadAndSendFile, type UploadResult } from './file-uploader.js';
import * as fs from 'fs/promises';
import * as fsStream from 'fs';
import * as lark from '@larksuiteoapi/node-sdk';

// Type for mock client
interface MockClient {
  im: {
    file: { create: ReturnType<typeof vi.fn> };
    image: { create: ReturnType<typeof vi.fn> };
    message: { create: ReturnType<typeof vi.fn> };
  };
}

vi.mock('fs/promises');
vi.mock('fs');
vi.mock('@larksuiteoapi/node-sdk', () => ({ default: { Client: vi.fn() } }));
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));

const mockedFs = vi.mocked(fs);
const mockedFsStream = vi.mocked(fsStream);

describe('Feishu File Uploader', () => {
  // Parameterized file type detection tests
  describe('detectFileType', () => {
    const testCases = [
      // Image files
      ...['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'ico', 'heic', 'tiff', 'tif']
        .map((ext) => ({ file: `test.${ext}`, expected: 'image' as const })),
      // Audio files
      ...['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'wma', 'amr']
        .map((ext) => ({ file: `test.${ext}`, expected: 'audio' as const })),
      // Video files
      ...['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v']
        .map((ext) => ({ file: `test.${ext}`, expected: 'video' as const })),
      // Unknown/default files
      ...['pdf', 'doc', 'txt', 'zip', 'json', 'unknown']
        .map((ext) => ({ file: `test.${ext}`, expected: 'file' as const })),
      // Edge cases
      { file: 'test.JPG', expected: 'image' },
      { file: 'test.PNG', expected: 'image' },
      { file: 'test.JpEg', expected: 'image' },
      { file: 'test.file.jpg', expected: 'image' },
      { file: '/path/to/file.jpg', expected: 'image' },
      { file: 'testfile', expected: 'file' },
      { file: '', expected: 'file' },
      { file: 'test.jpg?width=200', expected: 'file' },
    ];

    it.each(testCases)('should detect $file as $expected', ({ file, expected }) => {
      expect(detectFileType(file)).toBe(expected);
    });
  });

  describe('uploadFile', () => {
    let mockClient: MockClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClient = {
        im: {
          file: { create: vi.fn() },
          image: { create: vi.fn() },
          message: { create: vi.fn() },
        },
      };
      mockedFs.stat.mockResolvedValue({ size: 1024 } as fsStream.Stats);
      (mockedFsStream as Record<string, unknown>).createReadStream = vi.fn(() => ({ on: vi.fn(), pipe: vi.fn() }));
    });

    const uploadTestCases = [
      { file: '/path/to/image.jpg', fileType: 'image', mockKey: 'image_key', expectedKey: 'img_key' },
      { file: '/path/to/doc.pdf', fileType: 'file', mockKey: 'file_key', expectedKey: 'file_key' },
      { file: '/path/to/audio.mp3', fileType: 'audio', mockKey: 'file_key', expectedKey: 'audio_key' },
      { file: '/path/to/video.mp4', fileType: 'video', mockKey: 'file_key', expectedKey: 'video_key' },
    ];

    it.each(uploadTestCases)('should upload $fileType via correct API', async ({ file, fileType, mockKey, expectedKey }) => {
      const mockCreate = mockClient.im[fileType === 'image' ? 'image' : 'file'].create;
      mockCreate.mockResolvedValue({ [mockKey]: expectedKey });

      const result = await uploadFile(mockClient as unknown as lark.Client, file, 'oc_chat123');

      expect(result.fileType).toBe(fileType);
      expect(result.fileKey).toBe(expectedKey);
      expect(mockCreate).toHaveBeenCalled();
    });

    it('should handle upload errors', async () => {
      mockClient.im.image.create.mockRejectedValue(new Error('Upload failed'));
      await expect(uploadFile(mockClient as unknown as lark.Client, '/path/to/image.jpg', 'oc_chat123')).rejects.toThrow();
    });

    it('should handle zero-size and large files', async () => {
      const sizes = [0, 100 * 1024 * 1024]; // 0 and 100MB
      mockClient.im.file.create.mockResolvedValue({ file_key: 'key' });

      for (const size of sizes) {
        mockedFs.stat.mockResolvedValue({ size } as fsStream.Stats);
        const result = await uploadFile(mockClient as unknown as lark.Client, 'test.txt', 'chat1');
        expect(result.fileSize).toBe(size);
      }
    });

    it('should upload audio file as stream', async () => {
      mockClient.im.file.create.mockResolvedValue({ file_key: 'audio_key' });
      mockedFs.stat.mockResolvedValue({ size: 5000 } as fsStream.Stats);

      const result = await uploadFile(mockClient as unknown as lark.Client, '/path/to/song.mp3', 'oc_chat123');

      expect(result.fileType).toBe('audio');
      expect(result.fileKey).toBe('audio_key');
      expect(result.fileSize).toBe(5000);
    });

    it('should upload video file as stream', async () => {
      mockClient.im.file.create.mockResolvedValue({ file_key: 'video_key' });
      mockedFs.stat.mockResolvedValue({ size: 10000000 } as fsStream.Stats);

      const result = await uploadFile(mockClient as unknown as lark.Client, '/path/to/video.mp4', 'oc_chat123');

      expect(result.fileType).toBe('video');
      expect(result.fileKey).toBe('video_key');
      expect(result.fileSize).toBe(10000000);
    });

    it('should return fileName in result', async () => {
      mockClient.im.file.create.mockResolvedValue({ file_key: 'key' });

      const result = await uploadFile(mockClient as unknown as lark.Client, '/path/to/document.pdf', 'oc_chat123');

      expect(result.fileName).toBe('document.pdf');
    });

    it('should handle missing file_key in response', async () => {
      mockClient.im.file.create.mockResolvedValue({});

      await expect(uploadFile(mockClient as unknown as lark.Client, '/path/to/file.txt', 'oc_chat123')).rejects.toThrow();
    });

    it('should handle missing image_key in response', async () => {
      mockClient.im.image.create.mockResolvedValue({});

      await expect(uploadFile(mockClient as unknown as lark.Client, '/path/to/image.jpg', 'oc_chat123')).rejects.toThrow();
    });

    it('should call file API for audio files', async () => {
      mockClient.im.file.create.mockResolvedValue({ file_key: 'audio_key' });

      await uploadFile(mockClient as unknown as lark.Client, '/path/to/audio.mp3', 'oc_chat123');

      // Audio should use file API (not image API)
      expect(mockClient.im.file.create).toHaveBeenCalled();
    });

    it('should call file API for video files', async () => {
      mockClient.im.file.create.mockResolvedValue({ file_key: 'video_key' });

      await uploadFile(mockClient as unknown as lark.Client, '/path/to/video.mp4', 'oc_chat123');

      // Video should use file API (not image API)
      expect(mockClient.im.file.create).toHaveBeenCalled();
    });

    it('should call file API for regular files', async () => {
      mockClient.im.file.create.mockResolvedValue({ file_key: 'file_key' });

      await uploadFile(mockClient as unknown as lark.Client, '/path/to/document.pdf', 'oc_chat123');

      expect(mockClient.im.file.create).toHaveBeenCalled();
    });
  });

  describe('sendFileMessage', () => {
    let mockClient: MockClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClient = {
        im: {
          file: { create: vi.fn() },
          image: { create: vi.fn() },
          message: { create: vi.fn().mockResolvedValue({ data: { message_id: 'msg_123' } }) },
        },
      };
    });

    it('should send image message', async () => {
      const uploadResult: UploadResult = {
        fileKey: 'img_key_123',
        fileType: 'image',
        fileName: 'test.jpg',
        fileSize: 1024,
      };

      await sendFileMessage(mockClient as unknown as lark.Client, 'oc_chat123', uploadResult);

      expect(mockClient.im.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            msg_type: 'image',
            receive_id: 'oc_chat123',
          }),
        })
      );
    });

    it('should send audio message', async () => {
      const uploadResult: UploadResult = {
        fileKey: 'audio_key_123',
        fileType: 'audio',
        fileName: 'test.mp3',
        fileSize: 5000,
      };

      await sendFileMessage(mockClient as unknown as lark.Client, 'oc_chat123', uploadResult);

      expect(mockClient.im.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            msg_type: 'audio',
            receive_id: 'oc_chat123',
          }),
        })
      );
    });

    it('should send video message as media type', async () => {
      const uploadResult: UploadResult = {
        fileKey: 'video_key_123',
        fileType: 'video',
        fileName: 'test.mp4',
        fileSize: 10000000,
      };

      await sendFileMessage(mockClient as unknown as lark.Client, 'oc_chat123', uploadResult);

      expect(mockClient.im.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            msg_type: 'media',
            receive_id: 'oc_chat123',
          }),
        })
      );
    });

    it('should send file message for regular files', async () => {
      const uploadResult: UploadResult = {
        fileKey: 'file_key_123',
        fileType: 'file',
        fileName: 'document.pdf',
        fileSize: 1024,
      };

      await sendFileMessage(mockClient as unknown as lark.Client, 'oc_chat123', uploadResult);

      expect(mockClient.im.message.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            msg_type: 'file',
            receive_id: 'oc_chat123',
          }),
        })
      );
    });

    it('should handle send errors', async () => {
      mockClient.im.message.create.mockRejectedValue(new Error('Send failed'));
      const uploadResult: UploadResult = {
        fileKey: 'key_123',
        fileType: 'file',
        fileName: 'test.pdf',
        fileSize: 1024,
      };

      await expect(sendFileMessage(mockClient as unknown as lark.Client, 'oc_chat123', uploadResult)).rejects.toThrow();
    });
  });

  describe('uploadAndSendFile', () => {
    let mockClient: MockClient;

    beforeEach(() => {
      vi.clearAllMocks();
      mockClient = {
        im: {
          file: { create: vi.fn().mockResolvedValue({ file_key: 'file_key' }) },
          image: { create: vi.fn().mockResolvedValue({ image_key: 'img_key' }) },
          message: { create: vi.fn().mockResolvedValue({ data: { message_id: 'msg_123' } }) },
        },
      };
      mockedFs.stat.mockResolvedValue({ size: 1024 } as fsStream.Stats);
      (mockedFsStream as Record<string, unknown>).createReadStream = vi.fn(() => ({ on: vi.fn(), pipe: vi.fn() }));
    });

    it('should upload and send file', async () => {
      const result = await uploadAndSendFile(mockClient as unknown as lark.Client, '/path/to/doc.pdf', 'oc_chat123');

      expect(result).toBe(1024); // Returns file size
      expect(mockClient.im.file.create).toHaveBeenCalled();
      expect(mockClient.im.message.create).toHaveBeenCalled();
    });

    it('should upload and send image', async () => {
      const result = await uploadAndSendFile(mockClient as unknown as lark.Client, '/path/to/image.jpg', 'oc_chat123');

      expect(result).toBe(1024);
      expect(mockClient.im.image.create).toHaveBeenCalled();
      expect(mockClient.im.message.create).toHaveBeenCalled();
    });

    it('should handle errors and throw', async () => {
      mockClient.im.file.create.mockRejectedValue(new Error('Upload failed'));

      await expect(uploadAndSendFile(mockClient as unknown as lark.Client, '/path/to/doc.pdf', 'oc_chat123')).rejects.toThrow();
    });
  });
});
