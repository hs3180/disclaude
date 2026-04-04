/**
 * SoulLoader unit tests.
 *
 * Issue #1315: Tests for the SOUL.md loading utility class.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import type { Stats } from 'node:fs';
import { SoulLoader } from './loader.js';

describe('SoulLoader', () => {
  describe('resolvePath', () => {
    it('should expand tilde (~) to HOME environment variable', () => {
      const originalHome = process.env.HOME;
      process.env.HOME = '/home/testuser';

      try {
        const resolved = SoulLoader.resolvePath('~/disclaude/SOUL.md');
        expect(resolved).toBe('/home/testuser/disclaude/SOUL.md');
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it('should expand tilde using USERPROFILE when HOME is not set', () => {
      const originalHome = process.env.HOME;
      const originalUserprofile = process.env.USERPROFILE;
      process.env.HOME = '';
      process.env.USERPROFILE = '/Users/testuser';

      try {
        const resolved = SoulLoader.resolvePath('~/SOUL.md');
        expect(resolved).toBe('/Users/testuser/SOUL.md');
      } finally {
        process.env.HOME = originalHome;
        process.env.USERPROFILE = originalUserprofile;
      }
    });

    it('should return absolute paths unchanged', () => {
      const resolved = SoulLoader.resolvePath('/etc/disclaude/SOUL.md');
      expect(resolved).toBe('/etc/disclaude/SOUL.md');
    });

    it('should return non-tilde paths unchanged', () => {
      const resolved = SoulLoader.resolvePath('./local/SOUL.md');
      expect(resolved).toBe('./local/SOUL.md');
    });
  });

  describe('constructor', () => {
    it('should resolve tilde paths at construction time', () => {
      const originalHome = process.env.HOME;
      process.env.HOME = '/home/testuser';

      try {
        const loader = new SoulLoader('~/SOUL.md');
        expect(loader.getResolvedPath()).toBe('/home/testuser/SOUL.md');
      } finally {
        process.env.HOME = originalHome;
      }
    });

    it('should store absolute paths as-is', () => {
      const loader = new SoulLoader('/absolute/path/SOUL.md');
      expect(loader.getResolvedPath()).toBe('/absolute/path/SOUL.md');
    });
  });

  describe('load', () => {
    beforeEach(() => {
      vi.mock('fs', async () => {
        const actual = await vi.importActual<typeof import('fs')>('fs');
        return {
          ...actual,
          promises: {
            ...actual.promises,
            stat: vi.fn(),
            readFile: vi.fn(),
          },
        };
      });
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('should return null when file does not exist (ENOENT)', async () => {
      vi.mocked(fs.stat).mockRejectedValue({ code: 'ENOENT' } as NodeJS.ErrnoException);

      const loader = new SoulLoader('/nonexistent/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return null when file exceeds maximum size', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ size: 64 * 1024 } as Stats);

      const loader = new SoulLoader('/too-large/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
      expect(fs.readFile).not.toHaveBeenCalled();
    });

    it('should return null when file is empty', async () => {
      vi.mocked(fs.stat).mockResolvedValue({ size: 0 } as Stats);
      vi.mocked(fs.readFile).mockResolvedValue('   \n  ');

      const loader = new SoulLoader('/empty/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should return SoulLoadResult when file is valid', async () => {
      const content = '# SOUL.md\n\nYou are a helpful assistant.';
      const byteSize = Buffer.byteLength(content, 'utf-8');
      vi.mocked(fs.stat).mockResolvedValue({ size: byteSize } as Stats);
      vi.mocked(fs.readFile).mockResolvedValue(content);

      const loader = new SoulLoader('/valid/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result?.content).toBe(content);
      expect(result?.resolvedPath).toBe('/valid/SOUL.md');
      expect(result?.sizeBytes).toBe(byteSize);
    });

    it('should return null on unexpected errors', async () => {
      vi.mocked(fs.stat).mockRejectedValue(new Error('Permission denied'));

      const loader = new SoulLoader('/error/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should handle Unicode content correctly (size in bytes, not chars)', async () => {
      // Chinese content: 4 chars but more bytes in UTF-8
      const content = '你好世界';
      const byteSize = Buffer.byteLength(content, 'utf-8'); // 12 bytes for 4 Chinese chars

      vi.mocked(fs.stat).mockResolvedValue({ size: byteSize } as Stats);
      vi.mocked(fs.readFile).mockResolvedValue(content);

      const loader = new SoulLoader('/unicode/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result?.content).toBe(content);
      expect(result?.sizeBytes).toBe(byteSize);
      expect(result?.content.length).toBe(4); // 4 characters
    });

    it('should handle emoji content correctly', async () => {
      const content = '🤖 Agent personality 🎯';
      const byteSize = Buffer.byteLength(content, 'utf-8');

      vi.mocked(fs.stat).mockResolvedValue({ size: byteSize } as Stats);
      vi.mocked(fs.readFile).mockResolvedValue(content);

      const loader = new SoulLoader('/emoji/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result?.content).toBe(content);
      // sizeBytes should match file stat (bytes), NOT content.length (characters)
      expect(result?.sizeBytes).toBe(byteSize);
    });

    it('should allow files exactly at the maximum size', async () => {
      const maxBytes = 32 * 1024;
      const content = 'x'.repeat(maxBytes);

      vi.mocked(fs.stat).mockResolvedValue({ size: maxBytes } as Stats);
      vi.mocked(fs.readFile).mockResolvedValue(content);

      const loader = new SoulLoader('/max-size/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result?.sizeBytes).toBe(maxBytes);
    });

    it('should reject files exceeding maximum size by 1 byte', async () => {
      const tooLarge = 32 * 1024 + 1;

      vi.mocked(fs.stat).mockResolvedValue({ size: tooLarge } as Stats);

      const loader = new SoulLoader('/too-large/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });
  });
});
