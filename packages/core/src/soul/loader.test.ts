/**
 * Unit tests for SoulLoader
 *
 * Issue #1315: SOUL.md Agent personality/behavior definition system.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SoulLoader, SOUL_MAX_SIZE_BYTES } from './loader.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(),
    readFile: vi.fn(),
  },
  stat: vi.fn(),
  readFile: vi.fn(),
}));

describe('SoulLoader', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolvePath', () => {
    it('should expand ~ to home directory', () => {
      const resolved = SoulLoader.resolvePath('~/.disclaude/SOUL.md');
      expect(resolved).toBe(path.join(os.homedir(), '.disclaude/SOUL.md'));
    });

    it('should not modify absolute paths', () => {
      const resolved = SoulLoader.resolvePath('/etc/so/SOUL.md');
      expect(resolved).toBe('/etc/so/SOUL.md');
    });

    it('should resolve relative paths to absolute', () => {
      const resolved = SoulLoader.resolvePath('config/SOUL.md');
      expect(resolved).toBe(path.resolve('config/SOUL.md'));
    });
  });

  describe('constructor', () => {
    it('should store raw and resolved paths', () => {
      const loader = new SoulLoader('~/SOUL.md');
      expect(loader.getRawPath()).toBe('~/SOUL.md');
      expect(loader.getResolvedPath()).toBe(path.join(os.homedir(), 'SOUL.md'));
    });
  });

  describe('load', () => {
    it('should return null when file does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      vi.mocked(fsPromises.stat).mockRejectedValue(error);

      const loader = new SoulLoader('/nonexistent/SOUL.md');
      const result = await loader.load();

      expect(result).toBeNull();
    });

    it('should load file within size limit', async () => {
      const content = '# SOUL.md\n\nYou are a helpful assistant.';
      const byteLength = Buffer.byteLength(content, 'utf-8');

      vi.mocked(fsPromises.stat).mockResolvedValue({ size: byteLength } as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue(content);

      const loader = new SoulLoader('/tmp/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result && 'content' in result ? result.content : '').toBe(content);
      expect(result && 'content' in result ? result.sizeBytes : 0).toBe(byteLength);
      expect(result && 'content' in result ? result.resolvedPath : '').toBe('/tmp/SOUL.md');
    });

    it('should return too_large error when stat.size exceeds limit', async () => {
      vi.mocked(fsPromises.stat).mockResolvedValue({ size: SOUL_MAX_SIZE_BYTES + 1 } as any);

      const loader = new SoulLoader('/tmp/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result && 'reason' in result ? result.reason : '').toBe('too_large');
      expect(result && 'reason' in result ? result.message : '').toContain('too large');
    });

    it('should return too_large error when byte length exceeds limit (multi-byte chars)', async () => {
      // Create content where stat.size is under limit but actual byte content is over
      // This handles the edge case where stat.size and Buffer.byteLength differ
      const smallStat = 100;
      const largeContent = '中'.repeat(SOUL_MAX_SIZE_BYTES + 1); // Each Chinese char is 3 bytes

      vi.mocked(fsPromises.stat).mockResolvedValue({ size: smallStat } as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue(largeContent);

      const loader = new SoulLoader('/tmp/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result && 'reason' in result ? result.reason : '').toBe('too_large');
    });

    it('should return read_error when file read fails with non-ENOENT error', async () => {
      const error = new Error('Permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      vi.mocked(fsPromises.stat).mockRejectedValue(error);

      const loader = new SoulLoader('/tmp/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result && 'reason' in result ? result.reason : '').toBe('read_error');
      expect(result && 'reason' in result ? result.message : '').toContain('Permission denied');
    });

    it('should handle Unicode content correctly (no false size errors)', async () => {
      // Content with Chinese characters and emoji
      const content = '# SOUL.md\n\n你是专业的代码审查员。🚀 严格检查代码质量。';
      const byteLength = Buffer.byteLength(content, 'utf-8');

      // stat.size matches byte length
      vi.mocked(fsPromises.stat).mockResolvedValue({ size: byteLength } as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue(content);

      const loader = new SoulLoader('/tmp/SOUL.md');
      const result = await loader.load();

      // Should NOT return too_large - this was the bug in PR #1632
      expect(result).not.toBeNull();
      expect(result && 'content' in result ? result.content : '').toBe(content);
      expect(result && 'content' in result ? result.sizeBytes : 0).toBe(byteLength);
    });

    it('should handle empty file', async () => {
      vi.mocked(fsPromises.stat).mockResolvedValue({ size: 0 } as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue('');

      const loader = new SoulLoader('/tmp/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result && 'content' in result ? result.content : '').toBe('');
      expect(result && 'content' in result ? result.sizeBytes : 0).toBe(0);
    });

    it('should handle file at exact size limit', async () => {
      // Create content exactly at the limit
      const content = 'x'.repeat(SOUL_MAX_SIZE_BYTES);
      const byteLength = Buffer.byteLength(content, 'utf-8');

      vi.mocked(fsPromises.stat).mockResolvedValue({ size: byteLength } as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue(content);

      const loader = new SoulLoader('/tmp/SOUL.md');
      const result = await loader.load();

      // Should succeed - exactly at limit is allowed
      expect(result).not.toBeNull();
      if (result && 'content' in result) {
        // Success - SoulLoadResult
        expect(result.sizeBytes).toBe(SOUL_MAX_SIZE_BYTES);
      } else {
        // Should not be an error
        throw new Error('Expected SoulLoadResult but got error or null');
      }
    });

    it('should handle file one byte over limit', async () => {
      const content = 'x'.repeat(SOUL_MAX_SIZE_BYTES + 1);
      const byteLength = Buffer.byteLength(content, 'utf-8');

      vi.mocked(fsPromises.stat).mockResolvedValue({ size: byteLength } as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue(content);

      const loader = new SoulLoader('/tmp/SOUL.md');
      const result = await loader.load();

      expect(result).not.toBeNull();
      expect(result && 'reason' in result ? result.reason : '').toBe('too_large');
    });
  });
});
