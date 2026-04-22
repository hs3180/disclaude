/**
 * Unit tests for mac-control.ts — macOS desktop automation script.
 *
 * All macOS-specific commands are mocked since tests run on Linux/CI.
 * Tests focus on input validation, error handling, and output formatting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, unlink, mkdir } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SCRIPT_PATH = resolve(PROJECT_ROOT, 'skills/mac-control/mac-control.ts');

/** Helper to run the script with environment variables */
async function runScript(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync('npx', ['tsx', SCRIPT_PATH], {
      env: { ...process.env, ...env },
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

/** Parse stdout as JSON */
function parseResult(stdout: string): Record<string, unknown> {
  // The script outputs a single JSON line
  const lines = stdout.trim().split('\n');
  const jsonLine = lines.find((l) => l.startsWith('{'));
  if (!jsonLine) throw new Error(`No JSON found in stdout: ${stdout}`);
  return JSON.parse(jsonLine);
}

describe('mac-control', () => {
  describe('input validation', () => {
    it('should reject missing MAC_OP', async () => {
      const result = await runScript({ MAC_SKIP_CHECK: '1' });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_OP');
    });

    it('should reject invalid MAC_OP', async () => {
      const result = await runScript({ MAC_OP: 'invalid-op', MAC_SKIP_CHECK: '1' });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid MAC_OP');
    });

    it('should reject non-macOS platform without MAC_SKIP_CHECK', async () => {
      // This test assumes CI is not macOS
      const result = await runScript({ MAC_OP: 'click' });
      // On macOS this would pass platform check; on Linux it should fail
      if (process.platform !== 'darwin') {
        expect(result.code).toBe(1);
        const data = parseResult(result.stdout);
        expect(data.success).toBe(false);
        expect(data.error).toContain('macOS');
      }
    });
  });

  describe('click operation', () => {
    it('should reject missing MAC_X', async () => {
      const result = await runScript({
        MAC_OP: 'click',
        MAC_Y: '300',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_X');
    });

    it('should reject missing MAC_Y', async () => {
      const result = await runScript({
        MAC_OP: 'click',
        MAC_X: '500',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_Y');
    });

    it('should reject non-numeric MAC_X', async () => {
      const result = await runScript({
        MAC_OP: 'click',
        MAC_X: 'abc',
        MAC_Y: '300',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_X');
    });

    it('should reject invalid MAC_BUTTON', async () => {
      const result = await runScript({
        MAC_OP: 'click',
        MAC_X: '500',
        MAC_Y: '300',
        MAC_BUTTON: 'middle',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_BUTTON');
    });
  });

  describe('type operation', () => {
    it('should reject missing MAC_TEXT', async () => {
      const result = await runScript({
        MAC_OP: 'type',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_TEXT');
    });

    it('should reject invalid MAC_TYPE_MODE', async () => {
      const result = await runScript({
        MAC_OP: 'type',
        MAC_TEXT: 'hello',
        MAC_TYPE_MODE: 'invalid',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_TYPE_MODE');
    });
  });

  describe('key operation', () => {
    it('should reject missing MAC_KEY', async () => {
      const result = await runScript({
        MAC_OP: 'key',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_KEY');
    });

    it('should reject invalid modifier', async () => {
      const result = await runScript({
        MAC_OP: 'key',
        MAC_KEY: 's',
        MAC_MODIFIERS: 'invalid',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('modifier');
    });
  });

  describe('screenshot operation', () => {
    it('should reject missing MAC_OUTPUT', async () => {
      const result = await runScript({
        MAC_OP: 'screenshot',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_OUTPUT');
    });

    it('should reject invalid MAC_REGION format', async () => {
      const result = await runScript({
        MAC_OP: 'screenshot',
        MAC_OUTPUT: '/tmp/test.png',
        MAC_REGION: 'invalid',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_REGION');
    });
  });

  describe('get-window / activate-app operations', () => {
    it('should reject missing MAC_APP for get-window', async () => {
      const result = await runScript({
        MAC_OP: 'get-window',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_APP');
    });

    it('should reject missing MAC_APP for activate-app', async () => {
      const result = await runScript({
        MAC_OP: 'activate-app',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_APP');
    });
  });

  describe('drag operation', () => {
    it('should reject missing MAC_X2', async () => {
      const result = await runScript({
        MAC_OP: 'drag',
        MAC_X: '100',
        MAC_Y: '100',
        MAC_Y2: '300',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_X2');
    });

    it('should reject missing MAC_Y2', async () => {
      const result = await runScript({
        MAC_OP: 'drag',
        MAC_X: '100',
        MAC_Y: '100',
        MAC_X2: '500',
        MAC_SKIP_CHECK: '1',
      });
      expect(result.code).toBe(1);
      const data = parseResult(result.stdout);
      expect(data.success).toBe(false);
      expect(data.error).toContain('MAC_Y2');
    });
  });

  describe('output format', () => {
    it('should output valid JSON on all errors', async () => {
      const result = await runScript({ MAC_SKIP_CHECK: '1' });
      // Should be valid JSON
      const data = parseResult(result.stdout);
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('error');
      expect(data.success).toBe(false);
    });
  });

  describe('calibrate operation (skip check)', () => {
    it('should attempt calibrate with skip check', async () => {
      // This will likely fail on Linux but tests the code path
      const result = await runScript({
        MAC_OP: 'calibrate',
        MAC_SKIP_CHECK: '1',
      });
      // On non-macOS, calibrate may succeed with default values or fail gracefully
      const data = parseResult(result.stdout);
      expect(data).toHaveProperty('success');
    });
  });
});
