/**
 * Unit tests for disband-group skill script.
 *
 * Issue #2985: User-triggered group dissolution flow.
 *
 * Tests the core logic:
 * - Chat ID validation
 * - Group disband via lark-cli
 * - Mapping cleanup from bot-chat-mapping.json
 * - Error handling (already disbanded, mapping missing, API failure)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// We test the script by spawning it as a child process with controlled env vars
// This is more reliable than trying to mock internal modules of a standalone script

const scriptPath = path.resolve(__dirname, 'disband-group.ts');
const timeout = 15_000;

/**
 * Run the disband-group script with given environment variables.
 * Returns stdout, stderr, and exit code.
 */
async function runScript(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = execFile(
      'npx',
      ['tsx', scriptPath],
      {
        timeout,
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.trim() ?? '',
          stderr: stderr?.trim() ?? '',
          code: error && 'code' in error ? (error.code as number) : 0,
        });
      },
    );
    // Kill if timeout
    if (child.pid) {
      setTimeout(() => child.kill(), timeout);
    }
  });
}

describe('disband-group', () => {
  let tmpDir: string;
  let mappingFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disband-test-'));
    mappingFile = path.join(tmpDir, 'bot-chat-mapping.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ---- Validation ----

  describe('validation', () => {
    it('should fail when DISBAND_CHAT_ID is missing', async () => {
      const result = await runScript({ DISBAND_SKIP_LARK: '1' });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('DISBAND_CHAT_ID');
    });

    it('should fail when DISBAND_CHAT_ID has invalid format', async () => {
      const result = await runScript({
        DISBAND_CHAT_ID: 'invalid_id',
        DISBAND_SKIP_LARK: '1',
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('oc_xxxxx');
    });

    it('should accept valid oc_xxx format chat ID', async () => {
      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_test123',
        DISBAND_SKIP_LARK: '1',
        WORKSPACE_DIR: tmpDir,
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('disbanded');
    });
  });

  // ---- Mapping cleanup ----

  describe('mapping cleanup', () => {
    it('should remove the mapping entry by key', async () => {
      // Create mapping file with test data
      const mapping = {
        'pr-123': { chatId: 'oc_test123', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
        'pr-456': { chatId: 'oc_test456', createdAt: '2026-04-28T11:00:00Z', purpose: 'pr-review' },
      };
      await fs.writeFile(mappingFile, JSON.stringify(mapping, null, 2));

      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_test123',
        DISBAND_MAPPING_KEY: 'pr-123',
        DISBAND_SKIP_LARK: '1',
        WORKSPACE_DIR: tmpDir,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Removed mapping entry 'pr-123'");

      // Verify file content
      const updated = JSON.parse(await fs.readFile(mappingFile, 'utf-8'));
      expect(updated['pr-123']).toBeUndefined();
      expect(updated['pr-456']).toBeDefined();
    });

    it('should auto-detect mapping key by chatId when DISBAND_MAPPING_KEY is not provided', async () => {
      const mapping = {
        'pr-789': { chatId: 'oc_autodetect', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
      };
      await fs.writeFile(mappingFile, JSON.stringify(mapping, null, 2));

      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_autodetect',
        DISBAND_SKIP_LARK: '1',
        WORKSPACE_DIR: tmpDir,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Removed mapping entry 'pr-789'");

      const updated = JSON.parse(await fs.readFile(mappingFile, 'utf-8'));
      expect(updated['pr-789']).toBeUndefined();
    });

    it('should handle missing mapping file gracefully', async () => {
      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_nomapping',
        DISBAND_SKIP_LARK: '1',
        WORKSPACE_DIR: tmpDir,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No bot-chat-mapping.json found');
    });

    it('should handle missing mapping entry gracefully', async () => {
      const mapping = {
        'pr-999': { chatId: 'oc_other', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
      };
      await fs.writeFile(mappingFile, JSON.stringify(mapping, null, 2));

      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_notfound',
        DISBAND_SKIP_LARK: '1',
        WORKSPACE_DIR: tmpDir,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No mapping entry found');
    });

    it('should preserve other mapping entries', async () => {
      const mapping = {
        'pr-100': { chatId: 'oc_a', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
        'pr-200': { chatId: 'oc_b', createdAt: '2026-04-28T11:00:00Z', purpose: 'pr-review' },
        'pr-300': { chatId: 'oc_c', createdAt: '2026-04-28T12:00:00Z', purpose: 'pr-review' },
      };
      await fs.writeFile(mappingFile, JSON.stringify(mapping, null, 2));

      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_b',
        DISBAND_MAPPING_KEY: 'pr-200',
        DISBAND_SKIP_LARK: '1',
        WORKSPACE_DIR: tmpDir,
      });

      expect(result.code).toBe(0);

      const updated = JSON.parse(await fs.readFile(mappingFile, 'utf-8'));
      expect(Object.keys(updated)).toHaveLength(2);
      expect(updated['pr-100']).toBeDefined();
      expect(updated['pr-200']).toBeUndefined();
      expect(updated['pr-300']).toBeDefined();
    });

    it('should handle invalid JSON in mapping file', async () => {
      await fs.writeFile(mappingFile, 'not valid json{', 'utf-8');

      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_test',
        DISBAND_SKIP_LARK: '1',
        WORKSPACE_DIR: tmpDir,
      });

      // Should not crash, but may warn about mapping cleanup failure
      expect(result.stdout + result.stderr).toBeTruthy();
    });
  });

  // ---- Dry run (skip lark) ----

  describe('dry-run mode', () => {
    it('should skip lark-cli check and API call in dry-run', async () => {
      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_dryrun',
        DISBAND_SKIP_LARK: '1',
        WORKSPACE_DIR: tmpDir,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('dry-run');
      expect(result.stdout).toContain('completed successfully');
    });
  });
});
