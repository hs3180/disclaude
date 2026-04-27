/**
 * Tests for context-offload/create-side-group script.
 *
 * Tests use SIDE_GROUP_SKIP_LARK=1 to skip lark-cli calls,
 * validating input handling and output format without Feishu API access.
 */

import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');

async function runScript(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'skills/context-offload/create-side-group.ts');
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath], {
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

describe('create-side-group', () => {
  describe('input validation', () => {
    it('should reject missing SIDE_GROUP_NAME', async () => {
      const result = await runScript({
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SIDE_GROUP_NAME');
    });

    it('should reject empty SIDE_GROUP_NAME', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: '',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SIDE_GROUP_NAME');
    });

    it('should reject blank SIDE_GROUP_NAME (whitespace only)', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: '   ',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('cannot be blank');
    });

    it('should reject SIDE_GROUP_NAME with control characters', async () => {
      // Use \x01 (SOH) instead of \x00 — null bytes cannot pass through env vars
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test\x01Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('control characters');
    });

    it('should reject missing SIDE_GROUP_MEMBERS', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SIDE_GROUP_MEMBERS');
    });

    it('should reject invalid JSON for SIDE_GROUP_MEMBERS', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: 'not json',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('valid JSON');
    });

    it('should reject non-array SIDE_GROUP_MEMBERS', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '"ou_test123"',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('non-empty JSON array');
    });

    it('should reject empty SIDE_GROUP_MEMBERS array', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '[]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('non-empty JSON array');
    });

    it('should reject invalid member ID format', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["invalid_id"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should reject too long SIDE_GROUP_DESCRIPTION', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_DESCRIPTION: 'x'.repeat(257),
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('too long');
    });
  });

  describe('dry-run mode (SKIP_LARK)', () => {
    it('should succeed in dry-run mode with valid inputs', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Side Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK:');
      expect(result.stdout).toContain('oc_dryrun_side_group');
    });

    it('should succeed with multiple members', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Multi-member Group',
        SIDE_GROUP_MEMBERS: '["ou_test123", "ou_test456", "ou_test789"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK:');
    });

    it('should succeed with CJK characters in name', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: '中文群聊名称测试',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK:');
    });

    it('should succeed with description', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_DESCRIPTION: 'This is a test description',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK:');
    });

    it('should log correct info with group name and member count', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_test123", "ou_test456"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('INFO:');
      expect(result.stdout).toContain('2 member(s)');
    });
  });

  describe('output format', () => {
    it('should output OK: prefix with chat ID on success', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/OK:\s+oc_/);
    });

    it('should output ERROR: prefix on failure', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test',
        SIDE_GROUP_MEMBERS: '["bad_member"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ERROR:');
    });
  });
});
