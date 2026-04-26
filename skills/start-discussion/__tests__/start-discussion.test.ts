/**
 * Integration tests for start-discussion skill.
 *
 * Verifies that the skill correctly uses the underlying chat infrastructure
 * to create discussion chats with the expected context structure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

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

const TEST_IDS = [
  'discuss-test-1',
  'discuss-test-context',
  'discuss-test-duplicate',
  'discuss-test-invalid',
  'discuss-test-query-1',
];

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

describe('start-discussion skill integration', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('create discussion chat', () => {
    it('should create a discussion chat with context', async () => {
      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'discuss-test-1',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Discuss: expense categories',
        CHAT_MEMBERS: '["ou_test123"]',
        CHAT_CONTEXT: JSON.stringify({
          topic: 'expense category preferences',
          background: 'user corrected classification 3 times',
          question: 'classify by type or by scenario?',
          followUpAction: 'update classification logic',
        }),
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      // Verify file content
      const content = await readFile(resolve(CHAT_DIR, 'discuss-test-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.id).toBe('discuss-test-1');
      expect(data.status).toBe('pending');
      expect(data.createGroup.name).toBe('Discuss: expense categories');
      expect(data.createGroup.members).toEqual(['ou_test123']);
      expect(data.context.topic).toBe('expense category preferences');
      expect(data.context.background).toBe('user corrected classification 3 times');
      expect(data.context.question).toBe('classify by type or by scenario?');
      expect(data.context.followUpAction).toBe('update classification logic');
    });

    it('should create a discussion chat with full context fields', async () => {
      const context = {
        topic: 'expense categories',
        background: 'user corrected classification 3 times',
        question: 'classify by type or by scenario?',
        followUpAction: 'update classification Skill',
        sourceChatId: 'oc_current_chat',
        triggerCount: 3,
        suggestedOptions: ['by type (food/transport/entertainment)', 'by scenario (work/life/social)'],
      };

      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'discuss-test-context',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Discuss: expense categories',
        CHAT_MEMBERS: '["ou_abc123", "ou_def456"]',
        CHAT_CONTEXT: JSON.stringify(context),
      });

      expect(result.code).toBe(0);

      const content = await readFile(resolve(CHAT_DIR, 'discuss-test-context.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.context).toEqual(context);
      expect(data.createGroup.members).toEqual(['ou_abc123', 'ou_def456']);
    });

    it('should reject context exceeding max size', async () => {
      const largeContext = { topic: 'x'.repeat(5000) };
      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'discuss-test-invalid',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_test123"]',
        CHAT_CONTEXT: JSON.stringify(largeContext),
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('too large');
    });

    it('should prevent duplicate discussion IDs', async () => {
      // Create first
      await runScript('skills/chat/create.ts', {
        CHAT_ID: 'discuss-test-duplicate',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Discuss 1',
        CHAT_MEMBERS: '["ou_test123"]',
        CHAT_CONTEXT: '{"topic":"first"}',
      });

      // Try duplicate
      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'discuss-test-duplicate',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Discuss 2',
        CHAT_MEMBERS: '["ou_test123"]',
        CHAT_CONTEXT: '{"topic":"second"}',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });
  });

  describe('query discussion status', () => {
    it('should query pending discussion chat', async () => {
      // Create a discussion chat
      await runScript('skills/chat/create.ts', {
        CHAT_ID: 'discuss-test-query-1',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Discuss: test',
        CHAT_MEMBERS: '["ou_test123"]',
        CHAT_CONTEXT: '{"topic":"test topic"}',
      });

      const result = await runScript('skills/chat/query.ts', {
        CHAT_ID: 'discuss-test-query-1',
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.status).toBe('pending');
      expect(data.chatId).toBeNull();
      expect(data.context.topic).toBe('test topic');
    });
  });
});
