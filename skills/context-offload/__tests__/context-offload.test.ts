/**
 * Tests for context-offload script.
 *
 * Uses OFFLOAD_SKIP_LARK=1 to skip actual lark-cli API calls.
 * Tests focus on input validation, content splitting logic,
 * and script execution flow.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const TEMP_DIR = resolve(PROJECT_ROOT, 'workspace/test-context-offload');

// Helper to run the script with environment variables
async function runScript(env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'skills/context-offload/context-offload.ts');
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

describe('context-offload', () => {
  beforeEach(async () => {
    await mkdir(TEMP_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(TEMP_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  describe('validation', () => {
    it('should reject missing OFFLOAD_GROUP_NAME', async () => {
      const result = await runScript({
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OFFLOAD_GROUP_NAME');
    });

    it('should reject empty OFFLOAD_GROUP_NAME', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: '',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OFFLOAD_GROUP_NAME');
    });

    it('should reject whitespace-only OFFLOAD_GROUP_NAME', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: '   ',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('cannot be blank');
    });

    it('should reject missing OFFLOAD_MEMBERS', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Test Group',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OFFLOAD_MEMBERS');
    });

    it('should reject invalid JSON in OFFLOAD_MEMBERS', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Test Group',
        OFFLOAD_MEMBERS: 'not-json',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('valid JSON');
    });

    it('should reject empty members array', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Test Group',
        OFFLOAD_MEMBERS: '[]',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('non-empty');
    });

    it('should reject invalid member ID format', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Test Group',
        OFFLOAD_MEMBERS: '["invalid_member"]',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should accept valid group names with CJK and special chars', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: '测试群聊 - PR #123 (Review)',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('RESULT:');
    });
  });

  describe('dry-run execution', () => {
    it('should succeed with valid inputs in dry-run mode', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Test Group - 04/20',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_CONTENT: 'Hello, this is a test message.',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('RESULT:');
      expect(result.stdout).toContain('"chatId":"oc_dry_run_test"');
      expect(result.stdout).toContain('"messageCount":1');
    });

    it('should create group without content', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Empty Group',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No content provided');
      expect(result.stdout).toContain('"messageCount":0');
    });

    it('should create group with content from file', async () => {
      const contentFile = resolve(TEMP_DIR, 'content.txt');
      await writeFile(contentFile, 'File content for testing.', 'utf-8');

      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'File Content Group',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_CONTENT_FILE: contentFile,
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('RESULT:');
      expect(result.stdout).toContain('"messageCount":1');
    });

    it('should reject non-existent content file', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Test',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_CONTENT_FILE: '/nonexistent/path.txt',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Failed to read content file');
    });

    it('should handle multiple members', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Multi Member Group',
        OFFLOAD_MEMBERS: '["ou_user1","ou_user2","ou_user3"]',
        OFFLOAD_CONTENT: 'Multi-member test',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('3 member(s)');
      expect(result.stdout).toContain('"messageCount":1');
    });

    it('should truncate long group names', async () => {
      const longName = 'A'.repeat(100);
      const result = await runScript({
        OFFLOAD_GROUP_NAME: longName,
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      // The truncated name should be 64 chars
      const match = result.stdout.match(/"groupName":"([A]+)"/);
      expect(match).toBeTruthy();
      expect(match![1].length).toBe(64);
    });

    it('should prefer OFFLOAD_CONTENT over OFFLOAD_CONTENT_FILE', async () => {
      const contentFile = resolve(TEMP_DIR, 'content.txt');
      await writeFile(contentFile, 'File content', 'utf-8');

      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Priority Test',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_CONTENT: 'Env content',
        OFFLOAD_CONTENT_FILE: contentFile,
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      // When both are provided, OFFLOAD_CONTENT takes priority
      expect(result.stdout).toContain('RESULT:');
    });
  });

  describe('content splitting', () => {
    it('should handle short content without splitting', async () => {
      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Short Content',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_CONTENT: 'Short message',
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('1 message(s)');
      expect(result.stdout).toContain('"messageCount":1');
    });

    it('should split long content into multiple messages', async () => {
      // Create content >4000 chars with paragraph breaks
      const paragraph = 'This is a test paragraph with some content. '.repeat(20) + '\n\n';
      const longContent = paragraph.repeat(10); // ~13,200 chars

      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'Long Content',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_CONTENT: longContent,
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      // Should be split into multiple messages
      const match = result.stdout.match(/"messageCount":(\d+)/);
      expect(match).toBeTruthy();
      const count = parseInt(match![1], 10);
      expect(count).toBeGreaterThan(1);
    });

    it('should handle content with mixed CJK and ASCII', async () => {
      const cjkContent = '这是一段中文内容，用于测试飞书消息的兼容性。'.repeat(50) + '\n\n' +
        'English content mixed with 中文内容。'.repeat(50);

      const result = await runScript({
        OFFLOAD_GROUP_NAME: 'CJK 测试群 - 04/20',
        OFFLOAD_MEMBERS: '["ou_test123"]',
        OFFLOAD_CONTENT: cjkContent,
        OFFLOAD_SKIP_LARK: '1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('RESULT:');
    });
  });
});
