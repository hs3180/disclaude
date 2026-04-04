/**
 * Integration tests for chat scripts (create, query, list, response).
 *
 * Tests run scripts as child processes from PROJECT_ROOT, using unique test IDs
 * to avoid conflicts. Test files are cleaned up in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

// Use timestamp-based unique IDs to avoid test collisions
const TEST_PREFIX = `test-${Date.now()}`;

async function runScript(
  scriptName: string,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'scripts/chat', `${scriptName}.ts`);
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

async function cleanupChatFiles(...ids: string[]) {
  for (const id of ids) {
    try {
      await rm(resolve(CHAT_DIR, `${id}.json`), { force: true });
      await rm(resolve(CHAT_DIR, `${id}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
}

// ---- create.ts ----

describe('create.ts', () => {
  const id = `${TEST_PREFIX}-create`;

  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupChatFiles(id);
  });

  afterEach(async () => {
    await cleanupChatFiles(id);
  });

  it('creates a pending chat file', async () => {
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    const { stdout, code } = await runScript('create', {
      CHAT_ID: id,
      CHAT_EXPIRES_AT: futureExpiry,
      CHAT_GROUP_NAME: 'PR #123 Review',
      CHAT_MEMBERS: JSON.stringify(['ou_developer']),
    });

    expect(code).toBe(0);
    expect(stdout).toContain('OK');

    const content = await readFile(resolve(CHAT_DIR, `${id}.json`), 'utf-8');
    const chat = JSON.parse(content);
    expect(chat.id).toBe(id);
    expect(chat.status).toBe('pending');
    expect(chat.chatId).toBeNull();
    expect(chat.createGroup.name).toBe('PR #123 Review');
    expect(chat.createGroup.members).toEqual(['ou_developer']);
    expect(chat.response).toBeNull();
  });

  it('creates a chat with context', async () => {
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    const ctxId = `${id}-ctx`;
    const { code } = await runScript('create', {
      CHAT_ID: ctxId,
      CHAT_EXPIRES_AT: futureExpiry,
      CHAT_GROUP_NAME: 'Deploy Review',
      CHAT_MEMBERS: JSON.stringify(['ou_user1', 'ou_user2']),
      CHAT_CONTEXT: JSON.stringify({ env: 'staging', version: '2.0' }),
    });

    expect(code).toBe(0);
    const content = await readFile(resolve(CHAT_DIR, `${ctxId}.json`), 'utf-8');
    const chat = JSON.parse(content);
    expect(chat.context).toEqual({ env: 'staging', version: '2.0' });
    expect(chat.createGroup.members).toEqual(['ou_user1', 'ou_user2']);

    await cleanupChatFiles(ctxId);
  });

  it('rejects duplicate chat ID', async () => {
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();
    const env = {
      CHAT_ID: id,
      CHAT_EXPIRES_AT: futureExpiry,
      CHAT_GROUP_NAME: 'Dup Test',
      CHAT_MEMBERS: JSON.stringify(['ou_user']),
    };

    const first = await runScript('create', env);
    expect(first.code).toBe(0);

    const second = await runScript('create', env);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('already exists');
  });

  it('rejects missing CHAT_ID', async () => {
    const { code, stderr } = await runScript('create', {
      CHAT_EXPIRES_AT: '2099-01-01T00:00:00Z',
      CHAT_GROUP_NAME: 'Test',
      CHAT_MEMBERS: JSON.stringify(['ou_user']),
    });
    expect(code).toBe(1);
    expect(stderr).toContain('CHAT_ID');
  });

  it('rejects invalid expiresAt format', async () => {
    const { code, stderr } = await runScript('create', {
      CHAT_ID: `${id}-bad-exp`,
      CHAT_EXPIRES_AT: '2026-03-25T10:00:00+08:00',
      CHAT_GROUP_NAME: 'Test',
      CHAT_MEMBERS: JSON.stringify(['ou_user']),
    });
    expect(code).toBe(1);
    expect(stderr).toContain('UTC Z-suffix');
    await cleanupChatFiles(`${id}-bad-exp`);
  });

  it('rejects invalid member format', async () => {
    const { code, stderr } = await runScript('create', {
      CHAT_ID: `${id}-bad-mem`,
      CHAT_EXPIRES_AT: '2099-01-01T00:00:00Z',
      CHAT_GROUP_NAME: 'Test',
      CHAT_MEMBERS: JSON.stringify(['not_ou_format']),
    });
    expect(code).toBe(1);
    expect(stderr).toContain('ou_xxxxx');
    await cleanupChatFiles(`${id}-bad-mem`);
  });

  it('rejects empty members array', async () => {
    const { code, stderr } = await runScript('create', {
      CHAT_ID: `${id}-empty-mem`,
      CHAT_EXPIRES_AT: '2099-01-01T00:00:00Z',
      CHAT_GROUP_NAME: 'Test',
      CHAT_MEMBERS: JSON.stringify([]),
    });
    expect(code).toBe(1);
    expect(stderr).toContain('non-empty');
    await cleanupChatFiles(`${id}-empty-mem`);
  });

  it('rejects path traversal in chat ID', async () => {
    const { code } = await runScript('create', {
      CHAT_ID: '../etc/passwd',
      CHAT_EXPIRES_AT: '2099-01-01T00:00:00Z',
      CHAT_GROUP_NAME: 'Test',
      CHAT_MEMBERS: JSON.stringify(['ou_user']),
    });
    expect(code).toBe(1);
  });
});

// ---- query.ts ----

describe('query.ts', () => {
  const id = `${TEST_PREFIX}-query`;

  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupChatFiles(id);
  });

  it('queries an existing chat', async () => {
    // Create a test chat file directly
    const chatData = {
      id,
      status: 'pending',
      chatId: null,
      createdAt: new Date().toISOString(),
      activatedAt: null,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      createGroup: { name: 'Test', members: ['ou_user'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };
    await writeFile(resolve(CHAT_DIR, `${id}.json`), JSON.stringify(chatData, null, 2) + '\n');

    const { stdout, code } = await runScript('query', { CHAT_ID: id });
    expect(code).toBe(0);
    const chat = JSON.parse(stdout);
    expect(chat.id).toBe(id);
    expect(chat.status).toBe('pending');
  });

  it('reports chat not found', async () => {
    const { code, stderr } = await runScript('query', { CHAT_ID: 'nonexistent-chat' });
    expect(code).toBe(1);
    expect(stderr).toContain('not found');
  });

  it('rejects invalid chat ID', async () => {
    const { code, stderr } = await runScript('query', { CHAT_ID: '' });
    expect(code).toBe(1);
    expect(stderr).toContain('CHAT_ID');
  });

  it('rejects corrupted JSON file', async () => {
    const corruptedId = `${id}-corrupted`;
    await writeFile(resolve(CHAT_DIR, `${corruptedId}.json`), 'not valid json{');

    const { code, stderr } = await runScript('query', { CHAT_ID: corruptedId });
    expect(code).toBe(1);
    expect(stderr).toContain('not valid JSON');
    await cleanupChatFiles(corruptedId);
  });
});

// ---- list.ts ----

describe('list.ts', () => {
  const ids = [`${TEST_PREFIX}-list-a`, `${TEST_PREFIX}-list-b`, `${TEST_PREFIX}-list-c`];

  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupChatFiles(...ids, `${TEST_PREFIX}-list-bad`, `${TEST_PREFIX}-list-good`, `${TEST_PREFIX}-list-txt`);
  });

  afterEach(async () => {
    await cleanupChatFiles(...ids, `${TEST_PREFIX}-list-bad`, `${TEST_PREFIX}-list-good`, `${TEST_PREFIX}-list-txt`);
  });

  it('lists all chats without filter', async () => {
    for (const [id, status] of [[ids[0], 'pending'], [ids[1], 'active'], [ids[2], 'expired']] as const) {
      const chatData = {
        id, status,
        chatId: status === 'active' ? 'oc_xxx' : null,
        createdAt: new Date().toISOString(),
        activatedAt: status === 'active' ? new Date().toISOString() : null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        createGroup: { name: 'Test', members: ['ou_user'] },
        context: {}, response: null, activationAttempts: 0, lastActivationError: null, failedAt: null,
      };
      await writeFile(resolve(CHAT_DIR, `${id}.json`), JSON.stringify(chatData, null, 2) + '\n');
    }

    const { stdout, code } = await runScript('list');
    expect(code).toBe(0);
    for (const id of ids) {
      expect(stdout).toContain(`${id}.json`);
    }
  });

  it('filters chats by status', async () => {
    for (const [id, status] of [[ids[0], 'pending'], [ids[1], 'active'], [ids[2], 'expired']] as const) {
      const chatData = {
        id, status,
        chatId: status === 'active' ? 'oc_xxx' : null,
        createdAt: new Date().toISOString(),
        activatedAt: status === 'active' ? new Date().toISOString() : null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        createGroup: { name: 'Test', members: ['ou_user'] },
        context: {}, response: null, activationAttempts: 0, lastActivationError: null, failedAt: null,
      };
      await writeFile(resolve(CHAT_DIR, `${id}.json`), JSON.stringify(chatData, null, 2) + '\n');
    }

    const { stdout, code } = await runScript('list', { CHAT_STATUS: 'active' });
    expect(code).toBe(0);
    expect(stdout).toContain(`${ids[1]}.json`);
    expect(stdout).not.toContain(`${ids[0]}.json`);
    expect(stdout).not.toContain(`${ids[2]}.json`);
  });

  it('returns empty output for empty directory', async () => {
    // Don't create any files — directory exists but is empty
    const { stdout, code } = await runScript('list');
    expect(code).toBe(0);
    // Should have no .json lines
    expect(stdout.trim()).toBe('');
  });

  it('rejects invalid status filter', async () => {
    const { code, stderr } = await runScript('list', { CHAT_STATUS: 'invalid' });
    expect(code).toBe(1);
    expect(stderr).toContain('Invalid CHAT_STATUS');
  });

  it('skips corrupted files', async () => {
    const goodId = `${TEST_PREFIX}-list-good`;
    const badId = `${TEST_PREFIX}-list-bad`;

    await writeFile(resolve(CHAT_DIR, `${goodId}.json`), JSON.stringify({
      id: goodId, status: 'pending', expiresAt: '2099-01-01T00:00:00Z',
      createGroup: { name: 'Test', members: ['ou_user'] },
      createdAt: new Date().toISOString(), chatId: null, activatedAt: null,
      context: {}, response: null, activationAttempts: 0, lastActivationError: null, failedAt: null,
    }));
    await writeFile(resolve(CHAT_DIR, `${badId}.json`), 'not json');

    const { stdout, code } = await runScript('list');
    expect(code).toBe(0);
    expect(stdout).toContain(`${goodId}.json`);
    expect(stdout).not.toContain(`${badId}.json`);
  });

  it('skips non-JSON files', async () => {
    const validId = `${TEST_PREFIX}-list-txt`;
    await writeFile(resolve(CHAT_DIR, 'readme.txt'), 'not a chat file');
    await writeFile(resolve(CHAT_DIR, `${validId}.json`), JSON.stringify({
      id: validId, status: 'pending', expiresAt: '2099-01-01T00:00:00Z',
      createGroup: { name: 'Test', members: ['ou_user'] },
      createdAt: new Date().toISOString(), chatId: null, activatedAt: null,
      context: {}, response: null, activationAttempts: 0, lastActivationError: null, failedAt: null,
    }));

    const { stdout, code } = await runScript('list');
    expect(code).toBe(0);
    expect(stdout).toContain(`${validId}.json`);
    expect(stdout).not.toContain('readme.txt');
  });
});

// ---- response.ts ----

describe('response.ts', () => {
  const id = `${TEST_PREFIX}-response`;

  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupChatFiles(id);
  });

  afterEach(async () => {
    await cleanupChatFiles(id);
  });

  async function setupActiveChat(chatId: string) {
    const chatData = {
      id: chatId,
      status: 'active',
      chatId: 'oc_xxx',
      createdAt: new Date().toISOString(),
      activatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      createGroup: { name: 'Test', members: ['ou_user'] },
      context: {},
      response: null,
      activationAttempts: 0,
      lastActivationError: null,
      failedAt: null,
    };
    await writeFile(resolve(CHAT_DIR, `${chatId}.json`), JSON.stringify(chatData, null, 2) + '\n');
  }

  it('records a response for an active chat', async () => {
    await setupActiveChat(id);

    const { stdout, code } = await runScript('response', {
      CHAT_ID: id,
      CHAT_RESPONSE: 'Looks good, approved',
      CHAT_RESPONDER: 'ou_developer',
    });

    expect(code).toBe(0);
    expect(stdout).toContain('OK');

    const content = await readFile(resolve(CHAT_DIR, `${id}.json`), 'utf-8');
    const chat = JSON.parse(content);
    expect(chat.response).not.toBeNull();
    expect(chat.response!.content).toBe('Looks good, approved');
    expect(chat.response!.responder).toBe('ou_developer');
    expect(chat.response!.repliedAt).toBeDefined();
  });

  it('rejects response for non-active chat', async () => {
    const chatData = {
      id, status: 'pending', chatId: null,
      createdAt: new Date().toISOString(), activatedAt: null,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      createGroup: { name: 'Test', members: ['ou_user'] },
      context: {}, response: null, activationAttempts: 0, lastActivationError: null, failedAt: null,
    };
    await writeFile(resolve(CHAT_DIR, `${id}.json`), JSON.stringify(chatData, null, 2) + '\n');

    const { code, stderr } = await runScript('response', {
      CHAT_ID: id,
      CHAT_RESPONSE: 'test',
      CHAT_RESPONDER: 'ou_developer',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('pending');
  });

  it('rejects duplicate response (idempotency)', async () => {
    await setupActiveChat(id);

    const first = await runScript('response', {
      CHAT_ID: id,
      CHAT_RESPONSE: 'First response',
      CHAT_RESPONDER: 'ou_user1',
    });
    expect(first.code).toBe(0);

    const second = await runScript('response', {
      CHAT_ID: id,
      CHAT_RESPONSE: 'Second response',
      CHAT_RESPONDER: 'ou_user2',
    });
    expect(second.code).toBe(1);
    expect(second.stderr).toContain('already has a response');
  });

  it('rejects invalid responder format', async () => {
    await setupActiveChat(id);

    const { code, stderr } = await runScript('response', {
      CHAT_ID: id,
      CHAT_RESPONSE: 'test',
      CHAT_RESPONDER: 'invalid_format',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('ou_xxxxx');
  });

  it('rejects empty response', async () => {
    await setupActiveChat(id);

    const { code, stderr } = await runScript('response', {
      CHAT_ID: id,
      CHAT_RESPONSE: '',
      CHAT_RESPONDER: 'ou_developer',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('CHAT_RESPONSE');
  });

  it('rejects response for nonexistent chat', async () => {
    const { code, stderr } = await runScript('response', {
      CHAT_ID: 'ghost-chat',
      CHAT_RESPONSE: 'test',
      CHAT_RESPONDER: 'ou_developer',
    });
    expect(code).toBe(1);
    expect(stderr).toContain('not found');
  });
});

// ---- Full lifecycle integration test ----

describe('chat lifecycle', () => {
  const id = `${TEST_PREFIX}-lifecycle`;

  afterEach(async () => {
    await cleanupChatFiles(id);
  });

  it('completes create → query → respond → query cycle', async () => {
    const futureExpiry = new Date(Date.now() + 3600000).toISOString();

    // 1. Create
    const createResult = await runScript('create', {
      CHAT_ID: id,
      CHAT_EXPIRES_AT: futureExpiry,
      CHAT_GROUP_NAME: 'Lifecycle Test',
      CHAT_MEMBERS: JSON.stringify(['ou_user1']),
      CHAT_CONTEXT: JSON.stringify({ test: true }),
    });
    expect(createResult.code).toBe(0);

    // 2. Query (should be pending)
    const queryBefore = await runScript('query', { CHAT_ID: id });
    expect(queryBefore.code).toBe(0);
    const chatBefore = JSON.parse(queryBefore.stdout);
    expect(chatBefore.status).toBe('pending');
    expect(chatBefore.context).toEqual({ test: true });

    // 3. Simulate activation (directly modify file)
    const content = await readFile(resolve(CHAT_DIR, `${id}.json`), 'utf-8');
    const chat = JSON.parse(content);
    chat.status = 'active';
    chat.chatId = 'oc_test_chat';
    chat.activatedAt = new Date().toISOString();
    await writeFile(resolve(CHAT_DIR, `${id}.json`), JSON.stringify(chat, null, 2) + '\n');

    // 4. Respond
    const respResult = await runScript('response', {
      CHAT_ID: id,
      CHAT_RESPONSE: 'Approved!',
      CHAT_RESPONDER: 'ou_user1',
    });
    expect(respResult.code).toBe(0);

    // 5. Query again (should have response)
    const queryAfter = await runScript('query', { CHAT_ID: id });
    expect(queryAfter.code).toBe(0);
    const chatAfter = JSON.parse(queryAfter.stdout);
    expect(chatAfter.status).toBe('active');
    expect(chatAfter.response).not.toBeNull();
    expect(chatAfter.response!.content).toBe('Approved!');
    expect(chatAfter.response!.responder).toBe('ou_user1');

    // 6. List should include the chat
    const listResult = await runScript('list', { CHAT_STATUS: 'active' });
    expect(listResult.code).toBe(0);
    expect(listResult.stdout).toContain(`${id}.json`);
  });
});
