/**
 * Tests for file-downloader module.
 *
 * Tests the following functionality:
 * - extractFileExtension utility
 * - downloadFile with various file types
 * - Error handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractFileExtension, downloadFile } from './file-downloader.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

// Mock lark SDK
const mockWriteFile = vi.fn().mockResolvedValue(undefined);
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(),
}));

describe('extractFileExtension', () => {
  it('should extract .jpg extension from filename', () => {
    expect(extractFileExtension('photo.jpg')).toBe('.jpg');
    expect(extractFileExtension('image.jpg')).toBe('.jpg');
    expect(extractFileExtension('my.photo.jpg')).toBe('.jpg');
  });

  it('should extract .png extension from filename', () => {
    expect(extractFileExtension('screenshot.png')).toBe('.png');
    expect(extractFileExtension('diagram.png')).toBe('.png');
  });

  it('should extract .gif extension from filename', () => {
    expect(extractFileExtension('animation.gif')).toBe('.gif');
  });

  it('should extract .pdf extension from filename', () => {
    expect(extractFileExtension('document.pdf')).toBe('.pdf');
  });

  it('should return empty string when no extension', () => {
    expect(extractFileExtension('noextension')).toBe('');
    expect(extractFileExtension('file')).toBe('');
    expect(extractFileExtension('image_img_v3_0')).toBe('');
  });

  it('should handle empty string', () => {
    expect(extractFileExtension('')).toBe('');
  });

  it('should handle multiple dots correctly', () => {
    expect(extractFileExtension('my.file.name.jpg')).toBe('.jpg');
    expect(extractFileExtension('archive.tar.gz')).toBe('.gz');
  });

  it('should handle uppercase extensions (normalized to lowercase)', () => {
    expect(extractFileExtension('photo.JPG')).toBe('.jpg');
    expect(extractFileExtension('photo.Png')).toBe('.png');
  });

  it('should return default extension for image type when no extension', () => {
    expect(extractFileExtension('image_img_v3_0', 'image')).toBe('.jpg');
    expect(extractFileExtension('noextension', 'file')).toBe('.bin');
  });

  it('should prioritize actual extension over default', () => {
    expect(extractFileExtension('photo.png', 'image')).toBe('.png');
    expect(extractFileExtension('document.pdf', 'file')).toBe('.pdf');
  });

  it('should return default for media type', () => {
    expect(extractFileExtension('noextension', 'media')).toBe('.mp4');
  });

  it('should return default for video type', () => {
    expect(extractFileExtension('noextension', 'video')).toBe('.mp4');
  });

  it('should return default for audio type', () => {
    expect(extractFileExtension('noextension', 'audio')).toBe('.mp3');
  });

  it('should return empty string for unknown type with no extension', () => {
    expect(extractFileExtension('noextension', 'unknown')).toBe('');
  });

  it('should reject extensions that are too short', () => {
    expect(extractFileExtension('file.x', 'file')).toBe('.bin');
  });

  it('should reject extensions that are too long', () => {
    expect(extractFileExtension('file.verylongextension', 'file')).toBe('.bin');
  });

  it('should reject extensions with special characters', () => {
    expect(extractFileExtension('file.e-x', 'file')).toBe('.bin');
  });

  it('should handle hidden files (dot at start)', () => {
    expect(extractFileExtension('.gitignore', 'file')).toBe('.bin');
  });

  it('should handle dot at end', () => {
    expect(extractFileExtension('file.', 'file')).toBe('.bin');
  });
});

describe('downloadFile', () => {
  let mockClient: { im: { messageResource: { get: ReturnType<typeof vi.fn> }; image: { get: ReturnType<typeof vi.fn> } }; drive: { file: { download: ReturnType<typeof vi.fn> } } };

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      im: {
        messageResource: {
          get: vi.fn().mockResolvedValue({
            writeFile: mockWriteFile,
          }),
        },
        image: {
          get: vi.fn().mockResolvedValue({
            writeFile: mockWriteFile,
          }),
        },
      },
      drive: {
        file: {
          download: vi.fn().mockResolvedValue({
            writeFile: mockWriteFile,
          }),
        },
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should download file with messageId using messageResource API', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'file_key_123',
      'file',
      'document.pdf',
      'msg_001'
    );

    expect(mockClient.im.messageResource.get).toHaveBeenCalledWith({
      path: {
        message_id: 'msg_001',
        file_key: 'file_key_123',
      },
      params: {
        type: 'file',
      },
    });
    expect(result).toContain('attachments');
  });

  it('should download image with messageId using messageResource API', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'img_key_123',
      'image',
      'photo.jpg',
      'msg_001'
    );

    expect(mockClient.im.messageResource.get).toHaveBeenCalledWith({
      path: {
        message_id: 'msg_001',
        file_key: 'img_key_123',
      },
      params: {
        type: 'image',
      },
    });
    expect(result).toContain('attachments');
  });

  it('should download video with messageId using messageResource API', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'video_key_123',
      'video',
      'video.mp4',
      'msg_001'
    );

    expect(mockClient.im.messageResource.get).toHaveBeenCalledWith({
      path: {
        message_id: 'msg_001',
        file_key: 'video_key_123',
      },
      params: {
        type: 'video',
      },
    });
    expect(result).toContain('attachments');
  });

  it('should download media type as video for API', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'media_key_123',
      'media',
      'video.mp4',
      'msg_001'
    );

    expect(mockClient.im.messageResource.get).toHaveBeenCalledWith({
      path: {
        message_id: 'msg_001',
        file_key: 'media_key_123',
      },
      params: {
        type: 'video',
      },
    });
    expect(result).toContain('attachments');
  });

  it('should download audio with messageId using messageResource API', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'audio_key_123',
      'audio',
      'audio.mp3',
      'msg_001'
    );

    expect(mockClient.im.messageResource.get).toHaveBeenCalledWith({
      path: {
        message_id: 'msg_001',
        file_key: 'audio_key_123',
      },
      params: {
        type: 'audio',
      },
    });
    expect(result).toContain('attachments');
  });

  it('should download .mov files as file type instead of video', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'mov_key_123',
      'media',
      'video.MOV',
      'msg_001'
    );

    expect(mockClient.im.messageResource.get).toHaveBeenCalledWith({
      path: {
        message_id: 'msg_001',
        file_key: 'mov_key_123',
      },
      params: {
        type: 'file',
      },
    });
    expect(result).toContain('attachments');
  });

  it('should fall back to image API for images without messageId', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'img_key_123',
      'image',
      'photo.jpg'
    );

    expect(mockClient.im.image.get).toHaveBeenCalledWith({
      path: {
        image_key: 'img_key_123',
      },
    });
    expect(result).toContain('attachments');
  });

  it('should fall back to drive API for files without messageId', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'drive_key_123',
      'file',
      'document.pdf'
    );

    expect(mockClient.drive.file.download).toHaveBeenCalledWith({
      path: {
        file_token: 'drive_key_123',
      },
    });
    expect(result).toContain('attachments');
  });

  it('should handle unknown file types as file', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'unknown_key',
      'unknown_type',
      'file.dat',
      'msg_001'
    );

    expect(mockClient.im.messageResource.get).toHaveBeenCalledWith({
      path: {
        message_id: 'msg_001',
        file_key: 'unknown_key',
      },
      params: {
        type: 'file',
      },
    });
    expect(result).toContain('attachments');
  });

  it('should throw error when API returns empty response', async () => {
    mockClient.im.messageResource.get.mockResolvedValueOnce(null);

    await expect(
      downloadFile(
        mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
        'key',
        'file',
        'test.txt',
        'msg_001'
      )
    ).rejects.toThrow('Empty response from Feishu API');
  });

  it('should handle API errors', async () => {
    const apiError = new Error('API Error') as Error & { code?: string; response?: { status?: number } };
    apiError.code = 'invalid_param';
    apiError.response = { status: 400 };
    mockClient.im.messageResource.get.mockRejectedValueOnce(apiError);

    await expect(
      downloadFile(
        mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
        'key',
        'file',
        'test.txt',
        'msg_001'
      )
    ).rejects.toThrow('API Error');
  });

  it('should handle file without name', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'file_key',
      'file',
      undefined,
      'msg_001'
    );

    expect(result).toContain('attachments');
    expect(mockClient.im.messageResource.get).toHaveBeenCalled();
  });

  it('should sanitize problematic characters in filename', async () => {
    const result = await downloadFile(
      mockClient as unknown as import('@larksuiteoapi/node-sdk').Client,
      'file_key',
      'file',
      'file<with>problematic:chars.pdf',
      'msg_001'
    );

    expect(result).toContain('attachments');
    // The filename should be sanitized (no special characters)
    expect(result).not.toContain('<');
    expect(result).not.toContain('>');
    expect(result).not.toContain(':');
  });
});

