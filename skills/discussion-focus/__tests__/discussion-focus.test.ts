/**
 * Tests for the discussion-focus skill and SOUL profile.
 *
 * Validates:
 * 1. souls/discussion.md exists and has required personality sections
 * 2. skills/discussion-focus/SKILL.md exists with correct frontmatter
 * 3. Discussion chat integration (creating + querying a discussion chat)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');

// --- Soul Profile Tests ---

describe('souls/discussion.md', () => {
  const soulPath = resolve(PROJECT_ROOT, 'souls/discussion.md');

  it('should exist', async () => {
    const content = await readFile(soulPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('should have a title', async () => {
    const content = await readFile(soulPath, 'utf-8');
    expect(content).toContain('# Discussion SOUL');
  });

  it('should define core truths / principles', async () => {
    const content = await readFile(soulPath, 'utf-8');
    expect(content).toContain('Stay on topic');
    expect(content).toContain('Core Truths');
  });

  it('should define boundaries', async () => {
    const content = await readFile(soulPath, 'utf-8');
    expect(content).toContain('Boundaries');
    expect(content).toMatch(/don't chase every interesting tangent/i);
  });

  it('should define progress tracking behavior', async () => {
    const content = await readFile(soulPath, 'utf-8');
    expect(content).toContain('Progress Tracking');
    expect(content).toMatch(/Are we still answering the original question/);
  });

  it('should define redirect behavior', async () => {
    const content = await readFile(soulPath, 'utf-8');
    expect(content).toMatch(/redirect/i);
    expect(content).toMatch(/north star/i);
  });

  it('should be under 3000 characters (reasonable size for system prompt)', async () => {
    const content = await readFile(soulPath, 'utf-8');
    expect(content.length).toBeLessThan(3000);
  });
});

// --- SKILL.md Tests ---

describe('skills/discussion-focus/SKILL.md', () => {
  const skillPath = resolve(PROJECT_ROOT, 'skills/discussion-focus/SKILL.md');

  it('should exist', async () => {
    const content = await readFile(skillPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('should have valid frontmatter with name', async () => {
    const content = await readFile(skillPath, 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: discussion-focus');
  });

  it('should have a description with relevant keywords', async () => {
    const content = await readFile(skillPath, 'utf-8');
    expect(content).toContain('discussion focus');
    expect(content).toMatch(/stay on topic/i);
  });

  it('should be user-invocable: false (auto-activated only)', async () => {
    const content = await readFile(skillPath, 'utf-8');
    expect(content).toContain('user-invocable: false');
  });

  it('should reference start-discussion integration', async () => {
    const content = await readFile(skillPath, 'utf-8');
    expect(content).toContain('start-discussion');
  });

  it('should reference the SOUL profile file', async () => {
    const content = await readFile(skillPath, 'utf-8');
    expect(content).toContain('souls/discussion.md');
  });

  it('should include redirect strategies', async () => {
    const content = await readFile(skillPath, 'utf-8');
    expect(content).toContain('Redirecting Strategies');
  });

  it('should include DO NOT section', async () => {
    const content = await readFile(skillPath, 'utf-8');
    expect(content).toContain('## DO NOT');
    expect(content).toMatch(/❌.*chase every interesting tangent/i);
  });

  it('should include discussion workflow steps', async () => {
    const content = await readFile(skillPath, 'utf-8');
    expect(content).toContain('Step 1: Identify Discussion Context');
    expect(content).toContain('Step 2: Engage in Discussion');
    expect(content).toContain('Step 3: Periodic Progress Check');
    expect(content).toContain('Step 4: Close Discussion');
  });

  it('should reference chat scripts for integration', async () => {
    const content = await readFile(skillPath, 'utf-8');
    expect(content).toContain('skills/chat/query.ts');
    expect(content).toContain('skills/chat/list.ts');
    expect(content).toContain('skills/chat/response.ts');
  });
});

// --- Chat Integration Tests ---

describe('discussion chat integration', () => {
  const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');
  const TEST_CHAT_ID = 'test-discussion-focus-1';

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

  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    try {
      await rm(resolve(CHAT_DIR, `${TEST_CHAT_ID}.json`), { force: true });
      await rm(resolve(CHAT_DIR, `${TEST_CHAT_ID}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  });

  afterEach(async () => {
    try {
      await rm(resolve(CHAT_DIR, `${TEST_CHAT_ID}.json`), { force: true });
      await rm(resolve(CHAT_DIR, `${TEST_CHAT_ID}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  });

  it('should create a discussion chat with topic context', async () => {
    const result = await runScript('skills/chat/create.ts', {
      CHAT_ID: TEST_CHAT_ID,
      CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
      CHAT_GROUP_NAME: 'Discussion: Auto-format code',
      CHAT_MEMBERS: '["ou_developer1", "ou_developer2"]',
      CHAT_CONTEXT: JSON.stringify({
        topic: 'Should we automate code formatting?',
        background: 'Team has inconsistent code styles causing review friction',
        suggestedActions: ['Adopt Prettier', 'Adopt ESLint auto-fix', 'Keep manual formatting'],
        source: 'start-discussion',
      }),
    });

    expect(result.code).toBe(0);

    // Verify context contains discussion fields
    const content = await readFile(resolve(CHAT_DIR, `${TEST_CHAT_ID}.json`), 'utf-8');
    const data = JSON.parse(content);
    expect(data.context.topic).toBe('Should we automate code formatting?');
    expect(data.context.background).toBeTruthy();
    expect(data.context.suggestedActions).toHaveLength(3);
    expect(data.context.source).toBe('start-discussion');
  });

  it('should query a discussion chat and return topic context', async () => {
    // Create a discussion chat manually
    const chatData = {
      id: TEST_CHAT_ID,
      status: 'active',
      chatId: 'oc_discussion_group',
      createdAt: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      expiresAt: '2099-12-31T23:59:59Z',
      expiredAt: null,
      createGroup: { name: 'Discussion: Test Topic', members: ['ou_test'] },
      context: {
        topic: 'Should we use microservices?',
        background: 'Monolith is getting complex',
        suggestedActions: ['Migrate to microservices', 'Use modular monolith', 'Keep current architecture'],
        source: 'start-discussion',
      },
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };
    await writeFile(resolve(CHAT_DIR, `${TEST_CHAT_ID}.json`), JSON.stringify(chatData, null, 2), 'utf-8');

    // Query it
    const result = await runScript('skills/chat/query.ts', {
      CHAT_ID: TEST_CHAT_ID,
    });

    expect(result.code).toBe(0);
    const data = JSON.parse(result.stdout);
    expect(data.context.topic).toBe('Should we use microservices?');
    expect(data.context.source).toBe('start-discussion');
  });

  it('should record discussion outcome via response', async () => {
    // Create active discussion chat
    const chatData = {
      id: TEST_CHAT_ID,
      status: 'active',
      chatId: 'oc_discussion_group',
      createdAt: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      expiresAt: '2099-12-31T23:59:59Z',
      expiredAt: null,
      createGroup: { name: 'Discussion', members: ['ou_test'] },
      context: { topic: 'Test topic' },
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };
    await writeFile(resolve(CHAT_DIR, `${TEST_CHAT_ID}.json`), JSON.stringify(chatData, null, 2), 'utf-8');

    // Record discussion outcome
    const result = await runScript('skills/chat/response.ts', {
      CHAT_ID: TEST_CHAT_ID,
      CHAT_RESPONSE: 'Discussion concluded: Team decided to adopt Prettier with shared config.',
      CHAT_RESPONDER: 'ou_developer1',
    });

    expect(result.code).toBe(0);

    // Verify outcome was recorded
    const content = await readFile(resolve(CHAT_DIR, `${TEST_CHAT_ID}.json`), 'utf-8');
    const data = JSON.parse(content);
    expect(data.response.content).toContain('Discussion concluded');
  });
});
