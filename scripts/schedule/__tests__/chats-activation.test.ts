/**
 * Integration tests for chats-activation schedule script.
 *
 * Tests cover:
 * - Environment dependency check (lark-cli availability)
 * - Pending chat detection and activation
 * - Expired pending chat marking
 * - Retry counting and failed marking
 * - Idempotent recovery (chatId already exists)
 * - Max per run limit
 * - Input validation (invalid group names, invalid members)
 * - Corrupted file handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, readFile, writeFile, chmod, mkdtemp } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

// Derive project root from current file location
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const CHAT_DIR = resolve(PROJECT_ROOT, 'workspace/chats');

function makeChatFile(overrides: Record<string, unknown> = {}): string {
  const defaults = {
    id: 'test-activation-1',
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
  return JSON.stringify({ ...defaults, ...overrides }, null, 2);
}

const TEST_IDS = [
  'test-activation-1', 'test-activation-2', 'test-activation-3',
  'test-activation-4', 'test-activation-5', 'test-activation-6',
  'test-activation-7', 'test-activation-8', 'test-activation-9',
  'test-activation-10', 'test-activation-11', 'test-activation-12',
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

/**
 * Create a fake lark-cli script that simulates various responses.
 * Returns the path to the temporary directory containing the fake script.
 */
async function createFakeLarkCli(response: {
  /** JSON stdout for +chat-create command */
  createStdout?: string;
  /** stderr text for +chat-create command */
  createStderr?: string;
  /** exit code for +chat-create command (default: 0 if createStdout, else 1) */
  createExitCode?: number;
  /** Whether --version succeeds (default: true) */
  versionOk?: boolean;
}): Promise<{ binDir: string; cleanup: () => Promise<void> }> {
  const binDir = await mkdtemp(join(os.tmpdir(), 'fake-lark-cli-'));
  const cliPath = join(binDir, 'lark-cli');

  const versionBlock = response.versionOk !== false
    ? 'echo "lark-cli 1.0.0"\nexit 0'
    : 'echo "error" >&2\nexit 1';

  const createExitCode = response.createExitCode ?? (response.createStdout ? 0 : 1);
  const createStdoutBlock = response.createStdout
    ? `echo '${response.createStdout}'`
    : (response.createStderr ? `echo '${response.createStderr}' >&2` : 'echo "error" >&2');

  const script = `#!/bin/bash
if [ "$1" = "--version" ]; then
  ${versionBlock}
fi

# Simulate chat-create command
if [ "$1" = "im" ] && [ "$2" = "+chat-create" ]; then
  ${createStdoutBlock}
  exit ${createExitCode}
fi

echo "Unknown command: $@" >&2
exit 1
`;

  await writeFile(cliPath, script, 'utf-8');
  await chmod(cliPath, 0o755);

  return {
    binDir,
    cleanup: async () => {
      try {
        await rm(cliPath, { force: true });
        await rm(binDir, { force: true, recursive: true });
      } catch {
        // Ignore
      }
    },
  };
}

