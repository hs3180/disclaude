/**
 * Unit tests for pr-scanner scanner.ts.
 *
 * Tests the state file operations, validation logic, and CLI actions.
 * gh CLI calls are skipped in test mode (PR_SCANNER_SKIP_GH_CHECK=1).
 * State directory is isolated per test via PR_SCANNER_STATE_DIR.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const SCRIPT_PATH = resolve(__dirname, '../scanner.ts');
const TEST_STATE_DIR = resolve(PROJECT_ROOT, '.temp-chats-test');

const TEST_PRS = [9901, 9902, 9903, 9904, 9905];

// ---- Helpers ----

import type { PRStateFile, PRState } from '../scanner.js';

function makeStateFile(prNumber: number, overrides: Partial<PRStateFile> = {}): PRStateFile {
  return {
    prNumber,
    chatId: null,
    state: 'reviewing',
    createdAt: '2026-04-07T10:00:00Z',
    updatedAt: '2026-04-07T10:00:00Z',
    expiresAt: '2026-04-09T10:00:00Z',
    disbandRequested: null,
    ...overrides,
  };
}

async function cleanupTestFiles() {
  try {
    await rm(TEST_STATE_DIR, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

async function runScript(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(
      'npx',
      ['tsx', SCRIPT_PATH, ...args],
      {
        env: {
          ...process.env,
          PR_SCANNER_STATE_DIR: TEST_STATE_DIR,
          PR_SCANNER_SKIP_GH_CHECK: '1',
          ...env,
        },
        maxBuffer: 1024 * 1024,
        cwd: PROJECT_ROOT,
      },
    );
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

// ---- Tests ----

describe('pr-scanner scanner.ts', () => {
  beforeEach(async () => {
    await cleanupTestFiles();
    await mkdir(TEST_STATE_DIR, { recursive: true });
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  // ===== status action =====

  describe('--action status', () => {
    it('should report no tracked PRs when state dir is empty', async () => {
      const result = await runScript(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No PRs currently tracked');
    });

    it('should list reviewing PRs', async () => {
      for (const pr of [9901, 9902]) {
        const data = makeStateFile(pr);
        await writeFile(
          resolve(TEST_STATE_DIR, `pr-${pr}.json`),
          JSON.stringify(data, null, 2) + '\n',
        );
      }

      const result = await runScript(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('REVIEWING (2)');
      expect(result.stdout).toContain('#9901');
      expect(result.stdout).toContain('#9902');
    });

    it('should group PRs by state', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        JSON.stringify(makeStateFile(9901, { state: 'reviewing' }), null, 2) + '\n',
      );
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9902.json'),
        JSON.stringify(makeStateFile(9902, { state: 'approved' }), null, 2) + '\n',
      );
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9903.json'),
        JSON.stringify(makeStateFile(9903, { state: 'closed' }), null, 2) + '\n',
      );

      const result = await runScript(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('REVIEWING (1)');
      expect(result.stdout).toContain('APPROVED (1)');
      expect(result.stdout).toContain('CLOSED (1)');
    });

    it('should skip corrupted state files', async () => {
      await writeFile(resolve(TEST_STATE_DIR, 'pr-9901.json'), 'not valid json {{{');
      const result = await runScript(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('corrupted');
    });

    it('should ignore non-PR files in state directory', async () => {
      await writeFile(resolve(TEST_STATE_DIR, 'other-file.txt'), 'some content');
      await writeFile(resolve(TEST_STATE_DIR, 'backup.json'), '{}');
      await writeFile(resolve(TEST_STATE_DIR, '.gitkeep'), '');

      const result = await runScript(['--action', 'status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No PRs currently tracked');
    });

    it('should create state directory if it does not exist', async () => {
      await rm(TEST_STATE_DIR, { recursive: true, force: true });
      const result = await runScript(['--action', 'status']);
      expect(result.code).toBe(0);
      await expect(stat(TEST_STATE_DIR)).resolves.toBeDefined();
    });
  });

  // ===== check-capacity action =====

  describe('--action check-capacity', () => {
    it('should report full capacity when no PRs are tracked', async () => {
      const result = await runScript(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reviewing).toBe(0);
      expect(parsed.maxConcurrent).toBe(3);
      expect(parsed.available).toBe(3);
    });

    it('should count reviewing PRs correctly', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        JSON.stringify(makeStateFile(9901, { state: 'reviewing' }), null, 2) + '\n',
      );
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9902.json'),
        JSON.stringify(makeStateFile(9902, { state: 'reviewing' }), null, 2) + '\n',
      );

      const result = await runScript(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reviewing).toBe(2);
      expect(parsed.available).toBe(1);
    });

    it('should not count non-reviewing PRs', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        JSON.stringify(makeStateFile(9901, { state: 'approved' }), null, 2) + '\n',
      );
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9902.json'),
        JSON.stringify(makeStateFile(9902, { state: 'closed' }), null, 2) + '\n',
      );

      const result = await runScript(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reviewing).toBe(0);
      expect(parsed.available).toBe(3);
    });

    it('should report zero available when at max capacity', async () => {
      for (const pr of [9901, 9902, 9903]) {
        await writeFile(
          resolve(TEST_STATE_DIR, `pr-${pr}.json`),
          JSON.stringify(makeStateFile(pr, { state: 'reviewing' }), null, 2) + '\n',
        );
      }

      const result = await runScript(['--action', 'check-capacity']);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.reviewing).toBe(3);
      expect(parsed.available).toBe(0);
    });

    it('should respect PR_SCANNER_MAX_REVIEWING env var', async () => {
      const result = await runScript(
        ['--action', 'check-capacity'],
        { PR_SCANNER_MAX_REVIEWING: '5' },
      );
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.maxConcurrent).toBe(5);
      expect(parsed.available).toBe(5);
    });
  });

  // ===== create-state action =====

  describe('--action create-state', () => {
    it('should create a new state file', async () => {
      const result = await runScript(['--action', 'create-state', '--pr', '9901']);
      expect(result.code).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.prNumber).toBe(9901);
      expect(parsed.state).toBe('reviewing');
      expect(parsed.chatId).toBeNull();
      expect(parsed.createdAt).toBeTruthy();
      expect(parsed.updatedAt).toBeTruthy();
      expect(parsed.expiresAt).toBeTruthy();
      expect(parsed.disbandRequested).toBeNull();
    });

    it('should create state file with chat ID', async () => {
      const result = await runScript([
        '--action', 'create-state',
        '--pr', '9901',
        '--chat-id', 'oc_test_chat_123',
      ]);
      expect(result.code).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.chatId).toBe('oc_test_chat_123');
    });

    it('should write file to disk that can be read back', async () => {
      await runScript(['--action', 'create-state', '--pr', '9901']);

      const content = await readFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        'utf-8',
      );
      const parsed = JSON.parse(content);
      expect(parsed.prNumber).toBe(9901);
      expect(parsed.state).toBe('reviewing');
    });

    it('should set expiresAt to now + TTL hours', async () => {
      const result = await runScript(
        ['--action', 'create-state', '--pr', '9901'],
        { PR_SCANNER_TTL_HOURS: '48' },
      );
      expect(result.code).toBe(0);

      const parsed = JSON.parse(result.stdout);
      const created = new Date(parsed.createdAt).getTime();
      const expires = new Date(parsed.expiresAt).getTime();
      const diffHours = (expires - created) / (1000 * 3600);
      expect(diffHours).toBeCloseTo(48, 0);
    });

    it('should fail if state file already exists', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        JSON.stringify(makeStateFile(9901), null, 2) + '\n',
      );

      const result = await runScript(['--action', 'create-state', '--pr', '9901']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('already exists');
    });

    it('should fail with missing --pr', async () => {
      const result = await runScript(['--action', 'create-state']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr');
    });

    it('should fail with invalid --pr', async () => {
      const result = await runScript(['--action', 'create-state', '--pr', 'abc']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr');
    });
  });

  // ===== mark action =====

  describe('--action mark', () => {
    it('should update PR state from reviewing to approved', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        JSON.stringify(makeStateFile(9901), null, 2) + '\n',
      );

      const result = await runScript(['--action', 'mark', '--pr', '9901', '--state', 'approved']);
      expect(result.code).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.state).toBe('approved');
      expect(parsed._transition).toBe('reviewing → approved');
    });

    it('should update PR state from reviewing to closed', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        JSON.stringify(makeStateFile(9901, { state: 'reviewing' }), null, 2) + '\n',
      );

      const result = await runScript(['--action', 'mark', '--pr', '9901', '--state', 'closed']);
      expect(result.code).toBe(0);

      const content = await readFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        'utf-8',
      );
      const updated = JSON.parse(content);
      expect(updated.state).toBe('closed');
    });

    it('should be idempotent when marking to same state', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        JSON.stringify(makeStateFile(9901, { state: 'reviewing' }), null, 2) + '\n',
      );

      const result = await runScript(['--action', 'mark', '--pr', '9901', '--state', 'reviewing']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('already');
    });

    it('should preserve existing fields when marking state', async () => {
      const original = makeStateFile(9901, {
        chatId: 'oc_preserve_me',
        createdAt: '2026-04-07T10:00:00Z',
      });
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        JSON.stringify(original, null, 2) + '\n',
      );

      await runScript(['--action', 'mark', '--pr', '9901', '--state', 'approved']);

      const content = await readFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        'utf-8',
      );
      const updated = JSON.parse(content);
      expect(updated.state).toBe('approved');
      expect(updated.chatId).toBe('oc_preserve_me');
      expect(updated.prNumber).toBe(9901);
      expect(updated.createdAt).toBe('2026-04-07T10:00:00Z');
      expect(updated.updatedAt).toBeTruthy();
    });

    it('should fail for non-existent PR', async () => {
      const result = await runScript(['--action', 'mark', '--pr', '9999', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No state file found');
    });

    it('should fail with invalid state', async () => {
      await writeFile(
        resolve(TEST_STATE_DIR, 'pr-9901.json'),
        JSON.stringify(makeStateFile(9901), null, 2) + '\n',
      );

      const result = await runScript(['--action', 'mark', '--pr', '9901', '--state', 'invalid']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--state');
    });

    it('should fail with missing --state', async () => {
      const result = await runScript(['--action', 'mark', '--pr', '9901']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--state');
    });

    it('should fail with missing --pr', async () => {
      const result = await runScript(['--action', 'mark', '--state', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('--pr');
    });
  });

  // ===== state file schema validation =====

  describe('state file schema', () => {
    it('should correctly parse state file with all fields', () => {
      const data = makeStateFile(9901, { chatId: 'oc_test_chat' });
      const content = JSON.stringify(data, null, 2);
      const parsed = JSON.parse(content);
      expect(parsed.prNumber).toBe(9901);
      expect(parsed.chatId).toBe('oc_test_chat');
      expect(parsed.state).toBe('reviewing');
      expect(parsed.disbandRequested).toBeNull();
    });

    it('should handle state file with null optional fields', () => {
      const data = makeStateFile(9901, { chatId: null });
      const content = JSON.stringify(data, null, 2);
      const parsed = JSON.parse(content);
      expect(parsed.chatId).toBeNull();
      expect(parsed.disbandRequested).toBeNull();
    });

    it('should only allow valid states', () => {
      const validStates: PRState[] = ['reviewing', 'approved', 'closed'];
      for (const s of validStates) {
        const data = makeStateFile(9901, { state: s });
        expect(data.state).toBe(s);
      }
    });
  });

  // ===== CLI error handling =====

  describe('CLI error handling', () => {
    it('should fail with no --action', async () => {
      const result = await runScript([]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Usage');
    });

    it('should fail with unknown --action', async () => {
      const result = await runScript(['--action', 'unknown']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Usage');
    });
  });

  // ===== environment variable validation =====

  describe('environment variable validation', () => {
    it('should fail with invalid PR_SCANNER_MAX_REVIEWING', async () => {
      const result = await runScript(
        ['--action', 'status'],
        { PR_SCANNER_MAX_REVIEWING: 'abc' },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('PR_SCANNER_MAX_REVIEWING');
    });

    it('should fail with zero PR_SCANNER_MAX_REVIEWING', async () => {
      const result = await runScript(
        ['--action', 'status'],
        { PR_SCANNER_MAX_REVIEWING: '0' },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('PR_SCANNER_MAX_REVIEWING');
    });

    it('should fail with negative PR_SCANNER_MAX_REVIEWING', async () => {
      const result = await runScript(
        ['--action', 'status'],
        { PR_SCANNER_MAX_REVIEWING: '-1' },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('PR_SCANNER_MAX_REVIEWING');
    });
  });
});
