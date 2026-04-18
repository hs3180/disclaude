/**
 * Integration tests for context-offload/create-side-group script.
 *
 * Issue #2351: Context Offloading - Auto-create side group for long-form content delivery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, readdir } from 'node:fs/promises';
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

/** Clean up all offload-* test files */
async function cleanupOffloadFiles() {
  try {
    const files = await readdir(CHAT_DIR);
    for (const file of files) {
      if (file.startsWith('offload-') && (file.endsWith('.json') || file.endsWith('.json.lock'))) {
        try {
          await rm(resolve(CHAT_DIR, file), { force: true });
        } catch {
          // Ignore
        }
      }
    }
  } catch {
    // Directory may not exist
  }
}

const VALID_ENV = {
  OFFLOAD_PARENT_CHAT_ID: 'oc_abcdef123',
  OFFLOAD_GROUP_NAME: 'Test Side Group',
  OFFLOAD_MEMBERS: '["ou_user123"]',
};

describe('context-offload/create-side-group', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupOffloadFiles();
  });

  afterEach(async () => {
    await cleanupOffloadFiles();
  });

  describe('success cases', () => {
    it('should create a valid pending chat file for side group', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', VALID_ENV);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK: Side group chat created');
      expect(result.stdout).toContain('CHAT_ID: offload-');
      expect(result.stdout).toContain('GROUP_NAME: Test Side Group');
      expect(result.stdout).toContain('STATUS: pending');
      expect(result.stdout).toContain('PARENT_CHAT_ID: oc_abcdef123');
    });

    it('should create a chat file with correct structure', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', VALID_ENV);
      expect(result.code).toBe(0);

      // Extract CHAT_ID from output
      const chatIdMatch = result.stdout.match(/CHAT_ID: (offload-\w+)/);
      expect(chatIdMatch).not.toBeNull();
      const chatId = chatIdMatch![1];

      // Read and verify the created file
      const content = await readFile(resolve(CHAT_DIR, `${chatId}.json`), 'utf-8');
      const data = JSON.parse(content);

      expect(data.id).toBe(chatId);
      expect(data.id).toMatch(/^offload-[a-f0-9]{8}$/);
      expect(data.status).toBe('pending');
      expect(data.chatId).toBeNull();
      expect(data.createGroup.name).toBe('Test Side Group');
      expect(data.createGroup.members).toEqual(['ou_user123']);
      expect(data.triggerMode).toBe('always');
      expect(data.response).toBeNull();
      expect(data.activationAttempts).toBe(0);
      expect(data.expiredAt).toBeNull();
      expect(data.failedAt).toBeNull();
    });

    it('should include parent chat ID and type in context', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', VALID_ENV);
      expect(result.code).toBe(0);

      const chatIdMatch = result.stdout.match(/CHAT_ID: (offload-\w+)/);
      const chatId = chatIdMatch![1];

      const content = await readFile(resolve(CHAT_DIR, `${chatId}.json`), 'utf-8');
      const data = JSON.parse(content);

      expect(data.context.parentChatId).toBe('oc_abcdef123');
      expect(data.context.type).toBe('context-offload');
    });

    it('should merge additional context with built-in context', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_CONTEXT: '{"source": "voice-mode", "contentType": "config"}',
      });
      expect(result.code).toBe(0);

      const chatIdMatch = result.stdout.match(/CHAT_ID: (offload-\w+)/);
      const chatId = chatIdMatch![1];

      const content = await readFile(resolve(CHAT_DIR, `${chatId}.json`), 'utf-8');
      const data = JSON.parse(content);

      expect(data.context.source).toBe('voice-mode');
      expect(data.context.contentType).toBe('config');
      expect(data.context.parentChatId).toBe('oc_abcdef123');
      expect(data.context.type).toBe('context-offload');
    });

    it('should default expiry to 24 hours from now', async () => {
      const before = Date.now();
      const result = await runScript('skills/context-offload/create-side-group.ts', VALID_ENV);
      const after = Date.now();

      expect(result.code).toBe(0);

      const chatIdMatch = result.stdout.match(/CHAT_ID: (offload-\w+)/);
      const chatId = chatIdMatch![1];

      const content = await readFile(resolve(CHAT_DIR, `${chatId}.json`), 'utf-8');
      const data = JSON.parse(content);

      // Expiry should be approximately 24 hours from now
      const expiresAt = new Date(data.expiresAt).getTime();
      const expectedMin = before + 24 * 3600 * 1000 - 5000; // Allow 5s tolerance
      const expectedMax = after + 24 * 3600 * 1000 + 5000;
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it('should respect custom OFFLOAD_EXPIRES_HOURS', async () => {
      const before = Date.now();
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_EXPIRES_HOURS: '48',
      });
      const after = Date.now();

      expect(result.code).toBe(0);

      const chatIdMatch = result.stdout.match(/CHAT_ID: (offload-\w+)/);
      const chatId = chatIdMatch![1];

      const content = await readFile(resolve(CHAT_DIR, `${chatId}.json`), 'utf-8');
      const data = JSON.parse(content);

      const expiresAt = new Date(data.expiresAt).getTime();
      const expectedMin = before + 48 * 3600 * 1000 - 5000;
      const expectedMax = after + 48 * 3600 * 1000 + 5000;
      expect(expiresAt).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresAt).toBeLessThanOrEqual(expectedMax);
    });

    it('should truncate long group names to 64 characters', async () => {
      const longName = 'A'.repeat(100);
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_GROUP_NAME: longName,
      });

      expect(result.code).toBe(0);

      const chatIdMatch = result.stdout.match(/CHAT_ID: (offload-\w+)/);
      const chatId = chatIdMatch![1];

      const content = await readFile(resolve(CHAT_DIR, `${chatId}.json`), 'utf-8');
      const data = JSON.parse(content);

      expect(data.createGroup.name.length).toBe(64);
      expect(data.createGroup.name).toBe('A'.repeat(64));
    });

    it('should support multiple members', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_MEMBERS: '["ou_user1", "ou_user2", "ou_user3"]',
      });

      expect(result.code).toBe(0);

      const chatIdMatch = result.stdout.match(/CHAT_ID: (offload-\w+)/);
      const chatId = chatIdMatch![1];

      const content = await readFile(resolve(CHAT_DIR, `${chatId}.json`), 'utf-8');
      const data = JSON.parse(content);

      expect(data.createGroup.members).toEqual(['ou_user1', 'ou_user2', 'ou_user3']);
    });

    it('should generate unique chat IDs on each invocation', async () => {
      const result1 = await runScript('skills/context-offload/create-side-group.ts', VALID_ENV);
      const result2 = await runScript('skills/context-offload/create-side-group.ts', VALID_ENV);

      expect(result1.code).toBe(0);
      expect(result2.code).toBe(0);

      const id1 = result1.stdout.match(/CHAT_ID: (offload-\w+)/)![1];
      const id2 = result2.stdout.match(/CHAT_ID: (offload-\w+)/)![1];

      expect(id1).not.toBe(id2);
    });
  });

  describe('validation errors', () => {
    it('should reject missing OFFLOAD_PARENT_CHAT_ID', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        OFFLOAD_GROUP_NAME: 'Test',
        OFFLOAD_MEMBERS: '["ou_user123"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OFFLOAD_PARENT_CHAT_ID');
    });

    it('should reject invalid OFFLOAD_PARENT_CHAT_ID format', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_PARENT_CHAT_ID: 'invalid_chat_id',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('oc_xxxxx');
    });

    it('should reject missing OFFLOAD_GROUP_NAME', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        OFFLOAD_PARENT_CHAT_ID: 'oc_abcdef123',
        OFFLOAD_MEMBERS: '["ou_user123"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OFFLOAD_GROUP_NAME');
    });

    it('should reject missing OFFLOAD_MEMBERS', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        OFFLOAD_PARENT_CHAT_ID: 'oc_abcdef123',
        OFFLOAD_GROUP_NAME: 'Test Group',
      });

      expect(result.code).toBe(1);
      // The underlying validateMembers() uses "CHAT_MEMBERS" in the error message
      expect(result.stderr).toContain('CHAT_MEMBERS');
    });

    it('should reject invalid member format', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_MEMBERS: '["invalid_member"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should reject empty members array', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_MEMBERS: '[]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('non-empty');
    });

    it('should reject invalid JSON in OFFLOAD_MEMBERS', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_MEMBERS: 'not json',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('JSON');
    });

    it('should reject invalid JSON in OFFLOAD_CONTEXT', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_CONTEXT: 'not json',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('JSON');
    });

    it('should reject negative OFFLOAD_EXPIRES_HOURS', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_EXPIRES_HOURS: '-1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('positive');
    });

    it('should reject zero OFFLOAD_EXPIRES_HOURS', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_EXPIRES_HOURS: '0',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('positive');
    });

    it('should reject OFFLOAD_EXPIRES_HOURS exceeding 168 hours', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_EXPIRES_HOURS: '200',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('168');
    });

    it('should reject unsafe group name', async () => {
      const result = await runScript('skills/context-offload/create-side-group.ts', {
        ...VALID_ENV,
        OFFLOAD_GROUP_NAME: 'test; rm -rf /',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('unsafe');
    });
  });
});
