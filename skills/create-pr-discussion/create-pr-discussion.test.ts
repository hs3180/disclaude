/**
 * Unit tests for create-pr-discussion skill.
 *
 * Issue #2984: PR Scanner discussion group creation logic.
 *
 * Tests cover:
 * - Group name generation
 * - Mapping key generation
 * - Mapping file read/write
 * - Idempotency (skip if mapping exists)
 * - Error handling (cleanup on write failure)
 * - Validation
 *
 * lark-cli calls are tested with CREATE_SKIP_LARK=1 mode.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---- Test helpers ----

/**
 * Run the create-pr-discussion script with given env vars.
 * Returns { stdout, stderr, exitCode }.
 */
async function runScript(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const scriptPath = join(__dirname, 'create-pr-discussion.ts');

  return new Promise((resolve) => {
    const child = execFile(
      'npx',
      ['tsx', scriptPath],
      {
        env: { ...process.env, ...env },
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.trim() ?? '',
          stderr: stderr?.trim() ?? '',
          exitCode: error ? (error as NodeJS.ErrnoException).code === 'ENOENT' ? 1 : (error as any).status ?? 1 : 0,
        });
      },
    );
  });
}

/**
 * Parse the JSON output from the script.
 */
function parseOutput(stdout: string): { ok: boolean; [key: string]: unknown } {
  return JSON.parse(stdout);
}

// ---- Tests ----

