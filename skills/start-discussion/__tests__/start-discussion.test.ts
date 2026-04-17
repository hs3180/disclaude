/**
 * Integration tests for the start-discussion workflow.
 *
 * Tests the discussion creation flow using the underlying chat skill scripts:
 * - Creating a discussion chat with discussion-specific context
 * - Querying discussion status
 * - Recording discussion responses
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
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
  'discuss-test-topic-1000',
  'discuss-test-query-1000',
  'discuss-test-response-1000',
  'discuss-test-lifecycle-1000',
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

const DISCUSSION_CONTEXT = {
  type: 'discussion',
  topic: 'Output format preference',
  background: 'User has corrected output format 3 times, need to confirm long-term preference',
  question: 'What is your preferred default output format?',
  sourceChatId: 'oc_test_chat',
  suggestedActions: ['Create format-preference Skill', 'Update CLAUDE.md'],
};

describe('start-discussion workflow', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('create discussion', () => {
    it('should create a discussion chat with discussion-specific context', async () => {
      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'discuss-test-topic-1000',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Discussion: Output Format',
        CHAT_MEMBERS: '["ou_user123"]',
        CHAT_CONTEXT: JSON.stringify(DISCUSSION_CONTEXT),
        CHAT_TRIGGER_MODE: 'mention',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      // Verify file content matches discussion schema
      const content = await readFile(resolve(CHAT_DIR, 'discuss-test-topic-1000.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.id).toBe('discuss-test-topic-1000');
      expect(data.status).toBe('pending');
      expect(data.createGroup.name).toBe('Discussion: Output Format');
      expect(data.createGroup.members).toEqual(['ou_user123']);
      expect(data.triggerMode).toBe('mention');

      // Verify discussion context
      expect(data.context.type).toBe('discussion');
      expect(data.context.topic).toBe('Output format preference');
      expect(data.context.background).toBeTruthy();
      expect(data.context.question).toBeTruthy();
      expect(data.context.suggestedActions).toBeInstanceOf(Array);
      expect(data.context.suggestedActions.length).toBeGreaterThan(0);
    });

    it('should create discussion with minimal context', async () => {
      const minimalContext = {
        type: 'discussion',
        topic: 'Test Topic',
      };

      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'discuss-test-topic-1000',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Discussion: Test',
        CHAT_MEMBERS: '["ou_user123"]',
        CHAT_CONTEXT: JSON.stringify(minimalContext),
      });

      expect(result.code).toBe(0);
      const content = await readFile(resolve(CHAT_DIR, 'discuss-test-topic-1000.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.context.type).toBe('discussion');
      expect(data.context.topic).toBe('Test Topic');
    });

    it('should support multiple discussion members', async () => {
      const result = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'discuss-test-topic-1000',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Discussion: Architecture Decision',
        CHAT_MEMBERS: '["ou_user1", "ou_user2", "ou_user3"]',
        CHAT_CONTEXT: JSON.stringify({
          type: 'discussion',
          topic: 'Architecture Decision',
          background: 'Need multi-party confirmation',
          question: 'Which approach should we use?',
        }),
      });

      expect(result.code).toBe(0);
      const content = await readFile(resolve(CHAT_DIR, 'discuss-test-topic-1000.json'), 'utf-8');
      const data = JSON.parse(content);
      expect(data.createGroup.members).toEqual(['ou_user1', 'ou_user2', 'ou_user3']);
    });
  });

  describe('query discussion', () => {
    beforeEach(async () => {
      const chatData = {
        id: 'discuss-test-query-1000',
        status: 'active',
        chatId: 'oc_discussion_group',
        createdAt: '2026-01-01T00:00:00Z',
        activatedAt: '2026-01-01T00:01:00Z',
        expiresAt: '2099-12-31T23:59:59Z',
        expiredAt: null,
        createGroup: { name: 'Discussion: Output Format', members: ['ou_user123'] },
        context: DISCUSSION_CONTEXT,
        triggerMode: 'mention',
        response: null,
        activationAttempts: 0,
        lastActivationError: null,
        failedAt: null,
      };
      await writeFile(
        resolve(CHAT_DIR, 'discuss-test-query-1000.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );
    });

    it('should query an active discussion', async () => {
      const result = await runScript('skills/chat/query.ts', {
        CHAT_ID: 'discuss-test-query-1000',
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.status).toBe('active');
      expect(data.chatId).toBe('oc_discussion_group');
      expect(data.context.type).toBe('discussion');
      expect(data.context.topic).toBe('Output format preference');
    });

    it('should handle querying a pending discussion', async () => {
      const chatData = {
        id: 'discuss-test-query-1000',
        status: 'pending',
        chatId: null,
        createdAt: '2026-01-01T00:00:00Z',
        activatedAt: null,
        expiresAt: '2099-12-31T23:59:59Z',
        expiredAt: null,
        createGroup: { name: 'Discussion: Output Format', members: ['ou_user123'] },
        context: DISCUSSION_CONTEXT,
        response: null,
        activationAttempts: 0,
        lastActivationError: null,
        failedAt: null,
      };
      await writeFile(
        resolve(CHAT_DIR, 'discuss-test-query-1000.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );

      const result = await runScript('skills/chat/query.ts', {
        CHAT_ID: 'discuss-test-query-1000',
      });

      expect(result.code).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.status).toBe('pending');
      expect(data.chatId).toBeNull();
    });
  });

  describe('record discussion response', () => {
    beforeEach(async () => {
      const chatData = {
        id: 'discuss-test-response-1000',
        status: 'active',
        chatId: 'oc_discussion_group',
        createdAt: '2026-01-01T00:00:00Z',
        activatedAt: '2026-01-01T00:01:00Z',
        expiresAt: '2099-12-31T23:59:59Z',
        expiredAt: null,
        createGroup: { name: 'Discussion: Output Format', members: ['ou_user123'] },
        context: DISCUSSION_CONTEXT,
        triggerMode: 'mention',
        response: null,
        activationAttempts: 0,
        lastActivationError: null,
        failedAt: null,
      };
      await writeFile(
        resolve(CHAT_DIR, 'discuss-test-response-1000.json'),
        JSON.stringify(chatData, null, 2),
        'utf-8',
      );
    });

    it('should record a user response to a discussion', async () => {
      const result = await runScript('skills/chat/response.ts', {
        CHAT_ID: 'discuss-test-response-1000',
        CHAT_RESPONSE: 'I prefer Markdown format with headers and code blocks',
        CHAT_RESPONDER: 'ou_user123',
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('OK');

      // Verify response was recorded
      const content = await readFile(
        resolve(CHAT_DIR, 'discuss-test-response-1000.json'),
        'utf-8',
      );
      const data = JSON.parse(content);
      expect(data.response).not.toBeNull();
      expect(data.response!.content).toBe('I prefer Markdown format with headers and code blocks');
      expect(data.response!.responder).toBe('ou_user123');
    });
  });

  describe('discussion lifecycle', () => {
    it('should follow full discussion lifecycle: create -> activate -> respond', async () => {
      // Step 1: Create pending discussion
      const createResult = await runScript('skills/chat/create.ts', {
        CHAT_ID: 'discuss-test-lifecycle-1000',
        CHAT_EXPIRES_AT: '2099-12-31T23:59:59Z',
        CHAT_GROUP_NAME: 'Discussion: Lifecycle Test',
        CHAT_MEMBERS: '["ou_tester"]',
        CHAT_CONTEXT: JSON.stringify({
          type: 'discussion',
          topic: 'Lifecycle Test',
          background: 'Testing full workflow',
          question: 'Is the flow working?',
        }),
      });
      expect(createResult.code).toBe(0);

      // Verify pending state
      let content = await readFile(resolve(CHAT_DIR, 'discuss-test-lifecycle-1000.json'), 'utf-8');
      let data = JSON.parse(content);
      expect(data.status).toBe('pending');
      expect(data.chatId).toBeNull();

      // Step 2: Simulate activation (schedule would do this via lark-cli)
      data.status = 'active';
      data.chatId = 'oc_lifecycle_test';
      data.activatedAt = '2026-04-18T10:00:00Z';
      await writeFile(
        resolve(CHAT_DIR, 'discuss-test-lifecycle-1000.json'),
        JSON.stringify(data, null, 2),
        'utf-8',
      );

      // Query active discussion
      const queryResult = await runScript('skills/chat/query.ts', {
        CHAT_ID: 'discuss-test-lifecycle-1000',
      });
      expect(queryResult.code).toBe(0);
      const queried = JSON.parse(queryResult.stdout);
      expect(queried.status).toBe('active');
      expect(queried.chatId).toBe('oc_lifecycle_test');

      // Step 3: Record user response
      const responseResult = await runScript('skills/chat/response.ts', {
        CHAT_ID: 'discuss-test-lifecycle-1000',
        CHAT_RESPONSE: 'Flow is working correctly, confirmed',
        CHAT_RESPONDER: 'ou_tester',
      });
      expect(responseResult.code).toBe(0);

      // Verify final state
      content = await readFile(resolve(CHAT_DIR, 'discuss-test-lifecycle-1000.json'), 'utf-8');
      data = JSON.parse(content);
      expect(data.response!.content).toBe('Flow is working correctly, confirmed');
      expect(data.response!.responder).toBe('ou_tester');
    });
  });
});
