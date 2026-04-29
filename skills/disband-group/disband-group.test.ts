/**
 * Tests for disband-group skill
 *
 * Issue #2985: User-triggered group disband flow.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Helper to run the script and capture output
async function runScript(
  env: Record<string, string>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'npx',
      ['tsx', 'skills/disband-group/disband-group.ts'],
      {
        cwd: path.resolve(import.meta.dirname, '../..'),
        env: { ...process.env, ...env },
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error ? (error as NodeJS.ErrnoException).code === 1 ? 1 : 1 : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
        });
      },
    );
  });
}

// Helper to create a temp mapping file
async function createTempMappingFile(data: Record<string, unknown>): Promise<string> {
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'disband-test-'));
  const filePath = path.join(tmpDir, 'bot-chat-mapping.json');
  await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

describe('disband-group', () => {
  describe('validation', () => {
    it('should fail when DISBAND_CHAT_ID is not set', async () => {
      const result = await runScript({ DISBAND_SKIP_LARK: '1' });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('DISBAND_CHAT_ID');
    });

    it('should fail when DISBAND_CHAT_ID has invalid format', async () => {
      const result = await runScript({
        DISBAND_CHAT_ID: 'invalid-id',
        DISBAND_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('must match oc_xxxxx');
    });

    it('should fail when DISBAND_CHAT_ID is empty string', async () => {
      const result = await runScript({
        DISBAND_CHAT_ID: '',
        DISBAND_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('DISBAND_CHAT_ID');
    });
  });

  describe('dry-run mode (DISBAND_SKIP_LARK=1)', () => {
    it('should succeed with valid chat ID in dry-run mode', async () => {
      const mappingFile = await createTempMappingFile({});
      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_test123',
        DISBAND_MAPPING_FILE: mappingFile,
        DISBAND_SKIP_LARK: '1',
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('disbanded (dry-run)');
    });

    it('should remove matching mapping entry in dry-run mode', async () => {
      const mappingFile = await createTempMappingFile({
        'pr-123': { chatId: 'oc_test123', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
        'pr-456': { chatId: 'oc_other', createdAt: '2026-04-28T11:00:00Z', purpose: 'pr-review' },
      });

      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_test123',
        DISBAND_MAPPING_FILE: mappingFile,
        DISBAND_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('1 mapping entry/entries removed');

      // Verify the mapping file was updated
      const content = await fsPromises.readFile(mappingFile, 'utf-8');
      const mapping = JSON.parse(content);
      expect(mapping['pr-123']).toBeUndefined();
      expect(mapping['pr-456']).toBeDefined();
      expect(mapping['pr-456'].chatId).toBe('oc_other');
    });

    it('should remove multiple entries with same chatId', async () => {
      const mappingFile = await createTempMappingFile({
        'pr-123': { chatId: 'oc_shared', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
        'discussion-1': { chatId: 'oc_shared', createdAt: '2026-04-28T11:00:00Z', purpose: 'discussion' },
        'pr-456': { chatId: 'oc_other', createdAt: '2026-04-28T12:00:00Z', purpose: 'pr-review' },
      });

      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_shared',
        DISBAND_MAPPING_FILE: mappingFile,
        DISBAND_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('2 mapping entry/entries removed');

      const content = await fsPromises.readFile(mappingFile, 'utf-8');
      const mapping = JSON.parse(content);
      expect(Object.keys(mapping)).toHaveLength(1);
      expect(mapping['pr-456']).toBeDefined();
    });
  });

  describe('mapping file edge cases', () => {
    it('should handle missing mapping file gracefully', async () => {
      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_test123',
        DISBAND_MAPPING_FILE: '/nonexistent/path/bot-chat-mapping.json',
        DISBAND_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('disbanded (dry-run)');
    });

    it('should handle empty mapping file', async () => {
      const mappingFile = await createTempMappingFile({});

      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_test123',
        DISBAND_MAPPING_FILE: mappingFile,
        DISBAND_SKIP_LARK: '1',
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No mapping entries found');
    });

    it('should handle invalid JSON in mapping file', async () => {
      const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'disband-test-'));
      const filePath = path.join(tmpDir, 'bot-chat-mapping.json');
      await fsPromises.writeFile(filePath, 'not valid json{', 'utf-8');

      const result = await runScript({
        DISBAND_CHAT_ID: 'oc_test123',
        DISBAND_MAPPING_FILE: filePath,
        DISBAND_SKIP_LARK: '1',
      });

      // Should still succeed (mapping is a cache, disband proceeds)
      expect(result.exitCode).toBe(0);
    });
  });
});
