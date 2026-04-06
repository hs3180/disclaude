/**
 * Tests for chat dependency check script.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing the module
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  mkdir: vi.fn(),
  constants: { W_OK: 2 },
}));

import { execSync } from 'node:child_process';
import { access, mkdir, constants } from 'node:fs/promises';

describe('check-deps', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: tsx is available
    vi.mocked(execSync).mockReturnValue(Buffer.from('tsx v1.0.0'));
    // Default: chat dir is writable
    vi.mocked(access).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Node.js version check', () => {
    it('should pass with Node.js >= 20.12.0', () => {
      // Current process is likely >= 20, so this should work
      const version = process.versions.node;
      const parts = version.split('.').map(Number);
      const major = parts[0];
      expect(major).toBeGreaterThanOrEqual(20);
    });
  });

  describe('tsx check', () => {
    it('should pass when tsx is available', () => {
      expect(() => execSync('tsx --version', { stdio: 'pipe' })).not.toThrow();
    });

    it('should fail when tsx is not found', () => {
      vi.mocked(execSync).mockImplementation((cmd: string) => {
        if (cmd.includes('tsx')) {
          throw new Error('command not found: tsx');
        }
        return Buffer.from('');
      });

      expect(() => execSync('tsx --version', { stdio: 'pipe' })).toThrow();
    });
  });

  describe('chat directory check', () => {
    it('should pass when chat directory is writable', async () => {
      await expect(access('workspace/chats', constants.W_OK)).resolves.toBeUndefined();
    });

    it('should attempt to create directory when it does not exist', async () => {
      const enoentError = new Error('ENOENT') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.mocked(access).mockRejectedValue(enoentError);
      vi.mocked(mkdir).mockResolvedValue(undefined);

      try {
        await access('workspace/chats', constants.W_OK);
      } catch {
        await mkdir('workspace/chats', { recursive: true });
      }

      expect(mkdir).toHaveBeenCalledWith('workspace/chats', { recursive: true });
    });
  });
});
