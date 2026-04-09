/**
 * Integration tests for chat create/query/list/response scripts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

// Helper to run a script with environment variables
async function runScript(script: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, script);
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

const TEST_IDS = ['test-create-1', 'test-query-1', 'test-list-1', 'test-response-1'];

async function cleanupTestFiles() {
  for (const id of TEST_IDS) {
    try {
      await rm(resolve(CHAT_DIR, `${id}.json`), { force: true });
      await rm(resolve(CHAT_DIR, `${id}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
}

describe('chat scripts integration', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('create', () => {
    it('should create a valid chat file', async () => {
      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'test-create-1',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Test Group',
        CHAT_MEMBERS: '["ou_test123"]',
        CHAT_CONTEXT: '{"key": "value"}',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      // Verify file was created with correct content
      const content = await readFile(resolve(CHAT_DIR, 'test-create-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.id).toBe('test-create-1');
      expect(data.status).toBe('pending');
      expect(data.chatId).toBeNull();
      expect(data.createGroup.name).toBe('Test Group');
      expect(data.createGroup.members).toEqual(['ou_test123']);
      expect(data.context).toEqual({ key: 'value' });
      expect(data.response).toBeNull();
      expect(data.activationAttempts).toBe(0);
      expect(data.expiredAt).toBeNull();
    });

    it('should reject duplicate chat ID', async () => {
      // Create first
      await runScript('skills/chat/create.ts', {
        CHAT_ID: 'test-create-1',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_test123"]',
      });

      // Try to create duplicate
      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'test-create-1',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_test123"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should reject missing CHAT_ID', async () => {
      const result = await runScript('skills/chat/create.ts', {
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_test123"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('CHAT_ID');
    });

    it('should reject invalid expiresAt format', async () => {
      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'test-create-1',
        CHAT_EXPIRES_AT: '2099-12-31',
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_test123"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('UTC Z-suffix');
    });

    it('should reject invalid member format', async () => {
      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'test-create-1',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["invalid_member"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      // Create a test chat file
      const chatData = {
        id: 'test-query-1',
        status: 'active',
        chatId: 'oc_existing',
        createdAt: '2026-01-01T00:00:00Z',
        activatedAt: '2026-01-01T00:01:00Z',
        expiresAt: '2099-12-31T23:59:59Z',
        expiredAt: null,
        createGroup: { name: 'Test', members: ['ou_test123'] },
        context: {},
        response: null,
        activationAttempts: 0,
        lastActivationError: null,
        failedAt: null,
      };
      await writeFile(resolve(CHAT_DIR, 'test-query-1.json'), JSON.stringify(chatData, null, 2), 'utf-8');
    });

    it('should return chat file content', async () => {
      const result = await runScript('skills/chat/query.ts', {
        CHAT_ID: 'test-query-1',
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.id).toBe('test-query-1');
      expect(data.status).toBe('active');
    });

    it('should report chat not found', async () => {
      const result = await runScript('skills/chat/query.ts', {
        CHAT_ID: 'nonexistent',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('not found');
    });
  });

  describe('response', () => {
    let chatFilePath: string;

    beforeEach(async () => {
      chatFilePath = resolve(CHAT_DIR, 'test-response-1.json');
      const chatData = {
        id: 'test-response-1',
        status: 'active',
        chatId: 'oc_existing',
        createdAt: '2026-01-01T00:00:00Z',
        activatedAt: '2026-01-01T00:01:00Z',
        expiresAt: '2099-12-31T23:59:59Z',
        expiredAt: null,
        createGroup: { name: 'Test', members: ['ou_test123'] },
        context: {},
        response: null,
        activationAttempts: 0,
        lastActivationError: null,
        failedAt: null,
      };
      await writeFile(chatFilePath, JSON.stringify(chatData, null, 2), 'utf-8');
    });

    it('should record a response to an active chat', async () => {
      const result = await runScript('skills/chat/response.ts', {
        CHAT_ID: 'test-response-1',
        CHAT_RESPONSE: 'Looks good, approved!',
        CHAT_RESPONDER: 'ou_test123',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      // Verify response was written
      const content = await readFile(chatFilePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.response).not.toBeNull();
      expect(data.response!.content).toBe('Looks good, approved!');
      expect(data.response!.responder).toBe('ou_test123');
      expect(data.response!.repliedAt).toBeTruthy();
    });

    it('should reject duplicate response', async () => {
      // Record first response
      await runScript('skills/chat/response.ts', {
        CHAT_ID: 'test-response-1',
        CHAT_RESPONSE: 'First response',
        CHAT_RESPONDER: 'ou_test123',
      });

      // Try to record second
      const result = await runScript('skills/chat/response.ts', {
        CHAT_ID: 'test-response-1',
        CHAT_RESPONSE: 'Second response',
        CHAT_RESPONDER: 'ou_test456',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already has a response');
    });

    it('should reject response to non-active chat', async () => {
      // Write a pending chat
      const chatData = {
        id: 'test-response-1',
        status: 'pending',
        chatId: null,
        createdAt: '2026-01-01T00:00:00Z',
        activatedAt: null,
        expiresAt: '2099-12-31T23:59:59Z',
        expiredAt: null,
        createGroup: { name: 'Test', members: ['ou_test123'] },
        context: {},
        response: null,
        activationAttempts: 0,
        lastActivationError: null,
        failedAt: null,
      };
      await writeFile(chatFilePath, JSON.stringify(chatData, null, 2), 'utf-8');

      const result = await runScript('skills/chat/response.ts', {
        CHAT_ID: 'test-response-1',
        CHAT_RESPONSE: 'Response',
        CHAT_RESPONDER: 'ou_test123',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('pending');
    });
  });
});