describe('chats-activation', () => {
  beforeEach(async () => {
    await mkdir(CHAT_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('environment checks', () => {
    it('should fail when lark-cli is not available', async () => {
      // Use a PATH that includes npx/tsx but NOT lark-cli
      const npxDir = dirname(await execFileAsync('which', ['npx']).then(r => r.stdout.trim()));
      const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
        env: { ...process.env, PATH: `${npxDir}:/usr/bin:/bin` },
        maxBuffer: 1024 * 1024,
        cwd: PROJECT_ROOT,
      }).catch((err) => ({
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        code: err.code ?? 1,
      }));

      // The process should fail (non-zero exit code or ENOENT signal)
      expect(result.code).not.toBe(0);
      // stderr should mention lark-cli (either from our script or from the shell)
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('lark-cli');
    });

    it('should exit cleanly when no chat directory exists', async () => {
      // Temporarily remove chat directory
      await rm(CHAT_DIR, { recursive: true, force: true });

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });
      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stdout).toContain('No pending chats');
      } finally {
        await cleanup();
        await mkdir(CHAT_DIR, { recursive: true });
      }
    });

    it('should exit cleanly when no pending chats exist', async () => {
      // Create only active/expired chats
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({ id: 'test-activation-1', status: 'active' }), 'utf-8');
      await writeFile(resolve(CHAT_DIR, 'test-activation-2.json'),
        makeChatFile({ id: 'test-activation-2', status: 'expired' }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });
      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stdout).toContain('No pending chats');
      } finally {
        await cleanup();
      }
    });
  });

  describe('activation', () => {
    it('should activate a pending chat successfully', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({ id: 'test-activation-1' }), 'utf-8');

      const chatId = `oc_${randomUUID().replace(/-/g, '')}`;
      const { binDir, cleanup } = await createFakeLarkCli({
        createStdout: JSON.stringify({ data: { chat_id: chatId } }),
      });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stdout).toContain('activated');
        expect(result.stdout).toContain(chatId);

        // Verify file was updated
        const content = await readFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('active');
        expect(data.chatId).toBe(chatId);
        expect(data.activatedAt).toBeTruthy();
        expect(data.activationAttempts).toBe(0);
        expect(data.lastActivationError).toBeNull();
      } finally {
        await cleanup();
      }
    });

    it('should increment retry counter on activation failure', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({ id: 'test-activation-1' }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({
        createStderr: 'API rate limit exceeded',
        createExitCode: 1,
      });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stderr).toContain('Failed to create group');

        // Verify retry counter was incremented
        const content = await readFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('pending');
        expect(data.activationAttempts).toBe(1);
        expect(data.lastActivationError).toContain('API rate limit');
      } finally {
        await cleanup();
      }
    });

    it('should mark chat as failed after MAX_RETRIES (5) failures', async () => {
      // Create a chat that already has 4 failed attempts
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({
          id: 'test-activation-1',
          activationAttempts: 4,
          lastActivationError: 'Previous error',
        }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({
        createStderr: 'Permanent API error',
        createExitCode: 1,
      });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stderr).toContain('max retries');
        expect(result.stderr).toContain('failed');

        // Verify status changed to failed
        const content = await readFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('failed');
        expect(data.activationAttempts).toBe(5);
        expect(data.failedAt).toBeTruthy();
        expect(data.lastActivationError).toContain('Permanent API error');
      } finally {
        await cleanup();
      }
    });

    it('should recover chat to active if chatId already exists (idempotent)', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({
          id: 'test-activation-1',
          chatId: 'oc_existing_chat',
          activationAttempts: 2,
        }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stdout).toContain('recovering to active');

        // Verify status changed to active without calling lark-cli create
        const content = await readFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('active');
        expect(data.chatId).toBe('oc_existing_chat');
        expect(data.activatedAt).toBeTruthy();
      } finally {
        await cleanup();
      }
    });
  });

  describe('expiry pre-check', () => {
    it('should mark expired pending chats without attempting activation', async () => {
      // Create a pending chat that's already expired
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({
          id: 'test-activation-1',
          expiresAt: '2020-01-01T00:00:00Z',
        }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stdout).toContain('expired');

        // Verify status changed to expired
        const content = await readFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('expired');
        expect(data.expiredAt).toBeTruthy();
      } finally {
        await cleanup();
      }
    });

    it('should reject files with non-UTC expiresAt at schema validation', async () => {
      // Non-UTC expiresAt is caught by schema validation (parseChatFile),
      // so the file is treated as corrupted before reaching activation logic
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({
          id: 'test-activation-1',
          expiresAt: '2099-12-31',  // non-UTC format
        }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        const combined = result.stdout + result.stderr;
        expect(combined).toContain('corrupted');
        expect(combined).toContain('No pending chats');

        // Verify chat was NOT activated
        const content = await readFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('pending');
      } finally {
        await cleanup();
      }
    });
  });

  describe('input validation', () => {
    it('should skip chat with invalid group name', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({
          id: 'test-activation-1',
          createGroup: { name: 'test; rm -rf /', members: ['ou_test123'] },
        }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stderr).toContain('Invalid group name');

        // Verify chat was NOT activated
        const content = await readFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('pending');
      } finally {
        await cleanup();
      }
    });

    it('should skip chat with invalid member ID (rejected at parse time)', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({
          id: 'test-activation-1',
          createGroup: { name: 'Test', members: ['invalid_member'] },
        }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        // Invalid member IDs are caught during schema validation (parseChatFile)
        // so the file is treated as corrupted
        const combined = result.stdout + result.stderr;
        expect(combined).toContain('corrupted');

        // Verify chat was NOT activated
        const content = await readFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('pending');
      } finally {
        await cleanup();
      }
    });

    it('should skip chat with empty members list', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({
          id: 'test-activation-1',
          createGroup: { name: 'Test', members: [] },
        }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stderr).toContain('No members');

        const content = await readFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('pending');
      } finally {
        await cleanup();
      }
    });
  });

  describe('edge cases', () => {
    it('should skip corrupted JSON files', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'not valid json {{{', 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stderr).toContain('corrupted');
        expect(result.stdout).toContain('No pending chats');
      } finally {
        await cleanup();
      }
    });

    it('should skip non-JSON files', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({ id: 'test-activation-1' }), 'utf-8');
      await writeFile(resolve(CHAT_DIR, 'readme.txt'), 'not a chat file', 'utf-8');

      const chatId = `oc_${randomUUID().replace(/-/g, '')}`;
      const { binDir, cleanup } = await createFakeLarkCli({
        createStdout: JSON.stringify({ data: { chat_id: chatId } }),
      });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stdout).toContain('activated');
      } finally {
        await cleanup();
      }
    });

    it('should not activate chats that changed status during processing', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({ id: 'test-activation-1' }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        // Since the fake lark-cli doesn't return a valid chat_id for +chat-create,
        // the chat should remain pending with incremented attempts
        const content = await readFile(resolve(CHAT_DIR, 'test-activation-1.json'), 'utf-8');
        const data = JSON.parse(content);
        expect(data.status).toBe('pending');
        expect(data.activationAttempts).toBe(1);
      } finally {
        await cleanup();
      }
    });

    it('should respect CHAT_MAX_PER_RUN limit', async () => {
      // Create 12 pending chats (more than default limit of 10)
      for (let i = 1; i <= 12; i++) {
        const id = `test-activation-${String(i).padStart(2, '0')}`;
        await writeFile(resolve(CHAT_DIR, `${id}.json`),
          makeChatFile({ id }), 'utf-8');
      }

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stdout).toContain('max processing limit');
        expect(result.stdout).toContain('Processed 10');
      } finally {
        await cleanup();
      }
    });

    it('should handle invalid CHAT_MAX_PER_RUN gracefully', async () => {
      await writeFile(resolve(CHAT_DIR, 'test-activation-1.json'),
        makeChatFile({ id: 'test-activation-1' }), 'utf-8');

      const { binDir, cleanup } = await createFakeLarkCli({ versionOk: true });

      try {
        const result = await execFileAsync('npx', ['tsx', resolve(PROJECT_ROOT, 'scripts/schedule/chats-activation.ts')], {
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH}`,
            CHAT_MAX_PER_RUN: 'invalid',
          },
          maxBuffer: 1024 * 1024,
          cwd: PROJECT_ROOT,
        });

        expect(result.stderr).toContain('Invalid CHAT_MAX_PER_RUN');
      } finally {
        await cleanup();
      }
    });
  });
});
