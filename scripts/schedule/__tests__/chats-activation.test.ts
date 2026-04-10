/**
 * Integration tests for chats-activation schedule script.
 *
 * Tests cover: pending chat activation, expired chat handling, retry logic,
 * idempotent recovery, input validation, max per run limit, and corrupted files.
 *
 * lark-cli is mocked via a fake script injected into PATH.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, chmod, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

// Track created files for cleanup
const createdFiles: string[] = [];
let fakeBinDir: string | null = null;

// Helper to create a pending chat file
async function createTestChat(overrides: Record<string, unknown> = {}) {
  const id = `act-${randomUUID().slice(0, 8)}`;
  const defaults = {
    id,
    status: 'pending',
    chatId: null,
    createdAt: '2026-01-01T00:00:00Z',
    activatedAt: null,
    expiresAt: '2099-12-31T23:59:59Z',
    createGroup: { name: 'Test Group', members: ['ou_test123'] },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
  };
  const chatData = { ...defaults, ...overrides };
  const filePath = resolve(CHAT_DIR, `${chatData.id}.json`);
  await writeFile(filePath, JSON.stringify(chatData, null, 2), 'utf-8');
  createdFiles.push(filePath);
  return { chatData, filePath };
}

// Create a fake lark-cli that returns success or failure
async function setupFakeLarkCli(options: {
  mode: 'success' | 'fail' | 'timeout';
  chatId?: string;
  failAfterCount?: number;
}): Promise<string> {
  const binDir = await mkdtemp('/tmp/fake-lark-cli-');

  let scriptContent: string;
  // The activation script first calls `lark-cli --version` to check availability.
  // The fake must handle `--version` separately from `im +chat-create`.
  if (options.mode === 'success') {
    const chatId = options.chatId ?? `oc_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    scriptContent = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "lark-cli 1.0.0"; exit 0; fi
echo '{"data":{"chat_id":"${chatId}"}}'
`;
  } else if (options.mode === 'fail') {
    scriptContent = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "lark-cli 1.0.0"; exit 0; fi
echo "ERROR: API rate limited" >&2
exit 1
`;
  } else if (options.mode === 'timeout') {
    scriptContent = `#!/bin/bash
if [ "$1" = "--version" ]; then echo "lark-cli 1.0.0"; exit 0; fi
sleep 60
`;
  } else {
    throw new Error(`Unknown mode: ${options.mode}`);
  }

  const cliPath = join(binDir, 'lark-cli');
  await writeFile(cliPath, scriptContent, 'utf-8');
  await chmod(cliPath, 0o755);

  // Also create a fake version subcommand
  if (options.mode === 'success') {
    const versionPath = join(binDir, 'lark-cli-version');
    await writeFile(versionPath, '#!/bin/bash\necho \'lark-cli 1.0.0\'\n', 'utf-8');
    await chmod(versionPath, 0o755);
  }

  return binDir;
}

async function cleanupTestFiles() {
  for (const f of createdFiles) {
    try {
      await rm(f, { force: true });
      await rm(`${f}.lock`, { force: true });
    } catch {
      // Ignore
    }
  }
  createdFiles.length = 0;

  if (fakeBinDir) {
    try {
      await rm(fakeBinDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    fakeBinDir = null;
  }
}

// Helper to run the activation script with a custom PATH
async function runActivation(
  env: Record<string, string> = {},
  binDir?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts');
  const pathEnv = binDir
    ? `${binDir}:${process.env.PATH}`
    : process.env.PATH;

  try {
    const result = await execFileAsync('npx', ['tsx', scriptPath], {
      env: { ...process.env, ...env, PATH: pathEnv },
      maxBuffer: 1024 * 1024,
      cwd: PROJECT_ROOT,
      timeout: 15000,
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

describe('chats-activation', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('no pending chats', () => {
    it('should exit 0 when no pending chats exist', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No pending chats found');
    });

    it('should skip non-pending chats', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      await createTestChat({ status: 'active', chatId: 'oc_existing', activatedAt: '2026-01-01T00:01:00Z' });
      await createTestChat({ status: 'expired', expiredAt: '2026-01-02T00:00:00Z' });
      await createTestChat({ status: 'failed', activationAttempts: 5, failedAt: '2026-01-02T00:00:00Z' });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No pending chats found');
    });
  });

  describe('activation', () => {
    it('should activate a pending chat via lark-cli', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success', chatId: 'oc_new_group' });
      const { filePath } = await createTestChat({ id: 'activate-test', status: 'pending' });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('activated');

      // Verify file was updated
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('active');
      expect(data.chatId).toBe('oc_new_group');
      expect(data.activatedAt).toBeTruthy();
      expect(data.activationAttempts).toBe(0);
      expect(data.lastActivationError).toBeNull();
    });

    it('should activate multiple pending chats', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const { filePath: fp1 } = await createTestChat({ id: 'multi-1', status: 'pending' });
      const { filePath: fp2 } = await createTestChat({ id: 'multi-2', status: 'pending' });
      const { filePath: fp3 } = await createTestChat({ id: 'multi-3', status: 'pending' });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);

      for (const fp of [fp1, fp2, fp3]) {
        const content = await readFile(fp, 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('active');
        expect(data.chatId).toBeTruthy();
      }
    });
  });

  describe('expiry pre-check', () => {
    it('should mark expired pending chats without attempting activation', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const pastExpiry = '2025-01-01T00:00:00Z';
      const { filePath } = await createTestChat({
        id: 'expired-pending',
        status: 'pending',
        expiresAt: pastExpiry,
      });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('expired');

      // Verify file was marked as expired
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('expired');
      expect(data.expiredAt).toBeTruthy();
    });

    it('should skip non-UTC expiresAt format (treated as corrupted by schema validation)', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success', chatId: 'oc_non_utc' });
      const { filePath } = await createTestChat({
        id: 'non-utc-expiry',
        status: 'pending',
        expiresAt: '2099-12-31T23:59:59+08:00', // Non-UTC format — fails schema validation
      });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);

      // parseChatFile validates expiresAt strictly (UTC Z-suffix only).
      // A non-UTC format causes the file to be treated as corrupted, not activated.
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('pending');
      expect(result.stderr).toContain('corrupted');
    });
  });

  describe('failure handling', () => {
    it('should increment retry counter on lark-cli failure', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'fail' });
      const { filePath } = await createTestChat({
        id: 'retry-test',
        status: 'pending',
        activationAttempts: 2,
      });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Failed to create group');

      // Verify retry counter was incremented
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('pending');
      expect(data.activationAttempts).toBe(3);
      expect(data.lastActivationError).toBeTruthy();
    });

    it('should mark as failed after max retries (5)', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'fail' });
      const { filePath } = await createTestChat({
        id: 'max-retry-test',
        status: 'pending',
        activationAttempts: 4, // One more failure should hit the limit
      });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('max retries');

      // Verify marked as failed
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('failed');
      expect(data.activationAttempts).toBe(5);
      expect(data.failedAt).toBeTruthy();
      expect(data.lastActivationError).toBeTruthy();
    });
  });

  describe('idempotent recovery', () => {
    it('should recover pending chat with existing chatId to active', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const { filePath } = await createTestChat({
        id: 'recovery-test',
        status: 'pending',
        chatId: 'oc_previously_created', // Already has a chatId (crash recovery scenario)
      });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('recovering to active');

      // Verify recovered to active
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('active');
      expect(data.chatId).toBe('oc_previously_created');
      expect(data.activatedAt).toBeTruthy();
    });
  });

  describe('input validation', () => {
    it('should skip chats with invalid group name characters', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const { filePath } = await createTestChat({
        id: 'bad-name',
        status: 'pending',
        createGroup: { name: 'test; rm -rf /', members: ['ou_test123'] },
      });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Invalid group name');

      // Should remain pending (not modified)
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('pending');
    });

    it('should skip chats with invalid member IDs (rejected by schema validation)', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const { filePath } = await createTestChat({
        id: 'bad-members',
        status: 'pending',
        createGroup: { name: 'Test', members: ['invalid_member'] },
      });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);

      // parseChatFile validates member IDs (ou_xxxxx format).
      // Invalid members cause the file to be treated as corrupted, not processed.
      expect(result.stderr).toContain('corrupted');

      // Should remain pending (not modified)
      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('pending');
    });

    it('should skip chats with empty members array', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const { filePath } = await createTestChat({
        id: 'empty-members',
        status: 'pending',
        createGroup: { name: 'Test', members: [] },
      });

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('No members');

      const content = await readFile(filePath, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('pending');
    });
  });

  describe('rate limiting', () => {
    it('should respect CHAT_MAX_PER_RUN limit', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const filePaths: string[] = [];

      // Create 5 pending chats
      for (let i = 0; i < 5; i++) {
        const { filePath } = await createTestChat({
          id: `limit-${i}`,
          status: 'pending',
        });
        filePaths.push(filePath);
      }

      // Limit to 2 per run
      const result = await runActivation({ CHAT_MAX_PER_RUN: '2' }, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('max processing limit');

      // Only 2 should be activated
      let activatedCount = 0;
      for (const fp of filePaths) {
        const content = await readFile(fp, 'utf-8');
        const data = JSON.parse(content);
        if (data.status === 'active') {
          activatedCount++;
        }
      }
      expect(activatedCount).toBe(2);
    });
  });

  describe('corrupted files', () => {
    it('should skip corrupted JSON files gracefully', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const { filePath: validFp } = await createTestChat({ id: 'valid-amidst-corrupt', status: 'pending' });

      // Create a corrupted file
      const corruptedPath = resolve(CHAT_DIR, 'corrupted-chat.json');
      await writeFile(corruptedPath, '{not valid json!!!', 'utf-8');
      createdFiles.push(corruptedPath);

      const result = await runActivation({}, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('corrupted');

      // Valid chat should still be activated
      const content = await readFile(validFp, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('active');
    });
  });

  describe('missing lark-cli', () => {
    it('should exit with error when lark-cli is not available', async () => {
      // Use a PATH that doesn't contain lark-cli
      const emptyBinDir = await mkdtemp('/tmp/empty-path-');
      fakeBinDir = emptyBinDir;

      const result = await runActivation({}, emptyBinDir);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('lark-cli');
    });
  });

  describe('CHAT_MAX_PER_RUN validation', () => {
    it('should fall back to default for invalid CHAT_MAX_PER_RUN', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const { filePath: fp } = await createTestChat({ id: 'invalid-limit', status: 'pending' });

      // Should still work with invalid limit (falls back to 10)
      const result = await runActivation({ CHAT_MAX_PER_RUN: 'abc' }, fakeBinDir);

      expect(result.code).toBe(0);
      expect(result.stderr).toContain('Invalid CHAT_MAX_PER_RUN');

      // Chat should still be activated
      const content = await readFile(fp, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('active');
    });

    it('should fall back to default for zero CHAT_MAX_PER_RUN', async () => {
      fakeBinDir = await setupFakeLarkCli({ mode: 'success' });
      const { filePath: fp } = await createTestChat({ id: 'zero-limit', status: 'pending' });

      const result = await runActivation({ CHAT_MAX_PER_RUN: '0' }, fakeBinDir);

      expect(result.code).toBe(0);
      // With fallback, should still process at least 1
      const content = await readFile(fp, 'utf-8');
      const data = JSON.parse(content);
      expect(data.status).toBe('active');
    });
  });
});
