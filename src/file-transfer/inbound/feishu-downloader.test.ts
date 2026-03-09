/**
 * Tests for Feishu file downloader (src/file-transfer/inbound/feishu-downloader.ts)
 *
 * Tests the following functionality:
 * - File extension extraction
 * - File type mapping for Feishu API
 * - Download functionality (with mocked Feishu client)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractFileExtension,
  downloadFile,
} from './feishu-downloader.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 1024 }),
}));

// Mock config
vi.mock('../../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/workspace',
  },
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

describe('extractFileExtension', () => {
  it('should extract extension from simple filename', () => {
    expect(extractFileExtension('test.png')).toBe('.png');
    expect(extractFileExtension('document.pdf')).toBe('.pdf');
    expect(extractFileExtension('image.jpg')).toBe('.jpg');
  });

  it('should return extension in lowercase', () => {
    expect(extractFileExtension('test.PNG')).toBe('.png');
    expect(extractFileExtension('file.JPEG')).toBe('.jpeg');
  });

  it('should handle filenames with multiple dots', () => {
    expect(extractFileExtension('my.test.file.pdf')).toBe('.pdf');
    expect(extractFileExtension('archive.tar.gz')).toBe('.gz');
  });

  it('should return default extension for files without extension', () => {
    expect(extractFileExtension('noextension')).toBe('');
    expect(extractFileExtension('noextension', 'file')).toBe('.bin');
    expect(extractFileExtension('noextension', 'image')).toBe('.jpg');
    expect(extractFileExtension('noextension', 'media')).toBe('.mp4');
  });

  it('should return default extension for empty filename', () => {
    expect(extractFileExtension('')).toBe('');
    expect(extractFileExtension('', 'image')).toBe('.jpg');
    expect(extractFileExtension('', 'file')).toBe('.bin');
  });

  it('should return default extension for dot at start (hidden file)', () => {
    expect(extractFileExtension('.gitignore')).toBe('');
    expect(extractFileExtension('.env')).toBe('');
  });

  it('should return default extension for dot at end', () => {
    expect(extractFileExtension('file.')).toBe('');
  });

  it('should return default for invalid extension characters', () => {
    // Extensions must be 2-10 alphanumeric characters
    expect(extractFileExtension('file.a')).toBe(''); // Too short (1 char)
    expect(extractFileExtension('file.abcdefghijklm')).toBe(''); // Too long (>10 chars)
    expect(extractFileExtension('file.ab')).toBe('.ab'); // Valid (2 chars)
    expect(extractFileExtension('file.a1b2c3')).toBe('.a1b2c3'); // Valid alphanumeric
  });

  it('should handle fileType parameter correctly', () => {
    expect(extractFileExtension('test', 'image')).toBe('.jpg');
    expect(extractFileExtension('test', 'file')).toBe('.bin');
    expect(extractFileExtension('test', 'media')).toBe('.mp4');
    expect(extractFileExtension('test', 'video')).toBe('.mp4');
    expect(extractFileExtension('test', 'audio')).toBe('.mp3');
    expect(extractFileExtension('test', 'unknown')).toBe('');
  });
});

describe('downloadFile', () => {
  // Create mock client
  const createMockClient = () => ({
    im: {
      messageResource: {
        get: vi.fn().mockResolvedValue({
          writeFile: vi.fn().mockResolvedValue(undefined),
        }),
      },
      image: {
        get: vi.fn().mockResolvedValue({
          writeFile: vi.fn().mockResolvedValue(undefined),
        }),
      },
    },
    drive: {
      file: {
        download: vi.fn().mockResolvedValue({
          writeFile: vi.fn().mockResolvedValue(undefined),
        }),
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should download file using messageResource API when messageId is provided', async () => {
    const mockClient = createMockClient();
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      writeFile: mockWriteFile,
    });

    const result = await downloadFile(
      mockClient as unknown as Parameters<typeof downloadFile>[0],
      'file_key_123',
      'image',
      'test.png',
      'message_123'
    );

    expect(mockClient.im.messageResource.get).toHaveBeenCalledWith({
      path: {
        message_id: 'message_123',
        file_key: 'file_key_123',
      },
      params: {
        type: 'image',
      },
    });
    expect(mockWriteFile).toHaveBeenCalled();
    expect(result).toContain('test.png');
  });

  it('should map media type to video for API call', async () => {
    const mockClient = createMockClient();
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      writeFile: mockWriteFile,
    });

    await downloadFile(
      mockClient as unknown as Parameters<typeof downloadFile>[0],
      'file_key_123',
      'media',
      'video.mp4',
      'message_123'
    );

    expect(mockClient.im.messageResource.get).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          type: 'video',
        },
      })
    );
  });

  it('should use file type for .mov files', async () => {
    const mockClient = createMockClient();
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      writeFile: mockWriteFile,
    });

    await downloadFile(
      mockClient as unknown as Parameters<typeof downloadFile>[0],
      'file_key_123',
      'media',
      'video.mov',
      'message_123'
    );

    // .mov files should use 'file' type
    expect(mockClient.im.messageResource.get).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          type: 'file',
        },
      })
    );
  });

  it('should fallback to image API when no messageId and type is image', async () => {
    const mockClient = createMockClient();
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    (mockClient.im.image.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      writeFile: mockWriteFile,
    });

    await downloadFile(
      mockClient as unknown as Parameters<typeof downloadFile>[0],
      'image_key_123',
      'image',
      'test.png'
      // No messageId
    );

    expect(mockClient.im.image.get).toHaveBeenCalledWith({
      path: {
        image_key: 'image_key_123',
      },
    });
  });

  it('should fallback to drive API when no messageId and type is not image', async () => {
    const mockClient = createMockClient();
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    (mockClient.drive.file.download as ReturnType<typeof vi.fn>).mockResolvedValue({
      writeFile: mockWriteFile,
    });

    await downloadFile(
      mockClient as unknown as Parameters<typeof downloadFile>[0],
      'file_token_123',
      'file',
      'document.pdf'
      // No messageId
    );

    expect(mockClient.drive.file.download).toHaveBeenCalledWith({
      path: {
        file_token: 'file_token_123',
      },
    });
  });

  it('should throw error when API returns empty response', async () => {
    const mockClient = createMockClient();
    (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      downloadFile(
        mockClient as unknown as Parameters<typeof downloadFile>[0],
        'file_key_123',
        'image',
        'test.png',
        'message_123'
      )
    ).rejects.toThrow('Empty response from Feishu API');
  });

  it('should handle API errors', async () => {
    const mockClient = createMockClient();
    const apiError = new Error('API Error') as Error & { response?: { status: number } };
    apiError.response = { status: 400 };
    (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>).mockRejectedValue(apiError);

    await expect(
      downloadFile(
        mockClient as unknown as Parameters<typeof downloadFile>[0],
        'file_key_123',
        'image',
        'test.png',
        'message_123'
      )
    ).rejects.toThrow('API Error');
  });

  it('should generate filename from fileKey when no fileName provided', async () => {
    const mockClient = createMockClient();
    const mockWriteFile = vi.fn().mockResolvedValue(undefined);
    (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      writeFile: mockWriteFile,
    });

    const result = await downloadFile(
      mockClient as unknown as Parameters<typeof downloadFile>[0],
      'file_key_123456789012',
      'image',
      undefined,
      'message_123'
    );

    // Should use fileKey substring in filename
    expect(result).toContain('image_file_key_1234');
  });

  describe('retry logic (Issue #1205)', () => {
    it('should retry on SDK internal error (undefined.readable)', async () => {
      const mockClient = createMockClient();
      const mockWriteFile = vi.fn().mockResolvedValue(undefined);

      // First call fails with SDK internal error, second succeeds
      (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>)
        .mockRejectedValueOnce(new Error('Cannot read properties of undefined (reading "readable")'))
        .mockResolvedValueOnce({
          writeFile: mockWriteFile,
        });

      const result = await downloadFile(
        mockClient as unknown as Parameters<typeof downloadFile>[0],
        'file_key_123',
        'image',
        'test.png',
        'message_123'
      );

      // Should have been called twice (1 failure + 1 success)
      expect(mockClient.im.messageResource.get).toHaveBeenCalledTimes(2);
      expect(mockWriteFile).toHaveBeenCalled();
      expect(result).toContain('test.png');
    });

    it('should retry up to max retries on persistent retriable errors', async () => {
      const mockClient = createMockClient();

      // All calls fail with retriable error
      (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Cannot read properties of undefined (reading "readable")')
      );

      await expect(
        downloadFile(
          mockClient as unknown as Parameters<typeof downloadFile>[0],
          'file_key_123',
          'image',
          'test.png',
          'message_123'
        )
      ).rejects.toThrow('Feishu API returned empty response');

      // Should have been called maxRetries + 1 times (initial + 3 retries)
      expect(mockClient.im.messageResource.get).toHaveBeenCalledTimes(4);
    });

    it('should provide enhanced error message for undefined.readable error', async () => {
      const mockClient = createMockClient();

      // All calls fail with retriable error
      (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Cannot read properties of undefined (reading "readable")')
      );

      await expect(
        downloadFile(
          mockClient as unknown as Parameters<typeof downloadFile>[0],
          'file_key_123',
          'image',
          'test.png',
          'message_123'
        )
      ).rejects.toThrow(/file has expired or been deleted/);
    });

    it('should not retry on non-retriable errors', async () => {
      const mockClient = createMockClient();

      // Non-retriable error (e.g., authentication error)
      (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Authentication failed')
      );

      await expect(
        downloadFile(
          mockClient as unknown as Parameters<typeof downloadFile>[0],
          'file_key_123',
          'image',
          'test.png',
          'message_123'
        )
      ).rejects.toThrow('Authentication failed');

      // Should have been called only once (no retry)
      expect(mockClient.im.messageResource.get).toHaveBeenCalledTimes(1);
    });

    it('should throw error when response lacks writeFile method', async () => {
      const mockClient = createMockClient();

      // Response without writeFile method
      (mockClient.im.messageResource.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        // No writeFile method
      });

      await expect(
        downloadFile(
          mockClient as unknown as Parameters<typeof downloadFile>[0],
          'file_key_123',
          'image',
          'test.png',
          'message_123'
        )
      ).rejects.toThrow('Invalid response from Feishu API - missing writeFile method');
    });
  });
});
