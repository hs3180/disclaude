/**
 * Tests for context-offload/create-side-group.ts
 *
 * Integration tests that run the script via npx tsx and verify
 * the resulting chat files in workspace/chats/.
 *
 * Issue #2351: Context Offloading feature.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

// Helper to run the create-side-group script
async function runScript(env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'skills/context-offload/create-side-group.ts');
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

// Track created files for cleanup
let createdFiles: string[] = [];

function extractChatId(stdout: string): string | null {
  try {
    const json = JSON.parse(stdout);
    return json.chatId ?? null;
  } catch {
    return null;
  }
}

async function cleanupCreatedFiles() {
  for (const file of createdFiles) {
    try {
      await rm(resolve(CHAT_DIR, file), { force: true });
      await rm(resolve(CHAT_DIR, `${file}.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
  createdFiles = [];
}

async function cleanupAllOffloadFiles() {
  try {
    const files = await readdir(CHAT_DIR);
    for (const file of files) {
      if (file.startsWith('offload-')) {
        try {
          await rm(resolve(CHAT_DIR, file), { force: true });
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Directory might not exist
  }
}

describe('context-offload/create-side-group', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    createdFiles = [];
  });

  afterEach(async () => {
    await cleanupCreatedFiles();
    await cleanupAllOffloadFiles();
  });

  const validEnv = {
    OFFLOAD_PARENT_CHAT_ID: 'oc_test_parent_123',
    OFFLOAD_NAME: 'Test Side Group',
    OFFLOAD_MEMBERS: '["ou_testuser1"]',
  };

  describe('successful creation', () => {
    it('should create a valid chat file with correct schema', async () => {
      const result = await runScript(validEnv);

      expect(result.code).toBe(0);

      const output = JSON.parse(result.stdout);
      expect(output.ok).toBe(true);
      expect(output.chatId).toMatch(/^offload-\d+-[a-z0-9]+$/);
      expect(output.parentChatId).toBe('oc_test_parent_123');
      expect(output.groupName).toBe('Test Side Group');
      expect(output.message).toContain('waiting for activation');

      // Track for cleanup
      createdFiles.push(`${output.chatId}.json`);

      // Verify file was created with correct content
      const filePath = resolve(CHAT_DIR, `${output.chatId}.json`);
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);

      expect(data.id).toBe(output.chatId);
      expect(data.status).toBe('pending');
      expect(data.chatId).toBeNull();
      expect(data.activatedAt).toBeNull();
      expect(data.expiredAt).toBeNull();
      expect(data.response).toBeNull();
      expect(data.activationAttempts).toBe(0);
      expect(data.lastActivationError).toBeNull();
      expect(data.failedAt).toBeNull();
    });

    it('should set correct expiry (default 48h)', async () => {
      const before = Date.now();
      const result = await runScript(validEnv);
      const after = Date.now();

      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      createdFiles.push(`${output.chatId}.json`);

      const filePath = resolve(CHAT_DIR, `${output.chatId}.json`);
      const data = JSON.parse(await readFile(filePath, 'utf-8'));

      // Verify expiry is approximately 48h from now
      const expiresAt = new Date(data.expiresAt).getTime();
      const expectedMin = before + 47.5 * 60 * 60 * 1000;
      const expectedMax = after + 48.5 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it('should set custom expiry from OFFLOAD_EXPIRES_HOURS', async () => {
      const before = Date.now();
      const result = await runScript({
        ...validEnv,
        OFFLOAD_EXPIRES_HOURS: '24',
      });
      const after = Date.now();

      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      createdFiles.push(`${output.chatId}.json`);

      const filePath = resolve(CHAT_DIR, `${output.chatId}.json`);
      const data = JSON.parse(await readFile(filePath, 'utf-8'));

      const expiresAt = new Date(data.expiresAt).getTime();
      const expectedMin = before + 23.5 * 60 * 60 * 1000;
      const expectedMax = after + 24.5 * 60 * 60 * 1000;
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it('should store parent chat ID and content summary in context', async () => {
      const result = await runScript({
        ...validEnv,
        OFFLOAD_CONTENT_SUMMARY: '3 files: config.yaml, app.py, .env',
      });

      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      createdFiles.push(`${output.chatId}.json`);

      const filePath = resolve(CHAT_DIR, `${output.chatId}.json`);
      const data = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(data.context.type).toBe('context-offload');
      expect(data.context.parentChatId).toBe('oc_test_parent_123');
      expect(data.context.contentSummary).toBe('3 files: config.yaml, app.py, .env');
    });

    it('should handle empty content summary', async () => {
      const result = await runScript(validEnv);

      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      createdFiles.push(`${output.chatId}.json`);

      const filePath = resolve(CHAT_DIR, `${output.chatId}.json`);
      const data = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(data.context.contentSummary).toBe('');
      expect(data.context.type).toBe('context-offload');
    });

    it('should handle multiple members', async () => {
      const result = await runScript({
        ...validEnv,
        OFFLOAD_MEMBERS: '["ou_user1", "ou_user2", "ou_user3"]',
      });

      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      createdFiles.push(`${output.chatId}.json`);

      const filePath = resolve(CHAT_DIR, `${output.chatId}.json`);
      const data = JSON.parse(await readFile(filePath, 'utf-8'));

      expect(data.createGroup.members).toEqual(['ou_user1', 'ou_user2', 'ou_user3']);
    });

    it('should truncate long group names', async () => {
      const longName = 'A'.repeat(100);
      const result = await runScript({
        ...validEnv,
        OFFLOAD_NAME: longName,
      });

      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      createdFiles.push(`${output.chatId}.json`);

      const filePath = resolve(CHAT_DIR, `${output.chatId}.json`);
      const data = JSON.parse(await readFile(filePath, 'utf-8'));

      // Group name should be truncated to 64 chars
      expect(data.createGroup.name.length).toBeLessThanOrEqual(64);
      expect(data.createGroup.name).toBe('A'.repeat(64));
    });

    it('should generate unique chat IDs for concurrent requests', async () => {
      const results = await Promise.all([
        runScript({ ...validEnv, OFFLOAD_NAME: 'Group A' }),
        runScript({ ...validEnv, OFFLOAD_NAME: 'Group B' }),
        runScript({ ...validEnv, OFFLOAD_NAME: 'Group C' }),
      ]);

      const chatIds = results.map(r => {
        expect(r.code).toBe(0);
        const output = JSON.parse(r.stdout);
        createdFiles.push(`${output.chatId}.json`);
        return output.chatId;
      });

      // All chat IDs should be unique
      expect(new Set(chatIds).size).toBe(3);
    });
  });

  describe('validation errors', () => {
    it('should fail without OFFLOAD_PARENT_CHAT_ID', async () => {
      const result = await runScript({
        OFFLOAD_NAME: 'Test Group',
        OFFLOAD_MEMBERS: '["ou_testuser1"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OFFLOAD_PARENT_CHAT_ID');
    });

    it('should fail without OFFLOAD_NAME', async () => {
      const result = await runScript({
        OFFLOAD_PARENT_CHAT_ID: 'oc_test',
        OFFLOAD_MEMBERS: '["ou_testuser1"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OFFLOAD_NAME');
    });

    it('should fail without OFFLOAD_MEMBERS', async () => {
      const result = await runScript({
        OFFLOAD_PARENT_CHAT_ID: 'oc_test',
        OFFLOAD_NAME: 'Test Group',
      });

      expect(result.code).toBe(1);
      // validateMembers() in chat/schema.ts uses 'CHAT_MEMBERS' in error message
      expect(result.stderr).toContain('non-empty');
    });

    it('should fail with empty members array', async () => {
      const result = await runScript({
        ...validEnv,
        OFFLOAD_MEMBERS: '[]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('non-empty');
    });

    it('should fail with invalid member IDs', async () => {
      const result = await runScript({
        ...validEnv,
        OFFLOAD_MEMBERS: '["invalid_id"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should fail with invalid OFFLOAD_EXPIRES_HOURS', async () => {
      const result = await runScript({
        ...validEnv,
        OFFLOAD_EXPIRES_HOURS: '0',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OFFLOAD_EXPIRES_HOURS');
    });

    it('should fail with OFFLOAD_EXPIRES_HOURS too large', async () => {
      const result = await runScript({
        ...validEnv,
        OFFLOAD_EXPIRES_HOURS: '999',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OFFLOAD_EXPIRES_HOURS');
    });

    it('should fail with invalid OFFLOAD_EXPIRES_HOURS (non-numeric)', async () => {
      const result = await runScript({
        ...validEnv,
        OFFLOAD_EXPIRES_HOURS: 'abc',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OFFLOAD_EXPIRES_HOURS');
    });

    it('should fail with unsafe group name characters', async () => {
      const result = await runScript({
        ...validEnv,
        OFFLOAD_NAME: '<script>alert(1)</script>',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('unsafe');
    });
  });

  describe('output format', () => {
    it('should output valid JSON with all required fields', async () => {
      const result = await runScript(validEnv);

      expect(result.code).toBe(0);
      const output = JSON.parse(result.stdout);
      createdFiles.push(`${output.chatId}.json`);

      expect(output).toHaveProperty('ok', true);
      expect(output).toHaveProperty('chatId');
      expect(output).toHaveProperty('parentChatId');
      expect(output).toHaveProperty('groupName');
      expect(output).toHaveProperty('expiresAt');
      expect(output).toHaveProperty('message');
    });
  });
});
