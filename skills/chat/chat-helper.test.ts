/**
 * skills/chat/chat-helper.test.ts — Tests for the chat-helper.ts script.
 *
 * Tests run with CHAT_SKIP_LARK=1 to avoid needing lark-cli installed.
 * Validates input handling, dry-run behavior, and output format.
 */

import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = 'skills/chat/chat-helper.ts';

/** Run chat-helper.ts with given env vars. */
async function runHelper(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execFileAsync('npx', ['tsx', SCRIPT_PATH], {
      timeout: 15_000,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; stderr?: string; code?: string };
    return {
      stdout: execErr.stdout ?? '',
      stderr: execErr.stderr ?? '',
      exitCode: execErr.code === 'ERR_CHILD_PROCESS_EXIT_CODE'
        ? 1
        : (err as { exitCode?: number }).exitCode ?? 1,
    };
  }
}

describe('chat-helper', () => {
  describe('create action', () => {
    it('should create a group in dry-run mode', async () => {
      const result = await runHelper({
        CHAT_ACTION: 'create',
        CHAT_TOPIC: 'Test Discussion Topic',
        CHAT_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.action).toBe('create');
      expect(output.chatId).toMatch(/^oc_test_\d+$/);
      expect(output.name).toBe('讨论: Test Discussion Topic');
    });

    it('should prefix topic with 讨论:', async () => {
      const result = await runHelper({
        CHAT_ACTION: 'create',
        CHAT_TOPIC: 'Feature Request',
        CHAT_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.name).toBe('讨论: Feature Request');
    });

    it('should fail when CHAT_TOPIC is empty', async () => {
      const result = await runHelper({
        CHAT_ACTION: 'create',
        CHAT_TOPIC: '',
        CHAT_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('CHAT_TOPIC is required');
    });

    it('should fail when CHAT_TOPIC is whitespace only', async () => {
      const result = await runHelper({
        CHAT_ACTION: 'create',
        CHAT_TOPIC: '   ',
        CHAT_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('CHAT_TOPIC is required');
    });

    it('should truncate long topics to 64 characters', async () => {
      const longTopic = 'あ'.repeat(100); // CJK characters
      const result = await runHelper({
        CHAT_ACTION: 'create',
        CHAT_TOPIC: longTopic,
        CHAT_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      // Name is "讨论: " (3 chars) + 64 chars = 67 chars total
      expect(output.name.length).toBeLessThan(longTopic.length + 10);
    });
  });

  describe('dissolve action', () => {
    it('should dissolve a group in dry-run mode', async () => {
      const result = await runHelper({
        CHAT_ACTION: 'dissolve',
        CHAT_TARGET_ID: 'oc_abc123def456',
        CHAT_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.action).toBe('dissolve');
      expect(output.chatId).toBe('oc_abc123def456');
      expect(output.success).toBe(true);
    });

    it('should fail when CHAT_TARGET_ID is missing', async () => {
      const result = await runHelper({
        CHAT_ACTION: 'dissolve',
        CHAT_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('CHAT_TARGET_ID');
    });

    it('should reject invalid chat ID format', async () => {
      const result = await runHelper({
        CHAT_ACTION: 'dissolve',
        CHAT_TARGET_ID: 'invalid_id',
        CHAT_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('oc_xxxxx');
    });
  });

  describe('validation', () => {
    it('should fail when CHAT_ACTION is missing', async () => {
      const result = await runHelper({
        CHAT_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('CHAT_ACTION');
    });

    it('should fail when CHAT_ACTION is invalid', async () => {
      const result = await runHelper({
        CHAT_ACTION: 'invalid',
        CHAT_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('create');
    });
  });
});