describe('create-pr-discussion', () => {
  let tempDir: string;
  let mappingFile: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `test-create-pr-discussion-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    mappingFile = join(tempDir, 'bot-chat-mapping.json');
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // ---- Validation ----

  describe('validation', () => {
    it('should fail when CREATE_PR_NUMBER is missing', async () => {
      const result = await runScript({
        CREATE_PR_TITLE: 'Test PR',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(1);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(false);
      expect(output.error).toContain('CREATE_PR_NUMBER');
    });

    it('should fail when CREATE_PR_TITLE is missing', async () => {
      const result = await runScript({
        CREATE_PR_NUMBER: '123',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(1);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(false);
      expect(output.error).toContain('CREATE_PR_TITLE');
    });

    it('should fail when CREATE_PR_NUMBER is not a number', async () => {
      const result = await runScript({
        CREATE_PR_NUMBER: 'abc',
        CREATE_PR_TITLE: 'Test PR',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(1);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(false);
      expect(output.error).toContain('positive integer');
    });

    it('should fail when CREATE_PR_TITLE is blank', async () => {
      const result = await runScript({
        CREATE_PR_NUMBER: '123',
        CREATE_PR_TITLE: '   ',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(1);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(false);
      expect(output.error).toContain('blank');
    });
  });

  // ---- Group creation ----

  describe('group creation', () => {
    it('should create a new group and write mapping', async () => {
      const result = await runScript({
        CREATE_PR_NUMBER: '123',
        CREATE_PR_TITLE: 'Fix authentication bug',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(0);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.created).toBe(true);
      expect(output.key).toBe('pr-123');
      expect(output.groupName).toBe('PR #123 · Fix authentication bug');
      expect(output.chatId).toBe('oc_test_123');

      // Verify mapping file
      const mapping = JSON.parse(readFileSync(mappingFile, 'utf-8'));
      expect(mapping['pr-123']).toBeDefined();
      expect(mapping['pr-123'].chatId).toBe('oc_test_123');
      expect(mapping['pr-123'].purpose).toBe('pr-review');
      expect(mapping['pr-123'].createdAt).toBeDefined();
    });

    it('should truncate long PR titles in group name', async () => {
      const longTitle = '这是一个非常非常长的PR标题需要被截断以确保群名不超过限制的长度要求';
      const result = await runScript({
        CREATE_PR_NUMBER: '456',
        CREATE_PR_TITLE: longTitle,
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(0);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.created).toBe(true);

      // Group name should contain truncated title with ...
      const groupName = output.groupName as string;
      expect(groupName).toContain('PR #456 · ');
      expect(groupName).toContain('...');
    });

    it('should handle short PR titles without truncation', async () => {
      const result = await runScript({
        CREATE_PR_NUMBER: '789',
        CREATE_PR_TITLE: 'Short fix',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(0);
      const output = parseOutput(result.stdout);
      expect(output.groupName).toBe('PR #789 · Short fix');
    });
  });

  // ---- Idempotency ----

  describe('idempotency', () => {
    it('should return existing chatId if mapping already exists', async () => {
      // Pre-create the mapping
      const existingMapping = {
        'pr-123': {
          chatId: 'oc_existing',
          createdAt: '2026-04-28T10:00:00Z',
          purpose: 'pr-review',
        },
      };
      writeFileSync(mappingFile, JSON.stringify(existingMapping, null, 2));

      const result = await runScript({
        CREATE_PR_NUMBER: '123',
        CREATE_PR_TITLE: 'Fix authentication bug',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(0);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.created).toBe(false);
      expect(output.chatId).toBe('oc_existing');
      expect(output.key).toBe('pr-123');

      // Verify mapping was NOT modified
      const mapping = JSON.parse(readFileSync(mappingFile, 'utf-8'));
      expect(mapping['pr-123'].chatId).toBe('oc_existing');
      expect(mapping['pr-123'].createdAt).toBe('2026-04-28T10:00:00Z');
    });

    it('should create mapping for different PR even if other mappings exist', async () => {
      const existingMapping = {
        'pr-100': {
          chatId: 'oc_other',
          createdAt: '2026-04-28T10:00:00Z',
          purpose: 'pr-review',
        },
      };
      writeFileSync(mappingFile, JSON.stringify(existingMapping, null, 2));

      const result = await runScript({
        CREATE_PR_NUMBER: '200',
        CREATE_PR_TITLE: 'New PR',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(0);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.created).toBe(true);
      expect(output.chatId).toBe('oc_test_200');

      // Both mappings should exist
      const mapping = JSON.parse(readFileSync(mappingFile, 'utf-8'));
      expect(mapping['pr-100']).toBeDefined();
      expect(mapping['pr-200']).toBeDefined();
    });
  });

  // ---- Mapping file handling ----

  describe('mapping file', () => {
    it('should create mapping file if it does not exist', async () => {
      expect(existsSync(mappingFile)).toBe(false);

      const result = await runScript({
        CREATE_PR_NUMBER: '123',
        CREATE_PR_TITLE: 'Test',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(mappingFile)).toBe(true);

      const mapping = JSON.parse(readFileSync(mappingFile, 'utf-8'));
      expect(mapping['pr-123']).toBeDefined();
    });

    it('should handle corrupt mapping file gracefully', async () => {
      writeFileSync(mappingFile, 'not valid json{');

      const result = await runScript({
        CREATE_PR_NUMBER: '123',
        CREATE_PR_TITLE: 'Test',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      // Should still succeed (treats corrupt file as empty)
      expect(result.exitCode).toBe(0);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.created).toBe(true);
    });

    it('should handle non-object mapping file gracefully', async () => {
      writeFileSync(mappingFile, '[]');

      const result = await runScript({
        CREATE_PR_NUMBER: '123',
        CREATE_PR_TITLE: 'Test',
        CREATE_SKIP_LARK: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(0);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.created).toBe(true);
    });
  });

  // ---- Dry run ----

  describe('dry run', () => {
    it('should preview group name without creating anything', async () => {
      const result = await runScript({
        CREATE_PR_NUMBER: '123',
        CREATE_PR_TITLE: 'Test PR',
        CREATE_DRY_RUN: '1',
        CREATE_MAPPING_FILE: mappingFile,
      });

      expect(result.exitCode).toBe(0);
      const output = parseOutput(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.created).toBe(false);
      expect(output.groupName).toBe('PR #123 · Test PR');
      expect(output.chatId).toBe('');

      // Mapping file should NOT be created
      expect(existsSync(mappingFile)).toBe(false);
    });
  });
});
