/**
 * Tests for start-discussion.ts
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

// Helper to run a script with environment variables
async function runScript(
  script: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
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

// Track created files for cleanup
const createdFiles: string[] = [];

async function cleanupTestFiles() {
  // Clean up files matching test patterns
  for (const file of createdFiles) {
    try {
      await rm(resolve(CHAT_DIR, file), { force: true });
      await rm(resolve(CHAT_DIR, `${file}.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
  createdFiles.length = 0;
}

// Track created IDs by capturing from output
function extractChatId(stdout: string): string | null {
  const match = stdout.match(/CHAT_ID: (.+)/);
  return match ? match[1].trim() : null;
}

describe('start-discussion', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('create discussion', () => {
    it('should create a discussion chat file with auto-generated ID', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Should we automate code formatting?',
        DISCUSSION_MEMBERS: '["ou_test123"]',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK:');
      expect(result.stdout).toContain('CHAT_ID: discuss-');

      const chatId = extractChatId(result.stdout);
      expect(chatId).not.toBeNull();
      if (chatId) {
        createdFiles.push(`${chatId}.json`);
      }

      // Verify file was created with correct content
      const content = await readFile(resolve(CHAT_DIR, `${chatId}.json`), 'utf-8');
      const data = JSON.parse(content);

      expect(data.status).toBe('pending');
      expect(data.chatId).toBeNull();
      // '?' is sanitized to space by topicToGroupName (not in GROUP_NAME_REGEX allowlist)
      expect(data.createGroup.name).toBe('Should we automate code formatting');
      expect(data.createGroup.members).toEqual(['ou_test123']);
      // Full topic (with '?') is preserved in context.discussionTopic
      expect(data.context.discussionTopic).toBe('Should we automate code formatting?');
      expect(data.triggerMode).toBe('always');
      expect(data.response).toBeNull();
      expect(data.activationAttempts).toBe(0);
    });

    it('should create a discussion with custom ID', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Test Topic',
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_ID: 'test-disc-1',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('CHAT_ID: test-disc-1');
      createdFiles.push('test-disc-1.json');

      const content = await readFile(resolve(CHAT_DIR, 'test-disc-1.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.id).toBe('test-disc-1');
    });

    it('should accept custom expiry hours', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Test Topic',
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_ID: 'test-disc-2',
        DISCUSSION_EXPIRES_HOURS: '48',
      });

      expect(result.code).toBe(0);
      createdFiles.push('test-disc-2.json');

      const content = await readFile(resolve(CHAT_DIR, 'test-disc-2.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.id).toBe('test-disc-2');

      // Verify expiresAt is approximately 48 hours from now
      const expiresAt = new Date(data.expiresAt);
      const now = new Date();
      const diffHours = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThan(47);
      expect(diffHours).toBeLessThan(49);
    });

    it('should accept discussion context', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Test Topic',
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_ID: 'test-disc-3',
        DISCUSSION_CONTEXT: '{"evidence": "User corrected 5 times", "options": ["A", "B"]}',
      });

      expect(result.code).toBe(0);
      createdFiles.push('test-disc-3.json');

      const content = await readFile(resolve(CHAT_DIR, 'test-disc-3.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.context.evidence).toBe('User corrected 5 times');
      expect(data.context.options).toEqual(['A', 'B']);
      expect(data.context.discussionTopic).toBe('Test Topic');
    });

    it('should truncate long topics for group name', async () => {
      const longTopic = 'A'.repeat(100);
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: longTopic,
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_ID: 'test-disc-4',
      });

      expect(result.code).toBe(0);
      createdFiles.push('test-disc-4.json');

      const content = await readFile(resolve(CHAT_DIR, 'test-disc-4.json'), 'utf-8');
      const data = JSON.parse(content);
      // Group name should be truncated to 64 chars
      expect(Array.from(data.createGroup.name).length).toBeLessThanOrEqual(64);
      // But the full topic should be preserved in context
      expect(data.context.discussionTopic).toBe(longTopic);
    });

    it('should use default 24h expiry when not specified', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Test Topic',
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_ID: 'test-disc-5',
      });

      expect(result.code).toBe(0);
      createdFiles.push('test-disc-5.json');

      const content = await readFile(resolve(CHAT_DIR, 'test-disc-5.json'), 'utf-8');
      const data = JSON.parse(content);

      const expiresAt = new Date(data.expiresAt);
      const now = new Date();
      const diffHours = (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60);
      expect(diffHours).toBeGreaterThan(23);
      expect(diffHours).toBeLessThan(25);
    });
  });

  describe('validation', () => {
    it('should reject missing DISCUSSION_TOPIC', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_MEMBERS: '["ou_test123"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('DISCUSSION_TOPIC');
    });

    it('should reject empty DISCUSSION_TOPIC', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: '   ',
        DISCUSSION_MEMBERS: '["ou_test123"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('DISCUSSION_TOPIC');
    });

    it('should reject missing DISCUSSION_MEMBERS', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Test Topic',
      });

      expect(result.code).toBe(1);
      // Error comes from shared schema validation (validateMembers)
      expect(result.stderr).toContain('CHAT_MEMBERS');
    });

    it('should reject invalid member format', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Test Topic',
        DISCUSSION_MEMBERS: '["invalid_member"]',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('ou_xxxxx');
    });

    it('should reject invalid DISCUSSION_CONTEXT', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Test Topic',
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_CONTEXT: 'not valid json',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('DISCUSSION_CONTEXT');
    });

    it('should reject duplicate discussion ID', async () => {
      // Create first
      await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'First',
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_ID: 'test-disc-dup',
      });
      createdFiles.push('test-disc-dup.json');

      // Try duplicate
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Second',
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_ID: 'test-disc-dup',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should reject negative DISCUSSION_EXPIRES_HOURS', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Test Topic',
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_EXPIRES_HOURS: '-1',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('DISCUSSION_EXPIRES_HOURS');
    });

    it('should reject DISCUSSION_EXPIRES_HOURS exceeding 7 days', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Test Topic',
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_EXPIRES_HOURS: '200',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('7 days');
    });

    it('should reject invalid DISCUSSION_ID format', async () => {
      const result = await runScript('skills/start-discussion/start-discussion.ts', {
        DISCUSSION_TOPIC: 'Test Topic',
        DISCUSSION_MEMBERS: '["ou_test123"]',
        DISCUSSION_ID: '.hidden-file',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('chat ID');
    });
  });
});
