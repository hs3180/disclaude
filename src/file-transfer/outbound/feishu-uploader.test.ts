/**
 * Tests for Feishu file uploader (src/file-transfer/outbound/feishu-uploader.ts)
 *
 * Tests the following functionality:
 * - File type detection
 * - File upload to Feishu
 * - File message sending
 * - Combined upload and send workflow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  detectFileType,
  uploadFile,
  sendFileMessage,
  uploadAndSendFile,
} from './feishu-uploader.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
}));

// Mock fs stream
vi.mock('fs', () => ({
  createReadStream: vi.fn().mockReturnValue('mock-stream'),
}));

// Mock logger
vi.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('detectFileType', () => {
  it('should detect image types', () => {
    expect(detectFileType('test.jpg')).toBe('image');
    expect(detectFileType('test.jpeg')).toBe('image');
    expect(detectFileType('test.png')).toBe('image');
    expect(detectFileType('test.gif')).toBe('image');
    expect(detectFileType('test.webp')).toBe('image');
    expect(detectFileType('test.bmp')).toBe('image');
    expect(detectFileType('test.ico')).toBe('image');
    expect(detectFileType('test.heic')).toBe('image');
    expect(detectFileType('test.tiff')).toBe('image');
    expect(detectFileType('test.tif')).toBe('image');
  });

  it('should detect audio types', () => {
    expect(detectFileType('test.mp3')).toBe('audio');
    expect(detectFileType('test.wav')).toBe('audio');
    expect(detectFileType('test.ogg')).toBe('audio');
    expect(detectFileType('test.m4a')).toBe('audio');
    expect(detectFileType('test.aac')).toBe('audio');
    expect(detectFileType('test.flac')).toBe('audio');
    expect(detectFileType('test.wma')).toBe('audio');
    expect(detectFileType('test.amr')).toBe('audio');
  });

  it('should detect video types', () => {
    expect(detectFileType('test.mp4')).toBe('video');
    expect(detectFileType('test.mov')).toBe('video');
    expect(detectFileType('test.avi')).toBe('video');
    expect(detectFileType('test.mkv')).toBe('video');
    expect(detectFileType('test.webm')).toBe('video');
    expect(detectFileType('test.flv')).toBe('video');
    expect(detectFileType('test.wmv')).toBe('video');
    expect(detectFileType('test.m4v')).toBe('video');
  });

  it('should return file for unknown types', () => {
    expect(detectFileType('test.pdf')).toBe('file');
    expect(detectFileType('test.doc')).toBe('file');
    expect(detectFileType('test.xlsx')).toBe('file');
    expect(detectFileType('test.unknown')).toBe('file');
    expect(detectFileType('noextension')).toBe('file');
  });

  it('should be case-insensitive', () => {
    expect(detectFileType('test.PNG')).toBe('image');
    expect(detectFileType('test.JPG')).toBe('image');
    expect(detectFileType('test.MP4')).toBe('video');
    expect(detectFileType('test.MP3')).toBe('audio');
  });

  it('should handle paths with directories', () => {
    expect(detectFileType('/path/to/file.png')).toBe('image');
    expect(detectFileType('C:\\Users\\test\\video.mp4')).toBe('video');
  });
});

describe('uploadFile', () => {
  const createMockClient = () => ({
    im: {
      image: {
        create: vi.fn().mockResolvedValue({ image_key: 'img_key_123' }),
      },
      file: {
        create: vi.fn().mockResolvedValue({ file_key: 'file_key_123' }),
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should upload image using image API', async () => {
    const mockClient = createMockClient();

    const result = await uploadFile(
      mockClient as unknown as Parameters<typeof uploadFile>[0],
      '/path/to/test.png',
      'chat_123'
    );

    expect(mockClient.im.image.create).toHaveBeenCalledWith({
      data: {
        image: 'mock-stream',
        image_type: 'message',
      },
    });
    expect(result.fileKey).toBe('img_key_123');
    expect(result.fileType).toBe('image');
    expect(result.fileName).toBe('test.png');
  });

  it('should upload video using file API with mp4 type', async () => {
    const mockClient = createMockClient();

    const result = await uploadFile(
      mockClient as unknown as Parameters<typeof uploadFile>[0],
      '/path/to/video.mp4',
      'chat_123'
    );

    expect(mockClient.im.file.create).toHaveBeenCalledWith({
      data: {
        file_type: 'mp4',
        file_name: 'video.mp4',
        file: 'mock-stream',
      },
    });
    expect(result.fileKey).toBe('file_key_123');
    expect(result.apiFileType).toBe('mp4');
  });

  it('should upload audio using file API with opus type', async () => {
    const mockClient = createMockClient();

    const result = await uploadFile(
      mockClient as unknown as Parameters<typeof uploadFile>[0],
      '/path/to/audio.mp3',
      'chat_123'
    );

    expect(mockClient.im.file.create).toHaveBeenCalledWith({
      data: {
        file_type: 'opus',
        file_name: 'audio.mp3',
        file: 'mock-stream',
      },
    });
    expect(result.apiFileType).toBe('opus');
  });

  it('should upload generic file using file API with pdf type', async () => {
    const mockClient = createMockClient();

    const result = await uploadFile(
      mockClient as unknown as Parameters<typeof uploadFile>[0],
      '/path/to/document.pdf',
      'chat_123'
    );

    expect(mockClient.im.file.create).toHaveBeenCalledWith({
      data: {
        file_type: 'pdf',
        file_name: 'document.pdf',
        file: 'mock-stream',
      },
    });
    expect(result.apiFileType).toBe('pdf');
  });

  it('should throw error if no file_key returned', async () => {
    const mockClient = createMockClient();
    (mockClient.im.image.create as ReturnType<typeof vi.fn>).mockResolvedValue({});

    await expect(
      uploadFile(
        mockClient as unknown as Parameters<typeof uploadFile>[0],
        '/path/to/test.png',
        'chat_123'
      )
    ).rejects.toThrow('No file_key returned from upload API');
  });

  it('should handle upload errors', async () => {
    const mockClient = createMockClient();
    (mockClient.im.image.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Upload failed')
    );

    await expect(
      uploadFile(
        mockClient as unknown as Parameters<typeof uploadFile>[0],
        '/path/to/test.png',
        'chat_123'
      )
    ).rejects.toThrow('Failed to upload file');
  });
});

describe('sendFileMessage', () => {
  const createMockClient = () => ({
    im: {
      message: {
        create: vi.fn().mockResolvedValue({
          data: { message_id: 'msg_123' },
        }),
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should send image message with correct msg_type', async () => {
    const mockClient = createMockClient();
    const uploadResult = {
      fileKey: 'img_key_123',
      fileType: 'image' as const,
      fileName: 'test.png',
      fileSize: 1024,
    };

    await sendFileMessage(
      mockClient as unknown as Parameters<typeof sendFileMessage>[0],
      'chat_123',
      uploadResult
    );

    expect(mockClient.im.message.create).toHaveBeenCalledWith({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: 'chat_123',
        msg_type: 'image',
        content: JSON.stringify({ image_key: 'img_key_123' }),
      },
    });
  });

  it('should send audio message with correct msg_type', async () => {
    const mockClient = createMockClient();
    const uploadResult = {
      fileKey: 'file_key_123',
      fileType: 'audio' as const,
      fileName: 'audio.mp3',
      fileSize: 1024,
      apiFileType: 'opus',
    };

    await sendFileMessage(
      mockClient as unknown as Parameters<typeof sendFileMessage>[0],
      'chat_123',
      uploadResult
    );

    expect(mockClient.im.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: 'audio',
          content: JSON.stringify({ file_key: 'file_key_123' }),
        }),
      })
    );
  });

  it('should send video message with media msg_type', async () => {
    const mockClient = createMockClient();
    const uploadResult = {
      fileKey: 'file_key_123',
      fileType: 'video' as const,
      fileName: 'video.mp4',
      fileSize: 1024,
      apiFileType: 'mp4',
    };

    await sendFileMessage(
      mockClient as unknown as Parameters<typeof sendFileMessage>[0],
      'chat_123',
      uploadResult
    );

    expect(mockClient.im.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: 'media',
        }),
      })
    );
  });

  it('should send generic file with file msg_type', async () => {
    const mockClient = createMockClient();
    const uploadResult = {
      fileKey: 'file_key_123',
      fileType: 'file' as const,
      fileName: 'document.pdf',
      fileSize: 1024,
      apiFileType: 'pdf',
    };

    await sendFileMessage(
      mockClient as unknown as Parameters<typeof sendFileMessage>[0],
      'chat_123',
      uploadResult
    );

    expect(mockClient.im.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          msg_type: 'file',
        }),
      })
    );
  });

  it('should include parent_id for thread replies', async () => {
    const mockClient = createMockClient();
    const uploadResult = {
      fileKey: 'img_key_123',
      fileType: 'image' as const,
      fileName: 'test.png',
      fileSize: 1024,
    };

    await sendFileMessage(
      mockClient as unknown as Parameters<typeof sendFileMessage>[0],
      'chat_123',
      uploadResult,
      'parent_msg_456'
    );

    expect(mockClient.im.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parent_id: 'parent_msg_456',
        }),
      })
    );
  });

  it('should handle send errors with detailed info', async () => {
    const mockClient = createMockClient();
    (mockClient.im.message.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Send failed')
    );
    const uploadResult = {
      fileKey: 'img_key_123',
      fileType: 'image' as const,
      fileName: 'test.png',
      fileSize: 1024,
    };

    await expect(
      sendFileMessage(
        mockClient as unknown as Parameters<typeof sendFileMessage>[0],
        'chat_123',
        uploadResult
      )
    ).rejects.toThrow('Failed to send file message');
  });
});

describe('uploadAndSendFile', () => {
  const createMockClient = () => ({
    im: {
      image: {
        create: vi.fn().mockResolvedValue({ image_key: 'img_key_123' }),
      },
      file: {
        create: vi.fn().mockResolvedValue({ file_key: 'file_key_123' }),
      },
      message: {
        create: vi.fn().mockResolvedValue({
          data: { message_id: 'msg_123' },
        }),
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should upload and send file in one operation', async () => {
    const mockClient = createMockClient();

    const result = await uploadAndSendFile(
      mockClient as unknown as Parameters<typeof uploadAndSendFile>[0],
      '/path/to/test.png',
      'chat_123'
    );

    expect(mockClient.im.image.create).toHaveBeenCalled();
    expect(mockClient.im.message.create).toHaveBeenCalled();
    expect(result).toBe(1024); // File size
  });

  it('should upload and send with thread reply', async () => {
    const mockClient = createMockClient();

    await uploadAndSendFile(
      mockClient as unknown as Parameters<typeof uploadAndSendFile>[0],
      '/path/to/test.png',
      'chat_123',
      'parent_msg_456'
    );

    expect(mockClient.im.message.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          parent_id: 'parent_msg_456',
        }),
      })
    );
  });
});
