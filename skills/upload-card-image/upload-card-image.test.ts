/**
 * Tests for upload-card-image skill.
 *
 * Verifies input validation and dry-run behavior.
 * Actual lark-cli API calls are mocked/skipped via UPLOAD_SKIP_LARK=1.
 *
 * Issue #2951: upload-card-image skill for Feishu card image embedding.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = path.resolve(__dirname, 'upload-card-image.ts');

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'upload-card-image-test-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/**
 * Run the upload-card-image script with the given environment variables.
 * Returns stdout, stderr, and exit code.
 */
async function runScript(
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', SCRIPT_PATH], {
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.code ?? 1,
    };
  }
}

describe('upload-card-image', () => {
  describe('validation', () => {
    it('should fail when UPLOAD_IMAGE_PATH is not set', async () => {
      const result = await runScript({ UPLOAD_SKIP_LARK: '1' });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('UPLOAD_IMAGE_PATH');
    });

    it('should fail when image file does not exist', async () => {
      const result = await runScript({
        UPLOAD_IMAGE_PATH: '/nonexistent/image.png',
        UPLOAD_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('should fail when file has unsupported extension', async () => {
      const badFile = path.join(tempDir, 'image.txt');
      await fs.writeFile(badFile, 'not an image');
      const result = await runScript({
        UPLOAD_IMAGE_PATH: badFile,
        UPLOAD_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Unsupported image format');
      expect(result.stderr).toContain('.txt');
    });

    it('should fail when image file is empty', async () => {
      const emptyFile = path.join(tempDir, 'empty.png');
      await fs.writeFile(emptyFile, '');
      const result = await runScript({
        UPLOAD_IMAGE_PATH: emptyFile,
        UPLOAD_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('empty');
    });

    it('should fail when image exceeds 10 MB', async () => {
      // Create a sparse file that reports > 10 MB but doesn't use disk space
      const bigFile = path.join(tempDir, 'big.png');
      const fd = await fs.open(bigFile, 'w');
      await fd.truncate(11 * 1024 * 1024); // 11 MB
      await fd.close();
      const result = await runScript({
        UPLOAD_IMAGE_PATH: bigFile,
        UPLOAD_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('too large');
    });

    it('should accept all supported image formats', { timeout: 60_000 }, async () => {
      // Each extension spawns a new process (~3s each), so allow extra time
      const extensions = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.ico'];
      for (const ext of extensions) {
        const file = path.join(tempDir, `test${ext}`);
        await fs.writeFile(file, Buffer.alloc(100)); // 100 bytes of data
        const result = await runScript({
          UPLOAD_IMAGE_PATH: file,
          UPLOAD_SKIP_LARK: '1',
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('OK: image_key=');
      }
    });
  });

  describe('dry-run mode', () => {
    it('should output image_key in dry-run mode', async () => {
      const imageFile = path.join(tempDir, 'chart.png');
      await fs.writeFile(imageFile, Buffer.alloc(1024)); // 1 KB

      const result = await runScript({
        UPLOAD_IMAGE_PATH: imageFile,
        UPLOAD_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('OK: image_key=');
      expect(result.stdout).toContain('dry_run_image_key_placeholder');
    });

    it('should log image info in dry-run mode', async () => {
      const imageFile = path.join(tempDir, 'diagram.jpg');
      await fs.writeFile(imageFile, Buffer.alloc(2048)); // 2 KB

      const result = await runScript({
        UPLOAD_IMAGE_PATH: imageFile,
        UPLOAD_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('diagram.jpg');
      expect(result.stdout).toContain('2.0 KB');
    });
  });

  describe('output format', () => {
    it('should produce parseable image_key output', async () => {
      const imageFile = path.join(tempDir, 'test.png');
      await fs.writeFile(imageFile, Buffer.alloc(512));

      const result = await runScript({
        UPLOAD_IMAGE_PATH: imageFile,
        UPLOAD_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      const match = result.stdout.match(/OK: image_key=(.+)/);
      expect(match).not.toBeNull();
      expect(match![1].trim()).toBe('dry_run_image_key_placeholder');
    });
  });
});
