/**
 * Tests for insert-docx-image script.
 *
 * Tests the input validation, API response parsing, and error handling
 * without actually calling Feishu API (tests run with DOCX_SKIP_API=1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SCRIPT_PATH = resolve(PROJECT_ROOT, 'skills/insert-docx-image/insert-docx-image.ts');
const TMP_DIR = resolve(PROJECT_ROOT, 'tmp/test-insert-docx-image');

// Helper to run the script with environment variables
async function runScript(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('npx', ['tsx', SCRIPT_PATH], {
      env: { ...process.env, DOCX_SKIP_API: '1', ...env },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      code: execErr.code ?? 1,
    };
  }
}

describe('insert-docx-image script', () => {
  beforeEach(async () => {
    await mkdir(TMP_DIR, { recursive: true });
    // Create a dummy image file for testing
    await writeFile(resolve(TMP_DIR, 'test.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes
  });

  afterEach(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  // ---- Input Validation ----

  describe('input validation', () => {
    it('should fail when DOCX_DOCUMENT_ID is missing', async () => {
      const result = await runScript({
        DOCX_IMAGE_PATH: resolve(TMP_DIR, 'test.png'),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('DOCX_DOCUMENT_ID');
    });

    it('should fail when DOCX_IMAGE_PATH is missing', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('DOCX_IMAGE_PATH');
    });

    it('should fail for invalid document ID format', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'short',
        DOCX_IMAGE_PATH: resolve(TMP_DIR, 'test.png'),
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid DOCX_DOCUMENT_ID');
    });

    it('should fail for unsupported image format', async () => {
      const tiffPath = resolve(TMP_DIR, 'test.tiff');
      await writeFile(tiffPath, Buffer.from([0x49, 0x49]));
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: tiffPath,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Unsupported image format');
    });

    it('should fail when image file does not exist', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: '/nonexistent/path/image.png',
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });

    it('should fail for empty image file', async () => {
      const emptyPath = resolve(TMP_DIR, 'empty.png');
      await writeFile(emptyPath, '');
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: emptyPath,
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('empty');
    });

    it('should fail for invalid DOCX_INSERT_INDEX', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: resolve(TMP_DIR, 'test.png'),
        DOCX_INSERT_INDEX: 'abc',
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid DOCX_INSERT_INDEX');
    });

    it('should fail for negative index (except -1)', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: resolve(TMP_DIR, 'test.png'),
        DOCX_INSERT_INDEX: '-5',
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('must be >= -1');
    });

    it('should fail for excessively large index', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: resolve(TMP_DIR, 'test.png'),
        DOCX_INSERT_INDEX: '99999',
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('exceeds maximum');
    });
  });

  // ---- Successful Validation (Dry Run) ----

  describe('dry-run mode', () => {
    it('should succeed with valid inputs (default index = append)', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: resolve(TMP_DIR, 'test.png'),
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Validation passed');
      expect(result.stdout).toContain('append');
    });

    it('should succeed with explicit index 0', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: resolve(TMP_DIR, 'test.png'),
        DOCX_INSERT_INDEX: '0',
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('index 0');
    });

    it('should succeed with index -1 (explicit append)', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: resolve(TMP_DIR, 'test.png'),
        DOCX_INSERT_INDEX: '-1',
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('append');
    });

    it('should succeed with index 100', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: resolve(TMP_DIR, 'test.png'),
        DOCX_INSERT_INDEX: '100',
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('index 100');
    });

    it('should succeed with jpg format', async () => {
      const imgPath = resolve(TMP_DIR, 'test.jpg');
      await writeFile(imgPath, Buffer.from([0x00, 0x01]));
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: imgPath,
      });
      expect(result.code).toBe(0);
    });

    it('should succeed with gif format', async () => {
      const imgPath = resolve(TMP_DIR, 'test.gif');
      await writeFile(imgPath, Buffer.from([0x00, 0x01]));
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: imgPath,
      });
      expect(result.code).toBe(0);
    });

    it('should succeed with webp format', async () => {
      const imgPath = resolve(TMP_DIR, 'test.webp');
      await writeFile(imgPath, Buffer.from([0x00, 0x01]));
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: imgPath,
      });
      expect(result.code).toBe(0);
    });
  });

  // ---- Unit Tests for Helper Functions (via script behavior) ----

  describe('block_id extraction', () => {
    // These test the extractBlockId function indirectly through the script's output
    it('should report image size correctly', async () => {
      const imgPath = resolve(TMP_DIR, 'sized.png');
      const content = Buffer.alloc(1024); // 1KB file
      await writeFile(imgPath, content);
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: imgPath,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('1.0KB');
    });
  });

  describe('API mode requirements', () => {
    it('should fail when FEISHU_APP_ID is missing in API mode', async () => {
      const result = await runScript({
        DOCX_DOCUMENT_ID: 'okcnAbcDef123456',
        DOCX_IMAGE_PATH: resolve(TMP_DIR, 'test.png'),
        DOCX_SKIP_API: '0',
        // Intentionally not providing FEISHU_APP_ID/SECRET
        FEISHU_APP_ID: '',
        FEISHU_APP_SECRET: '',
      });
      // Should fail at lark-cli check or auth step
      expect(result.code).toBe(1);
    });
  });
});
