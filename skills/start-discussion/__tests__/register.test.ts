/**
 * Tests for start-discussion/register.ts — Register an active discussion chat.
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
  'test-reg-1',
  'test-reg-dup',
  'test-reg-trigger',
  'test-reg-mention',
  'test-reg-context',
  'test-reg-focus',
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

describe('start-discussion register', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  const baseEnv = {
    CHAT_ID: 'test-reg-1',
    CHAT_FEISHU_ID: 'oc_abc123def',
    CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
    CHAT_GROUP_NAME: 'Test Discussion',
    CHAT_MEMBERS: '["ou_user1"]',
  };

  it('should register an active chat with valid inputs', async () => {
    const result = await runScript('skills/start-discussion/register.ts', baseEnv);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('OK');
    expect(result.stdout).toContain('active');

    // Verify file content
    const content = await readFile(resolve(CHAT_DIR, 'test-reg-1.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.id).toBe('test-reg-1');
    expect(data.status).toBe('active');
    expect(data.chatId).toBe('oc_abc123def');
    expect(data.createGroup.name).toBe('Test Discussion');
    expect(data.createGroup.members).toEqual(['ou_user1']);
    expect(data.triggerMode).toBe('always'); // default
    expect(data.activatedAt).toBeTruthy();
    expect(data.response).toBeNull();
    expect(data.activationAttempts).toBe(0);
    expect(data.expiredAt).toBeNull();
    expect(data.failedAt).toBeNull();
  });

  it('should reject missing CHAT_ID', async () => {
    const { CHAT_ID: _, ...envWithoutId } = baseEnv;
    const result = await runScript('skills/start-discussion/register.ts', envWithoutId);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CHAT_ID');
  });

  it('should reject missing CHAT_FEISHU_ID', async () => {
    const { CHAT_FEISHU_ID: _, ...envWithoutFeishuId } = baseEnv;
    const result = await runScript('skills/start-discussion/register.ts', envWithoutFeishuId);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CHAT_FEISHU_ID');
  });

  it('should reject invalid Feishu chat ID format', async () => {
    const result = await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_FEISHU_ID: 'invalid_id',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('oc_xxxxx');
  });

  it('should reject duplicate chat ID', async () => {
    // Register first
    await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_ID: 'test-reg-dup',
    });

    // Try duplicate
    const result = await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_ID: 'test-reg-dup',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('already exists');
  });

  it('should default triggerMode to "always"', async () => {
    const result = await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_ID: 'test-reg-trigger',
    });

    expect(result.code).toBe(0);
    const content = await readFile(resolve(CHAT_DIR, 'test-reg-trigger.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.triggerMode).toBe('always');
  });

  it('should accept triggerMode "mention"', async () => {
    const result = await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_ID: 'test-reg-mention',
      CHAT_TRIGGER_MODE: 'mention',
    });

    expect(result.code).toBe(0);
    const content = await readFile(resolve(CHAT_DIR, 'test-reg-mention.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.triggerMode).toBe('mention');
  });

  it('should reject invalid CHAT_TRIGGER_MODE', async () => {
    const result = await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_TRIGGER_MODE: 'invalid',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('CHAT_TRIGGER_MODE');
  });

  it('should store context in chat file', async () => {
    const result = await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_ID: 'test-reg-context',
      CHAT_CONTEXT: '{"topic": "code formatting", "initialMessage": "Should we use Prettier?"}',
    });

    expect(result.code).toBe(0);
    const content = await readFile(resolve(CHAT_DIR, 'test-reg-context.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.context.topic).toBe('code formatting');
    expect(data.context.initialMessage).toBe('Should we use Prettier?');
  });

  it('should reject invalid CHAT_EXPIRES_AT format', async () => {
    const result = await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_EXPIRES_AT: '2026-04-18',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('UTC Z-suffix');
  });

  it('should reject invalid member format', async () => {
    const result = await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_MEMBERS: '["bad_id"]',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('ou_xxxxx');
  });

  it('should truncate long group names', async () => {
    const longName = 'A'.repeat(100);
    const result = await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_GROUP_NAME: longName,
    });

    expect(result.code).toBe(0);
    const content = await readFile(resolve(CHAT_DIR, 'test-reg-1.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.createGroup.name.length).toBeLessThanOrEqual(64);
  });

  it('should set createdAt and activatedAt to the same timestamp', async () => {
    const result = await runScript('skills/start-discussion/register.ts', baseEnv);

    expect(result.code).toBe(0);
    const content = await readFile(resolve(CHAT_DIR, 'test-reg-1.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.createdAt).toBeTruthy();
    expect(data.activatedAt).toBeTruthy();
    // Should be very close (same second)
    expect(Math.abs(new Date(data.createdAt).getTime() - new Date(data.activatedAt).getTime()))
      .toBeLessThan(2000);
  });

  it('should store discussion focus context for #1228', async () => {
    const result = await runScript('skills/start-discussion/register.ts', {
      ...baseEnv,
      CHAT_ID: 'test-reg-focus',
      CHAT_CONTEXT: JSON.stringify({
        topic: 'code formatting',
        initialMessage: 'Should we use Prettier?',
        discussionFocus: true,
      }),
    });

    expect(result.code).toBe(0);
    const content = await readFile(resolve(CHAT_DIR, 'test-reg-focus.json'), 'utf-8');
    const data = JSON.parse(content);
    expect(data.context.discussionFocus).toBe(true);
    expect(data.context.topic).toBe('code formatting');
  });
});
