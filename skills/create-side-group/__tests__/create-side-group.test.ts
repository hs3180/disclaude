/**
 * Unit tests for create-side-group skill.
 *
 * Tests run in dry-run mode (SIDE_GROUP_SKIP_LARK=1) to avoid
 * requiring lark-cli or network access.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rm } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

// Helper to run the script with environment variables
async function runScript(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'skills/create-side-group/create-side-group.ts');
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

const TEST_CHAT_PREFIX = 'side-group-oc_test_dry_run';

async function cleanupTestFiles() {
  try {
    await rm(resolve(CHAT_DIR, `${TEST_CHAT_PREFIX}.json`), { force: true });
    await rm(resolve(CHAT_DIR, `${TEST_CHAT_PREFIX}.json.lock`), { force: true });
  } catch {
    // Ignore
  }
}

describe('create-side-group', () => {
  beforeEach(async () => {
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('parameter validation', () => {
    it('should reject missing SIDE_GROUP_NAME', async () => {
      const result = await runScript({
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SIDE_GROUP_NAME');
    });

    it('should reject blank SIDE_GROUP_NAME', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: '   ',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('blank');
    });

    it('should reject SIDE_GROUP_NAME with control characters', async () => {
      // Use a vertical tab (\x0B) instead of null byte, since Node.js
      // cannot pass null bytes through environment variables
      const result = await runScript({
        SIDE_GROUP_NAME: 'Hello\x0BWorld',
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

    it('should reject invalid JSON in SIDE_GROUP_MEMBERS', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: 'not-json',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('valid JSON');
    });

    it('should reject empty members array', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '[]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('non-empty');
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

    it('should reject invalid SIDE_GROUP_PARENT_CHAT_ID', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_PARENT_CHAT_ID: 'invalid_id',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SIDE_GROUP_PARENT_CHAT_ID');
    });

    it('should reject negative SIDE_GROUP_EXPIRES_HOURS', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_EXPIRES_HOURS: '-1',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('SIDE_GROUP_EXPIRES_HOURS');
    });
  });

  describe('successful group creation', () => {
    it('should create a group in dry-run mode', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK: Side group created');
      expect(result.stdout).toContain('CHAT_ID: oc_test_dry_run');
    });

    it('should create a group with multiple members', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Multi-member Group',
        SIDE_GROUP_MEMBERS: '["ou_user1", "ou_user2", "ou_user3"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK: Side group created');
      expect(result.stdout).toContain('3 member(s)');
    });

    it('should truncate long group names', async () => {
      const longName = 'A'.repeat(100);
      const result = await runScript({
        SIDE_GROUP_NAME: longName,
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('truncated from 100 chars');
    });

    it('should handle CJK characters in group name', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'LiteLLM 配置方案 — 2026',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('LiteLLM');
    });

    it('should accept valid parent chat ID', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_PARENT_CHAT_ID: 'oc_parent123',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');
    });

    it('should accept custom expires hours', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_EXPIRES_HOURS: '48',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');
    });

    it('should accept zero expires hours (no lifecycle management)', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_EXPIRES_HOURS: '0',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');
      // Should NOT mention temp chat registration
      expect(result.stdout).not.toContain('Registered temp chat');
    });
  });

  describe('edge cases', () => {
    it('should handle group name at exactly 64 characters', async () => {
      const exactName = 'A'.repeat(64);
      const result = await runScript({
        SIDE_GROUP_NAME: exactName,
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      // Should NOT show truncation message
      expect(result.stdout).not.toContain('truncated');
    });

    it('should handle group name at 65 characters (just over limit)', async () => {
      const longName = 'A'.repeat(65);
      const result = await runScript({
        SIDE_GROUP_NAME: longName,
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('truncated from 65 chars');
    });

    it('should handle CJK truncation at character boundaries', async () => {
      // CJK characters should not be split mid-character
      const cjkName = '你好世界'.repeat(20); // 80 chars
      const result = await runScript({
        SIDE_GROUP_NAME: cjkName,
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('truncated');
    });

    it('should work without optional parameters', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Minimal Group',
        SIDE_GROUP_MEMBERS: '["ou_test123"]',
        SIDE_GROUP_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');
      expect(result.stdout).toContain('CHAT_ID');
    });
  });
});
