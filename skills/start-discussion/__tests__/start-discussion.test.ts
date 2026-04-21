/**
 * Integration tests for start-discussion script.
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

async function runScript(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'skills/start-discussion/start-discussion.ts');
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
  'discuss-test-dup',
  'discuss-test-no-topic',
  'discuss-test-no-members',
  'discuss-test-no-context',
  'discuss-test-custom-expiry',
  'discuss-test-invalid-id',
  'discuss-test-invalid-members',
  'discuss-test-long-context',
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

describe('start-discussion script', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  it('creates a pending discussion chat with defaults', async () => {
    const result = await runScript({
      DISCUSSION_ID: 'discuss-test-1',
      DISCUSSION_TOPIC: 'Code Style Discussion',
      DISCUSSION_CONTEXT: 'Should we use tabs or spaces?',
      DISCUSSION_MEMBERS: '["ou_user1","ou_user2"]',
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("OK: Discussion 'discuss-test-1' created");
    expect(result.stdout).toContain('Code Style Discussion');
    expect(result.stdout).toContain('pending');

    // Verify the file was created with correct content
    const content = await readFile(resolve(CHAT_DIR, 'discuss-test-1.json'), 'utf-8');
    const data = JSON.parse(content);

    expect(data.id).toBe('discuss-test-1');
    expect(data.status).toBe('pending');
    expect(data.chatId).toBeNull();
    expect(data.createGroup.name).toBe('Code Style Discussion');
    expect(data.createGroup.members).toEqual(['ou_user1', 'ou_user2']);
    expect(data.context.type).toBe('discussion');
    expect(data.context.topic).toBe('Code Style Discussion');
    expect(data.context.discussionContext).toBe('Should we use tabs or spaces?');
    expect(data.response).toBeNull();
    expect(data.activationAttempts).toBe(0);
    // Default expiry is 24 hours
    expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('creates with custom expiry hours', async () => {
    const result = await runScript({
      DISCUSSION_ID: 'discuss-test-custom-expiry',
      DISCUSSION_TOPIC: 'Quick Decision',
      DISCUSSION_CONTEXT: 'Need a fast answer',
      DISCUSSION_MEMBERS: '["ou_user1"]',
      DISCUSSION_EXPIRES_HOURS: '2',
    });

    expect(result.code).toBe(0);

    const content = await readFile(resolve(CHAT_DIR, 'discuss-test-custom-expiry.json'), 'utf-8');
    const data = JSON.parse(content);

    // Expiry should be approximately 2 hours from now
    const expiresAt = new Date(data.expiresAt).getTime();
    const twoHoursFromNow = Date.now() + 2 * 60 * 60 * 1000;
    const tolerance = 5000; // 5 seconds tolerance
    expect(expiresAt).toBeGreaterThan(twoHoursFromNow - tolerance);
    expect(expiresAt).toBeLessThan(twoHoursFromNow + tolerance);
  });

  it('rejects missing DISCUSSION_ID', async () => {
    const result = await runScript({
      DISCUSSION_TOPIC: 'Test',
      DISCUSSION_CONTEXT: 'Test context',
      DISCUSSION_MEMBERS: '["ou_user1"]',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DISCUSSION_ID');
  });

  it('rejects missing DISCUSSION_TOPIC', async () => {
    const result = await runScript({
      DISCUSSION_ID: 'discuss-test-no-topic',
      DISCUSSION_CONTEXT: 'Test context',
      DISCUSSION_MEMBERS: '["ou_user1"]',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DISCUSSION_TOPIC');
  });

  it('rejects missing DISCUSSION_CONTEXT', async () => {
    const result = await runScript({
      DISCUSSION_ID: 'discuss-test-no-context',
      DISCUSSION_TOPIC: 'Test Topic',
      DISCUSSION_MEMBERS: '["ou_user1"]',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DISCUSSION_CONTEXT');
  });

  it('rejects missing DISCUSSION_MEMBERS', async () => {
    const result = await runScript({
      DISCUSSION_ID: 'discuss-test-no-members',
      DISCUSSION_TOPIC: 'Test Topic',
      DISCUSSION_CONTEXT: 'Test context',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DISCUSSION_MEMBERS');
  });

  it('rejects invalid DISCUSSION_ID (path traversal)', async () => {
    const result = await runScript({
      DISCUSSION_ID: '../etc/passwd',
      DISCUSSION_TOPIC: 'Test Topic',
      DISCUSSION_CONTEXT: 'Test context',
      DISCUSSION_MEMBERS: '["ou_user1"]',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Invalid');
  });

  it('rejects invalid member IDs', async () => {
    const result = await runScript({
      DISCUSSION_ID: 'discuss-test-invalid-members',
      DISCUSSION_TOPIC: 'Test Topic',
      DISCUSSION_CONTEXT: 'Test context',
      DISCUSSION_MEMBERS: '["invalid_id"]',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ou_xxxxx');
  });

  it('rejects duplicate discussion ID', async () => {
    // Create first discussion
    const result1 = await runScript({
      DISCUSSION_ID: 'discuss-test-dup',
      DISCUSSION_TOPIC: 'First Discussion',
      DISCUSSION_CONTEXT: 'First context',
      DISCUSSION_MEMBERS: '["ou_user1"]',
    });
    expect(result1.code).toBe(0);

    // Try to create duplicate
    const result2 = await runScript({
      DISCUSSION_ID: 'discuss-test-dup',
      DISCUSSION_TOPIC: 'Second Discussion',
      DISCUSSION_CONTEXT: 'Second context',
      DISCUSSION_MEMBERS: '["ou_user1"]',
    });
    expect(result2.code).toBe(1);
    expect(result2.stderr).toContain('already exists');
  });

  it('rejects overly long context', async () => {
    const longContext = 'x'.repeat(8001);
    const result = await runScript({
      DISCUSSION_ID: 'discuss-test-long-context',
      DISCUSSION_TOPIC: 'Test Topic',
      DISCUSSION_CONTEXT: longContext,
      DISCUSSION_MEMBERS: '["ou_user1"]',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('too long');
  });
});
