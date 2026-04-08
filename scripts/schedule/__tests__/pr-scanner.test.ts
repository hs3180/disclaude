/**
 * Unit tests for pr-scanner schedule script.
 *
 * Tests the validation, state management, and filtering logic.
 * gh CLI calls are skipped in test mode (PR_SCANNER_SKIP_GH_CHECK=1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PRScanFile } from '../pr-scanner.js';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '../../..');
const STATE_DIR = resolve(PROJECT_ROOT, 'workspace/pr-scanner');

const TEST_PRS = [9901, 9902, 9903, 9904, 9905];

function makeStateFile(prNumber: number, overrides: Partial<PRScanFile> = {}): PRScanFile {
  return {
    number: prNumber,
    title: `Test PR #${prNumber}`,
    author: 'test-user',
    headRefName: `feature/test-${prNumber}`,
    baseRefName: 'main',
    status: 'reviewing',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    notifiedAt: null,
    chatId: null,
    mergeable: true,
    additions: 10,
    deletions: 5,
    changedFiles: 3,
    ...overrides,
  };
}

async function cleanupTestFiles() {
  for (const pr of TEST_PRS) {
    try {
      await rm(resolve(STATE_DIR, `pr-${pr}.json`), { force: true });
      await rm(resolve(STATE_DIR, `pr-${pr}.json.lock`), { force: true });
    } catch {
      // Ignore
    }
  }
}

async function runScript(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const scriptPath = resolve(PROJECT_ROOT, 'scripts/schedule/pr-scanner.ts');
  try {
    const result = await execFileAsync(
      'npx',
      ['tsx', scriptPath, ...args],
      {
        env: { ...process.env, PR_SCANNER_SKIP_GH_CHECK: '1', ...env },
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

describe('pr-scanner', () => {
  beforeEach(async () => {
    await mkdir(STATE_DIR, { recursive: true });
    await cleanupTestFiles();
  });

  afterEach(async () => {
    await cleanupTestFiles();
  });

  describe('status command', () => {
    it('should report no tracked PRs when state dir is empty', async () => {
      const result = await runScript(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No PRs currently tracked');
    });

    it('should list reviewing PRs', async () => {
      // Create some state files
      for (const pr of [9901, 9902]) {
        const data = makeStateFile(pr);
        await writeFile(resolve(STATE_DIR, `pr-${pr}.json`), JSON.stringify(data, null, 2) + '\n');
      }

      const result = await runScript(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('REVIEWING (2)');
      expect(result.stdout).toContain('#9901');
      expect(result.stdout).toContain('#9902');
    });

    it('should group PRs by status', async () => {
      await writeFile(
        resolve(STATE_DIR, 'pr-9901.json'),
        JSON.stringify(makeStateFile(9901, { status: 'reviewing' }), null, 2) + '\n',
      );
      await writeFile(
        resolve(STATE_DIR, 'pr-9902.json'),
        JSON.stringify(makeStateFile(9902, { status: 'approved' }), null, 2) + '\n',
      );
      await writeFile(
        resolve(STATE_DIR, 'pr-9903.json'),
        JSON.stringify(makeStateFile(9903, { status: 'closed' }), null, 2) + '\n',
      );

      const result = await runScript(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('REVIEWING (1)');
      expect(result.stdout).toContain('APPROVED (1)');
      expect(result.stdout).toContain('CLOSED (1)');
    });

    it('should skip corrupted state files', async () => {
      await writeFile(resolve(STATE_DIR, 'pr-9901.json'), 'not valid json {{{');
      const result = await runScript(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No PRs currently tracked');
    });

    it('should skip non-PR files in state directory', async () => {
      await writeFile(resolve(STATE_DIR, 'other-file.txt'), 'some content');
      await writeFile(resolve(STATE_DIR, 'pr-9901.json'), 'not valid json');

      const result = await runScript(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No PRs currently tracked');
    });
  });

  describe('mark command', () => {
    it('should update PR status from reviewing to approved', async () => {
      const data = makeStateFile(9901);
      await writeFile(resolve(STATE_DIR, 'pr-9901.json'), JSON.stringify(data, null, 2) + '\n');

      const result = await runScript(['mark', '9901', 'approved']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('reviewing → approved');

      const content = await readFile(resolve(STATE_DIR, 'pr-9901.json'), 'utf-8');
      const updated = JSON.parse(content);
      expect(updated.status).toBe('approved');
      expect(updated.updatedAt).toBeTruthy();
    });

    it('should update PR status from reviewing to rejected', async () => {
      const data = makeStateFile(9901);
      await writeFile(resolve(STATE_DIR, 'pr-9901.json'), JSON.stringify(data, null, 2) + '\n');

      const result = await runScript(['mark', '9901', 'rejected']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('reviewing → rejected');
    });

    it('should update PR status from reviewing to closed', async () => {
      const data = makeStateFile(9901);
      await writeFile(resolve(STATE_DIR, 'pr-9901.json'), JSON.stringify(data, null, 2) + '\n');

      const result = await runScript(['mark', '9901', 'closed']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('reviewing → closed');
    });

    it('should be idempotent when marking to same status', async () => {
      const data = makeStateFile(9901);
      await writeFile(resolve(STATE_DIR, 'pr-9901.json'), JSON.stringify(data, null, 2) + '\n');

      const result = await runScript(['mark', '9901', 'reviewing']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('already');
    });

    it('should fail for non-existent PR', async () => {
      const result = await runScript(['mark', '9999', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No state file found');
    });

    it('should fail for invalid PR number', async () => {
      const result = await runScript(['mark', 'abc', 'approved']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR number');
    });

    it('should fail for invalid status', async () => {
      const result = await runScript(['mark', '9901', 'invalid_status']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid status');
    });

    it('should fail with missing arguments', async () => {
      const result = await runScript(['mark', '9901']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Usage');
    });
  });

  describe('state file handling', () => {
    it('should correctly parse state files with all fields', () => {
      const data = makeStateFile(9901, {
        chatId: 'oc_test_chat',
        notifiedAt: '2026-01-01T01:00:00Z',
        mergeable: false,
      });
      const content = JSON.stringify(data, null, 2);
      const parsed = JSON.parse(content);
      expect(parsed.number).toBe(9901);
      expect(parsed.chatId).toBe('oc_test_chat');
      expect(parsed.notifiedAt).toBe('2026-01-01T01:00:00Z');
      expect(parsed.mergeable).toBe(false);
    });

    it('should handle state file with null optional fields', () => {
      const data = makeStateFile(9901, { chatId: null, notifiedAt: null, mergeable: null });
      const content = JSON.stringify(data, null, 2);
      const parsed = JSON.parse(content);
      expect(parsed.chatId).toBeNull();
      expect(parsed.notifiedAt).toBeNull();
      expect(parsed.mergeable).toBeNull();
    });

    it('should preserve existing fields when marking status', async () => {
      const original = makeStateFile(9901, {
        chatId: 'oc_preserve_me',
        notifiedAt: '2026-01-01T01:00:00Z',
        additions: 42,
        deletions: 7,
      });
      await writeFile(
        resolve(STATE_DIR, 'pr-9901.json'),
        JSON.stringify(original, null, 2) + '\n',
      );

      await runScript(['mark', '9901', 'approved']);

      const content = await readFile(resolve(STATE_DIR, 'pr-9901.json'), 'utf-8');
      const updated = JSON.parse(content);
      expect(updated.status).toBe('approved');
      expect(updated.chatId).toBe('oc_preserve_me');
      expect(updated.notifiedAt).toBe('2026-01-01T01:00:00Z');
      expect(updated.additions).toBe(42);
      expect(updated.deletions).toBe(7);
      expect(updated.updatedAt).toBeTruthy();
      expect(updated.updatedAt).not.toBe(original.updatedAt);
    });
  });

  describe('directory handling', () => {
    it('should create state directory if it does not exist', async () => {
      await rm(STATE_DIR, { recursive: true, force: true });
      const result = await runScript(['status']);
      expect(result.code).toBe(0);
      // Directory should have been created
      await expect(stat(STATE_DIR)).resolves.toBeDefined();
    });

    it('should ignore non-matching files in state directory', async () => {
      await writeFile(resolve(STATE_DIR, 'readme.md'), '# PR Scanner State');
      await writeFile(resolve(STATE_DIR, 'backup.json'), '{}');
      await writeFile(resolve(STATE_DIR, '.gitkeep'), '');

      const result = await runScript(['status']);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain('No PRs currently tracked');
    });
  });

  describe('environment variable handling', () => {
    it('should fail with invalid PR_SCANNER_MAX_REVIEWING', async () => {
      const result = await runScript(['status'], { PR_SCANNER_MAX_REVIEWING: 'abc' });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR_SCANNER_MAX_REVIEWING');
    });

    it('should fail with zero PR_SCANNER_MAX_REVIEWING', async () => {
      const result = await runScript(['status'], { PR_SCANNER_MAX_REVIEWING: '0' });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR_SCANNER_MAX_REVIEWING');
    });

    it('should accept negative PR_SCANNER_MAX_REVIEWING as invalid', async () => {
      const result = await runScript(['status'], { PR_SCANNER_MAX_REVIEWING: '-1' });
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Invalid PR_SCANNER_MAX_REVIEWING');
    });
  });

  describe('default command handling', () => {
    it('should fail with no command', async () => {
      const result = await runScript([]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Usage');
    });

    it('should fail with unknown command', async () => {
      const result = await runScript(['unknown']);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('Usage');
    });
  });
});
