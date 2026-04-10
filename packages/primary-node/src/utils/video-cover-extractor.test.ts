/**
 * Tests for video cover extraction utility.
 *
 * Issue #2265: Proper video support via msg_type:'media'.
 *
 * Tests cover:
 * - VIDEO_EXTENSIONS set contents
 * - extractVideoCover with missing file
 * - extractVideoCover when ffmpeg is not available
 * - isFfmpegAvailable caching behavior
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@disclaude/core')>();
  return {
    ...actual,
    createLogger: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
    })),
  };
});

// Mock child_process using hoisted factory (no external references)
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(),
}));

import { VIDEO_EXTENSIONS, extractVideoCover, isFfmpegAvailable, _resetFfmpegCache } from './video-cover-extractor.js';

// Get the mocked spawnSync after module import
const mockSpawnSync = vi.mocked(
  (await import('node:child_process')).spawnSync,
);

describe('VideoCoverExtractor', () => {
  beforeEach(() => {
    _resetFfmpegCache();
    mockSpawnSync.mockReset();
  });

  afterEach(() => {
    _resetFfmpegCache();
  });

  describe('VIDEO_EXTENSIONS', () => {
    it('should include common video formats', () => {
      expect(VIDEO_EXTENSIONS.has('.mp4')).toBe(true);
      expect(VIDEO_EXTENSIONS.has('.mov')).toBe(true);
      expect(VIDEO_EXTENSIONS.has('.avi')).toBe(true);
      expect(VIDEO_EXTENSIONS.has('.mkv')).toBe(true);
      expect(VIDEO_EXTENSIONS.has('.webm')).toBe(true);
      expect(VIDEO_EXTENSIONS.has('.flv')).toBe(true);
      expect(VIDEO_EXTENSIONS.has('.wmv')).toBe(true);
    });

    it('should not include image or document extensions', () => {
      expect(VIDEO_EXTENSIONS.has('.jpg')).toBe(false);
      expect(VIDEO_EXTENSIONS.has('.png')).toBe(false);
      expect(VIDEO_EXTENSIONS.has('.pdf')).toBe(false);
      expect(VIDEO_EXTENSIONS.has('.zip')).toBe(false);
    });
  });

  describe('extractVideoCover', () => {
    it('should return error for non-existent file', () => {
      const result = extractVideoCover('/nonexistent/video.mp4');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should return error for empty path', () => {
      const result = extractVideoCover('');
      expect(result.success).toBe(false);
    });

    it('should return error when ffmpeg is not available', () => {
      // Make isFfmpegAvailable return false by making ffmpeg -version fail
      mockSpawnSync.mockImplementation(() => {
        const err = new Error('spawnSync ffmpeg ENOENT') as any;
        err.status = null;
        return err;
      });

      const testPath = path.join(os.tmpdir(), `test_video_${Date.now()}.mp4`);
      fs.writeFileSync(testPath, Buffer.from('fake mp4 content'));

      try {
        const result = extractVideoCover(testPath);
        expect(result.success).toBe(false);
        expect(result.error).toContain('ffmpeg');
      } finally {
        try { fs.unlinkSync(testPath); } catch { /* ignore */ }
      }
    });

    it('should return success when ffmpeg extracts a cover frame', () => {
      mockSpawnSync.mockImplementation(((..._args: unknown[]) => {
        const args = _args[1] as string[] | undefined;
        if (args && args[0] === '-version') {
          return { status: 0 };
        }
        // ffmpeg -i video -vframes 1 -f image2 -y output
        if (args && args.includes('-vframes')) {
          const outputPath = args[args.length - 1];
          fs.writeFileSync(outputPath, Buffer.from('fake jpeg content'));
          return { status: 0 };
        }
        return { status: 1 };
      }) as any);

      const testPath = path.join(os.tmpdir(), `test_video_ok_${Date.now()}.mp4`);
      fs.writeFileSync(testPath, Buffer.from('fake mp4 content'));

      try {
        const result = extractVideoCover(testPath);
        expect(result.success).toBe(true);
        expect(result.coverPath).toBeTruthy();
        if (result.coverPath) {
          expect(fs.existsSync(result.coverPath)).toBe(true);
          try { fs.unlinkSync(result.coverPath); } catch { /* ignore */ }
        }
      } finally {
        try { fs.unlinkSync(testPath); } catch { /* ignore */ }
      }
    });

    it('should return error when ffmpeg fails to extract frame', () => {
      mockSpawnSync.mockImplementation(((..._args: unknown[]) => {
        const args = _args[1] as string[] | undefined;
        if (args && args[0] === '-version') {
          return { status: 0 };
        }
        return { status: 1, stderr: Buffer.from('Error decoding video') };
      }) as any);

      const testPath = path.join(os.tmpdir(), `test_video_fail_${Date.now()}.mp4`);
      fs.writeFileSync(testPath, Buffer.from('fake mp4 content'));

      try {
        const result = extractVideoCover(testPath);
        expect(result.success).toBe(false);
        expect(result.error).toContain('ffmpeg');
      } finally {
        try { fs.unlinkSync(testPath); } catch { /* ignore */ }
      }
    });
  });

  describe('isFfmpegAvailable', () => {
    it('should return true when ffmpeg --version succeeds', () => {
      mockSpawnSync.mockReturnValue({ status: 0 } as any);

      const result = isFfmpegAvailable();
      expect(result).toBe(true);
      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    });

    it('should return false when ffmpeg --version fails', () => {
      mockSpawnSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const result = isFfmpegAvailable();
      expect(result).toBe(false);
    });

    it('should cache the result and not spawn again', () => {
      mockSpawnSync.mockReturnValue({ status: 0 } as any);

      isFfmpegAvailable();
      isFfmpegAvailable();
      isFfmpegAvailable();

      expect(mockSpawnSync).toHaveBeenCalledTimes(1);
    });
  });
});
