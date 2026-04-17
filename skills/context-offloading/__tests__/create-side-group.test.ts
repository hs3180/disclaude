/**
 * Tests for context-offloading/create-side-group.ts
 *
 * All tests use SIDE_GROUP_SKIP_LARK=1 to avoid requiring lark-cli.
 * Validates input validation, error handling, and dry-run output.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = 'skills/context-offloading/create-side-group.ts';

/** Run the script with given env vars and SIDE_GROUP_SKIP_LARK=1 */
async function runScript(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', SCRIPT_PATH], {
      timeout: 30_000,
      env: { ...process.env, SIDE_GROUP_SKIP_LARK: '1', ...env },
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: (execErr.stdout ?? '').trim(),
      stderr: (execErr.stderr ?? '').trim(),
      exitCode: execErr.code ?? 1,
    };
  }
}

describe('create-side-group', () => {
  describe('validation', () => {
    it('should fail when SIDE_GROUP_NAME is missing', async () => {
      const result = await runScript({
        SIDE_GROUP_MEMBERS: '["ou_user123"]',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('SIDE_GROUP_NAME');
    });

    it('should fail when SIDE_GROUP_MEMBERS is missing', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('SIDE_GROUP_MEMBERS');
    });

    it('should fail when SIDE_GROUP_NAME is blank (whitespace only)', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: '   ',
        SIDE_GROUP_MEMBERS: '["ou_user123"]',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('cannot be blank');
    });

    it('should fail when SIDE_GROUP_MEMBERS is not valid JSON', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: 'not-json',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('valid JSON');
    });

    it('should fail when SIDE_GROUP_MEMBERS is an empty array', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '[]',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('non-empty');
    });

    it('should fail when SIDE_GROUP_MEMBERS contains invalid open IDs', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["invalid_id"]',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should fail when SIDE_GROUP_PARENT_CHAT_ID has invalid format', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_user123"]',
        SIDE_GROUP_PARENT_CHAT_ID: 'invalid_chat_id',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('SIDE_GROUP_PARENT_CHAT_ID');
    });

    it('should fail when SIDE_GROUP_NAME contains control characters', async () => {
      // Use a newline character which is a control char but passes through env vars
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test\nGroup',
        SIDE_GROUP_MEMBERS: '["ou_user123"]',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('control characters');
    });
  });

  describe('dry-run success', () => {
    it('should output OK with a chat ID in dry-run mode', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_user123"]',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^OK: oc_dryrun_\d+$/);
    });

    it('should accept valid parent chat ID', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_user123"]',
        SIDE_GROUP_PARENT_CHAT_ID: 'oc_parent123',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^OK: oc_dryrun_\d+$/);
      expect(result.stderr).toContain('Parent chat: oc_parent123');
    });

    it('should accept multiple members', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'Test Group',
        SIDE_GROUP_MEMBERS: '["ou_user123","ou_user456","ou_user789"]',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('3 member(s)');
    });

    it('should log the group name and member count on stderr', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: 'My Test Group',
        SIDE_GROUP_MEMBERS: '["ou_user123"]',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("Creating side group 'My Test Group'");
      expect(result.stderr).toContain('1 member(s)');
    });
  });

  describe('name truncation', () => {
    it('should handle long group names gracefully', async () => {
      const longName = 'A'.repeat(100);
      const result = await runScript({
        SIDE_GROUP_NAME: longName,
        SIDE_GROUP_MEMBERS: '["ou_user123"]',
      });
      expect(result.exitCode).toBe(0);
      // The logged name should be truncated to 64 chars
      expect(result.stderr).toContain('A'.repeat(64));
      expect(result.stderr).not.toContain('A'.repeat(65));
    });

    it('should handle CJK characters in group names', async () => {
      const result = await runScript({
        SIDE_GROUP_NAME: '测试群组 🎉 Test Group',
        SIDE_GROUP_MEMBERS: '["ou_user123"]',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('测试群组');
    });
  });
});
