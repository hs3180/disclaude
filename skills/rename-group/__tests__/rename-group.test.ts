/**
 * Tests for rename-group script.
 *
 * Tests input validation and control flow without actually calling lark-cli
 * (tests run with network isolation via RENAME_SKIP_LARK=1).
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');

// Helper to run the script with environment variables
async function runScript(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'skills/rename-group/rename-group.ts');
  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath], {
      env: { ...process.env, RENAME_SKIP_LARK: '1', ...env },
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

describe('rename-group script', () => {
  it('should succeed with valid inputs', async () => {
    const result = await runScript({
      RENAME_CHAT_ID: 'oc_test123abc',
      RENAME_GROUP_NAME: 'Test Group Name',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("renamed to 'Test Group Name'");
  });

  it('should succeed with CJK characters in group name', async () => {
    const result = await runScript({
      RENAME_CHAT_ID: 'oc_test123abc',
      RENAME_GROUP_NAME: '需求分析讨论组',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('需求分析讨论组');
  });

  it('should succeed with mixed characters', async () => {
    const result = await runScript({
      RENAME_CHAT_ID: 'oc_abc123xyz',
      RENAME_GROUP_NAME: 'PR #123: Fix auth bug 修复认证问题',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('PR #123: Fix auth bug 修复认证问题');
  });

  it('should fail when RENAME_CHAT_ID is missing', async () => {
    const result = await runScript({
      RENAME_GROUP_NAME: 'Test',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('RENAME_CHAT_ID');
  });

  it('should fail when RENAME_GROUP_NAME is missing', async () => {
    const result = await runScript({
      RENAME_CHAT_ID: 'oc_test123',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('RENAME_GROUP_NAME');
  });

  it('should fail with invalid chat ID format (no oc_ prefix)', async () => {
    const result = await runScript({
      RENAME_CHAT_ID: 'invalid_id',
      RENAME_GROUP_NAME: 'Test',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('oc_xxxxx');
  });

  it('should fail with invalid chat ID format (ou_ prefix = user ID)', async () => {
    const result = await runScript({
      RENAME_CHAT_ID: 'ou_test123',
      RENAME_GROUP_NAME: 'Test',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('oc_xxxxx');
  });

  it('should fail with empty group name', async () => {
    const result = await runScript({
      RENAME_CHAT_ID: 'oc_test123',
      RENAME_GROUP_NAME: '',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('RENAME_GROUP_NAME');
  });

  it('should fail with whitespace-only group name', async () => {
    const result = await runScript({
      RENAME_CHAT_ID: 'oc_test123',
      RENAME_GROUP_NAME: '   ',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('blank');
  });

  it('should truncate long group names to 64 characters', async () => {
    const longName = 'A'.repeat(100);
    const result = await runScript({
      RENAME_CHAT_ID: 'oc_test123',
      RENAME_GROUP_NAME: longName,
    });
    expect(result.code).toBe(0);
    // Should show truncated name (64 'A's)
    const truncated = 'A'.repeat(64);
    expect(result.stdout).toContain(truncated);
  });

  it('should truncate CJK names correctly at character boundaries', async () => {
    const longName = '你'.repeat(100);
    const result = await runScript({
      RENAME_CHAT_ID: 'oc_test123',
      RENAME_GROUP_NAME: longName,
    });
    expect(result.code).toBe(0);
    const truncated = '你'.repeat(64);
    expect(result.stdout).toContain(truncated);
  });

  it('should accept group name with common symbols', async () => {
    const result = await runScript({
      RENAME_CHAT_ID: 'oc_test123',
      RENAME_GROUP_NAME: 'Project-Alpha_v2.0 (Review #3)',
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Project-Alpha_v2.0 (Review #3)');
  });
});
