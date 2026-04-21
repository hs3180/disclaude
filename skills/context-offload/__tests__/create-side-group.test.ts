/**
 * Tests for skills/context-offload/create-side-group.ts
 *
 * Tests input validation, lark-cli interaction, and output formatting.
 *
 * Issue #2351: Context Offloading - Auto-create side group for long-form content delivery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The script to test
const SCRIPT_PATH = 'skills/context-offload/create-side-group.ts';

/**
 * Run the script with given environment variables and return parsed JSON output.
 * Uses OFFLOAD_SKIP_LARK=1 for dry-run mode (no actual lark-cli calls).
 */
async function runScript(
  env: Record<string, string>,
  skipLark = true,
): Promise<{ exitCode: number; output: Record<string, unknown> }> {
  const scriptEnv = {
    ...process.env,
    ...env,
    ...(skipLark ? { OFFLOAD_SKIP_LARK: '1' } : {}),
  };

  try {
    const { stdout } = await execFileAsync('npx', ['tsx', SCRIPT_PATH], {
      timeout: 30_000,
      env: scriptEnv,
    });

    // Find the JSON line in output
    const lines = stdout.trim().split('\n');
    const jsonLine = lines.find((line) => line.trim().startsWith('{'));
    if (!jsonLine) {
      return { exitCode: 0, output: { raw: stdout } };
    }
    return { exitCode: 0, output: JSON.parse(jsonLine) };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: number };
    const outputText = execErr.stdout ?? execErr.stderr ?? '';
    const lines = outputText.trim().split('\n');
    const jsonLine = lines.find((line) => line.trim().startsWith('{'));
    if (jsonLine) {
      return { exitCode: execErr.code ?? 1, output: JSON.parse(jsonLine) };
    }
    return { exitCode: execErr.code ?? 1, output: { error: outputText } };
  }
}

describe('create-side-group', () => {
  describe('input validation', () => {
    it('should fail when OFFLOAD_GROUP_NAME is missing', async () => {
      const { exitCode, output } = await runScript({
        OFFLOAD_USER_OPEN_ID: 'ou_test123',
        OFFLOAD_PARENT_CHAT_ID: 'oc_test123',
      });

      expect(exitCode).toBe(1);
      expect(output.success).toBe(false);
      expect(output.error).toContain('OFFLOAD_GROUP_NAME');
    });

    it('should fail when OFFLOAD_USER_OPEN_ID is missing', async () => {
      const { exitCode, output } = await runScript({
        OFFLOAD_GROUP_NAME: 'Test Group',
        OFFLOAD_PARENT_CHAT_ID: 'oc_test123',
      });

      expect(exitCode).toBe(1);
      expect(output.success).toBe(false);
      expect(output.error).toContain('OFFLOAD_USER_OPEN_ID');
    });

    it('should fail when OFFLOAD_PARENT_CHAT_ID is missing', async () => {
      const { exitCode, output } = await runScript({
        OFFLOAD_GROUP_NAME: 'Test Group',
        OFFLOAD_USER_OPEN_ID: 'ou_test123',
      });

      expect(exitCode).toBe(1);
      expect(output.success).toBe(false);
      expect(output.error).toContain('OFFLOAD_PARENT_CHAT_ID');
    });

    it('should fail when OFFLOAD_USER_OPEN_ID has invalid format', async () => {
      const { exitCode, output } = await runScript({
        OFFLOAD_GROUP_NAME: 'Test Group',
        OFFLOAD_USER_OPEN_ID: 'invalid_id',
        OFFLOAD_PARENT_CHAT_ID: 'oc_test123',
      });

      expect(exitCode).toBe(1);
      expect(output.success).toBe(false);
      expect(output.error).toContain('ou_xxxxx');
    });

    it('should fail when OFFLOAD_PARENT_CHAT_ID has invalid format', async () => {
      const { exitCode, output } = await runScript({
        OFFLOAD_GROUP_NAME: 'Test Group',
        OFFLOAD_USER_OPEN_ID: 'ou_test123',
        OFFLOAD_PARENT_CHAT_ID: 'invalid_id',
      });

      expect(exitCode).toBe(1);
      expect(output.success).toBe(false);
      expect(output.error).toContain('oc_xxxxx');
    });

    it('should fail when group name is blank (whitespace only)', async () => {
      const { exitCode, output } = await runScript({
        OFFLOAD_GROUP_NAME: '   ',
        OFFLOAD_USER_OPEN_ID: 'ou_test123',
        OFFLOAD_PARENT_CHAT_ID: 'oc_test123',
      });

      expect(exitCode).toBe(1);
      expect(output.success).toBe(false);
      expect(output.error).toContain('blank');
    });
  });

  describe('group name handling', () => {
    it('should truncate long group names to 64 characters', async () => {
      const longName = 'A'.repeat(100);
      const { exitCode, output } = await runScript({
        OFFLOAD_GROUP_NAME: longName,
        OFFLOAD_USER_OPEN_ID: 'ou_test123',
        OFFLOAD_PARENT_CHAT_ID: 'oc_test123',
      });

      expect(exitCode).toBe(0);
      expect(output.success).toBe(true);
      expect((output as { groupName: string }).groupName).toBe('A'.repeat(64));
    });

    it('should preserve CJK characters in group names', async () => {
      const { exitCode, output } = await runScript({
        OFFLOAD_GROUP_NAME: '配置方案 📋',
        OFFLOAD_USER_OPEN_ID: 'ou_test123',
        OFFLOAD_PARENT_CHAT_ID: 'oc_test123',
      });

      expect(exitCode).toBe(0);
      expect(output.success).toBe(true);
      expect((output as { groupName: string }).groupName).toBe('配置方案 📋');
    });
  });

  describe('dry-run mode', () => {
    it('should return success in dry-run mode', async () => {
      const { exitCode, output } = await runScript({
        OFFLOAD_GROUP_NAME: 'Test Side Group',
        OFFLOAD_USER_OPEN_ID: 'ou_test123',
        OFFLOAD_PARENT_CHAT_ID: 'oc_test123',
      });

      expect(exitCode).toBe(0);
      expect(output.success).toBe(true);
      expect((output as { chatId: string }).chatId).toBe('oc_dry_run_side_group_id');
      expect((output as { groupName: string }).groupName).toBe('Test Side Group');
    });
  });

  describe('output format', () => {
    it('should output valid JSON on success', async () => {
      const { exitCode, output } = await runScript({
        OFFLOAD_GROUP_NAME: 'LiteLLM 配置方案 - 04/22',
        OFFLOAD_USER_OPEN_ID: 'ou_testuser',
        OFFLOAD_PARENT_CHAT_ID: 'oc_parent123',
      });

      expect(exitCode).toBe(0);
      expect(output.success).toBe(true);
      expect(output).toHaveProperty('chatId');
      expect(output).toHaveProperty('groupName');
      expect(typeof (output as { chatId: string }).chatId).toBe('string');
      expect(typeof (output as { groupName: string }).groupName).toBe('string');
    });

    it('should output valid JSON with error field on validation failure', async () => {
      const { exitCode, output } = await runScript({
        OFFLOAD_GROUP_NAME: '',
        OFFLOAD_USER_OPEN_ID: 'ou_testuser',
        OFFLOAD_PARENT_CHAT_ID: 'oc_parent123',
      });

      expect(exitCode).toBe(1);
      expect(output.success).toBe(false);
      expect(output).toHaveProperty('error');
      expect(typeof (output as { error: string }).error).toBe('string');
    });
  });
});
