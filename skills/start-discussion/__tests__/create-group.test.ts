/**
 * Tests for skills/start-discussion/create-group.ts
 *
 * Tests input validation and dry-run mode. Actual lark-cli calls are skipped
 * via DISCUSSION_SKIP_LARK=1.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = 'skills/start-discussion/create-group.ts';

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

async function runScript(env: Record<string, string>): Promise<ExecResult> {
  try {
    const result = await execFileAsync('npx', ['tsx', SCRIPT_PATH], {
      timeout: 30_000,
      env: { ...process.env, ...env },
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number | null };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      exitCode: execErr.code ?? 1,
    };
  }
}

describe('start-discussion create-group', () => {
  describe('validation', () => {
    it('should fail when DISCUSSION_NAME is missing', async () => {
      const result = await runScript({
        DISCUSSION_MEMBERS: 'ou_test123',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('DISCUSSION_NAME');
    });

    it('should fail when DISCUSSION_NAME is empty', async () => {
      const result = await runScript({
        DISCUSSION_NAME: '',
        DISCUSSION_MEMBERS: 'ou_test123',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('DISCUSSION_NAME');
    });

    it('should fail when DISCUSSION_NAME is whitespace only', async () => {
      const result = await runScript({
        DISCUSSION_NAME: '   ',
        DISCUSSION_MEMBERS: 'ou_test123',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('blank');
    });

    it('should fail when DISCUSSION_MEMBERS is missing', async () => {
      const result = await runScript({
        DISCUSSION_NAME: 'Test Discussion',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('DISCUSSION_MEMBERS');
    });

    it('should fail when DISCUSSION_MEMBERS has invalid format', async () => {
      const result = await runScript({
        DISCUSSION_NAME: 'Test Discussion',
        DISCUSSION_MEMBERS: 'invalid_id',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid member ID');
    });

    it('should fail when DISCUSSION_MEMBERS has mixed valid/invalid IDs', async () => {
      const result = await runScript({
        DISCUSSION_NAME: 'Test Discussion',
        DISCUSSION_MEMBERS: 'ou_valid123,bad_id',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Invalid member ID');
    });

    it('should fail when DISCUSSION_MEMBERS contains only separators', async () => {
      const result = await runScript({
        DISCUSSION_NAME: 'Test Discussion',
        DISCUSSION_MEMBERS: ',,,',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('at least one');
    });
  });

  describe('dry-run mode', () => {
    it('should succeed in dry-run mode with valid inputs', async () => {
      const result = await runScript({
        DISCUSSION_NAME: 'API Design Discussion',
        DISCUSSION_MEMBERS: 'ou_developer,ou_architect',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('OK:');
      expect(result.stdout).toContain('chatId');
      expect(result.stdout).toContain('API Design Discussion');
    });

    it('should succeed with a single member', async () => {
      const result = await runScript({
        DISCUSSION_NAME: 'One-on-One Discussion',
        DISCUSSION_MEMBERS: 'ou_singleuser123',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('OK:');
    });

    it('should succeed with CJK characters in group name', async () => {
      const result = await runScript({
        DISCUSSION_NAME: '接口设计讨论：认证方案选型',
        DISCUSSION_MEMBERS: 'ou_dev1,ou_dev2',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('接口设计讨论');
    });

    it('should handle long group names', async () => {
      const longName = 'A'.repeat(100);
      const result = await runScript({
        DISCUSSION_NAME: longName,
        DISCUSSION_MEMBERS: 'ou_test',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(0);
      // Should be truncated to 64 chars
      expect(result.stdout).toContain('A'.repeat(64));
      expect(result.stdout).not.toContain('A'.repeat(65));
    });

    it('should output valid JSON in OK line', async () => {
      const result = await runScript({
        DISCUSSION_NAME: 'JSON Output Test',
        DISCUSSION_MEMBERS: 'ou_user1,ou_user2,ou_user3',
        DISCUSSION_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(0);
      const okLine = result.stdout.split('\n').find((l) => l.startsWith('OK:'));
      expect(okLine).toBeDefined();
      const jsonStr = okLine!.replace('OK: ', '');
      const parsed = JSON.parse(jsonStr);
      expect(parsed).toHaveProperty('chatId');
      expect(parsed).toHaveProperty('name');
    });
  });
});
