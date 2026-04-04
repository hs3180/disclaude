/**
 * Integration tests for chat lifecycle bash scripts.
 *
 * Issue #1547: Tests verification criteria from merged PR #1936:
 * - Agent can create/query/list chat files
 * - Schedule can activate pending chats (with mocked lark-cli)
 * - Path traversal protection
 * - Idempotent crash recovery
 *
 * These tests execute the actual bash scripts in isolated temp directories
 * to validate real file I/O, locking, and validation logic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

// Paths to the actual scripts (relative to repo root)
const REPO_ROOT = resolve(__dirname, '../../../..');
const CREATE_SCRIPT = join(REPO_ROOT, 'scripts/chat/create.sh');
const QUERY_SCRIPT = join(REPO_ROOT, 'scripts/chat/query.sh');
const LIST_SCRIPT = join(REPO_ROOT, 'scripts/chat/list.sh');
const RESPONSE_SCRIPT = join(REPO_ROOT, 'scripts/chat/response.sh');
const ACTIVATION_SCRIPT = join(REPO_ROOT, 'scripts/schedule/chats-activation.sh');

// Custom bin directory with GNU-compatible tools (jq, realpath -m support, etc.)
const CUSTOM_BIN = '/app/.local/bin';

// Future expiry timestamp used across all tests (must be in the future)
const FUTURE_EXPIRY = '2099-12-31T23:59:59Z';

interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a bash script with the given environment variables and working directory.
 * Prepends CUSTOM_BIN to PATH so scripts can find jq and GNU realpath.
 */
function runScript(
  scriptPath: string,
  env: Record<string, string> = {},
  cwd: string,
  extraPath: string[] = [],
): ScriptResult {
  const pathDirs = [CUSTOM_BIN, ...extraPath].join(':');
  const fullEnv = {
    ...process.env,
    PATH: `${pathDirs}:${process.env.PATH || ''}`,
    ...env,
  };

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    stdout = execSync(`bash "${scriptPath}"`, {
      cwd,
      env: fullEnv,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    stdout = err.stdout || '';
    stderr = err.stderr || '';
    exitCode = err.status ?? 1;
  }

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

/**
 * Create a chat file directly (for test setup).
 * Uses FUTURE_EXPIRY by default so activation tests don't expire the chat.
 */
function createChatFile(
  chatsDir: string,
  id: string,
  overrides: Record<string, any> = {},
): void {
  const chat = {
    id,
    status: 'pending',
    chatId: null,
    createdAt: '2026-03-24T10:00:00Z',
    activatedAt: null,
    expiresAt: FUTURE_EXPIRY,
    createGroup: {
      name: `TestChat_${id}`,
      members: ['ou_testuser1'],
    },
    context: {},
    response: null,
    activationAttempts: 0,
    lastActivationError: null,
    failedAt: null,
    ...overrides,
  };
  writeFileSync(join(chatsDir, `${id}.json`), JSON.stringify(chat, null, 2));
}

describe('Chat Lifecycle Scripts', () => {
  let workDir: string;
  let chatsDir: string;
  let fakeBinDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'chat-scripts-test-'));
    chatsDir = join(workDir, 'workspace', 'chats');
    mkdirSync(chatsDir, { recursive: true });

    // Create fake bin directory for mocked tools
    fakeBinDir = join(workDir, 'fake-bin');
    mkdirSync(fakeBinDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  // =========================================================================
  // create.sh
  // =========================================================================
  describe('create.sh', () => {
    it('should create a pending chat file with correct structure', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'pr-123',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'PR #123 Review',
        CHAT_MEMBERS: '["ou_developer"]',
        CHAT_CONTEXT: '{"prNumber": 123}',
      }, workDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('OK');

      const file = join(chatsDir, 'pr-123.json');
      expect(existsSync(file)).toBe(true);

      const chat = JSON.parse(readFileSync(file, 'utf-8'));
      expect(chat.id).toBe('pr-123');
      expect(chat.status).toBe('pending');
      expect(chat.chatId).toBeNull();
      expect(chat.expiresAt).toBe(FUTURE_EXPIRY);
      expect(chat.createGroup.name).toBe('PR #123 Review');
      expect(chat.createGroup.members).toEqual(['ou_developer']);
      expect(chat.context).toEqual({ prNumber: 123 });
      expect(chat.response).toBeNull();
      expect(chat.activationAttempts).toBe(0);
    });

    it('should default CHAT_CONTEXT to empty object', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-default-ctx',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(0);

      const chat = JSON.parse(readFileSync(join(chatsDir, 'test-default-ctx.json'), 'utf-8'));
      expect(chat.context).toEqual({});
    });

    it('should reject missing CHAT_ID', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CHAT_ID');
    });

    it('should reject missing CHAT_EXPIRES_AT', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-no-expiry',
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CHAT_EXPIRES_AT');
    });

    it('should reject missing CHAT_GROUP_NAME', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-no-name',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CHAT_GROUP_NAME');
    });

    it('should reject missing CHAT_MEMBERS', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-no-members',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CHAT_MEMBERS');
    });

    it('should reject invalid chat ID (path traversal)', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: '../etc/passwd',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Invalid chat ID');
    });

    it('should reject chat ID starting with dot', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: '.hidden',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Invalid chat ID');
    });

    it('should reject chat ID with slashes', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'foo/bar',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
    });

    it('should reject non-UTC expiresAt format', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-bad-format',
        CHAT_EXPIRES_AT: '2026-03-25T10:00:00+08:00',
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('UTC Z-suffix');
    });

    it('should reject expiresAt without time component', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-date-only',
        CHAT_EXPIRES_AT: '2026-03-25',
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
    });

    it('should reject invalid CHAT_CONTEXT (not JSON)', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-bad-ctx',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
        CHAT_CONTEXT: 'not json',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CHAT_CONTEXT');
    });

    it('should reject oversized CHAT_CONTEXT (>4096 bytes)', () => {
      const bigContext = JSON.stringify({ data: 'x'.repeat(5000) });
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-big-ctx',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
        CHAT_CONTEXT: bigContext,
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('too large');
    });

    it('should reject invalid member IDs (not ou_xxx format)', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-bad-member',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["invalid_user"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Invalid member ID');
    });

    it('should reject empty members array', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-empty-members',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '[]',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('non-empty');
    });

    it('should reject duplicate chat ID', () => {
      // Create first chat
      runScript(CREATE_SCRIPT, {
        CHAT_ID: 'duplicate-test',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      // Try to create second with same ID
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'duplicate-test',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('already exists');
    });

    it('should accept valid special characters in group name', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-special-name',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'PR #456: Fix bug (v2.0)',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(0);

      const chat = JSON.parse(readFileSync(join(chatsDir, 'test-special-name.json'), 'utf-8'));
      expect(chat.createGroup.name).toBe('PR #456: Fix bug (v2.0)');
    });

    it('should truncate group name to 64 characters', () => {
      const longName = 'A'.repeat(100);
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-truncate',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: longName,
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(0);

      const chat = JSON.parse(readFileSync(join(chatsDir, 'test-truncate.json'), 'utf-8'));
      expect(chat.createGroup.name.length).toBeLessThanOrEqual(64);
    });

    it('should reject group name with shell injection characters', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-inject',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test; rm -rf /',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('unsafe characters');
    });

    it('should create valid JSON file (atomic write)', () => {
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-json-valid',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1", "ou_user2"]',
      }, workDir);

      expect(result.exitCode).toBe(0);

      // Verify it's valid JSON by parsing
      const content = readFileSync(join(chatsDir, 'test-json-valid.json'), 'utf-8');
      const chat = JSON.parse(content);
      expect(chat.createGroup.members).toHaveLength(2);
      expect(chat.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('should warn but allow past expiry time', () => {
      const pastExpiry = '2020-01-01T00:00:00Z';
      const result = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'test-past-expiry',
        CHAT_EXPIRES_AT: pastExpiry,
        CHAT_GROUP_NAME: 'Test',
        CHAT_MEMBERS: '["ou_user1"]',
      }, workDir);

      // Should succeed but warn
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('WARN');
    });
  });

  // =========================================================================
  // query.sh
  // =========================================================================
  describe('query.sh', () => {
    beforeEach(() => {
      createChatFile(chatsDir, 'query-test-1', { status: 'active', chatId: 'oc_test1' });
      createChatFile(chatsDir, 'query-test-2', { status: 'pending' });
    });

    it('should return chat content for existing chat', () => {
      const result = runScript(QUERY_SCRIPT, {
        CHAT_ID: 'query-test-1',
      }, workDir);

      expect(result.exitCode).toBe(0);

      const chat = JSON.parse(result.stdout);
      expect(chat.id).toBe('query-test-1');
      expect(chat.status).toBe('active');
      expect(chat.chatId).toBe('oc_test1');
    });

    it('should reject missing CHAT_ID', () => {
      const result = runScript(QUERY_SCRIPT, {}, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CHAT_ID');
    });

    it('should report not found for non-existent chat', () => {
      const result = runScript(QUERY_SCRIPT, {
        CHAT_ID: 'nonexistent',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('not found');
    });

    it('should reject path traversal in CHAT_ID', () => {
      const result = runScript(QUERY_SCRIPT, {
        CHAT_ID: '../../../etc/passwd',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Invalid chat ID');
    });

    it('should reject invalid chat ID format', () => {
      const result = runScript(QUERY_SCRIPT, {
        CHAT_ID: 'has spaces',
      }, workDir);

      expect(result.exitCode).toBe(1);
    });

    it('should handle corrupted JSON file', () => {
      writeFileSync(join(chatsDir, 'corrupted.json'), '{invalid json}');

      const result = runScript(QUERY_SCRIPT, {
        CHAT_ID: 'corrupted',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('not valid JSON');
    });
  });

  // =========================================================================
  // list.sh
  // =========================================================================
  describe('list.sh', () => {
    beforeEach(() => {
      createChatFile(chatsDir, 'list-pending-1', { status: 'pending' });
      createChatFile(chatsDir, 'list-active-1', { status: 'active', chatId: 'oc_active1' });
      createChatFile(chatsDir, 'list-expired-1', { status: 'expired' });
      createChatFile(chatsDir, 'list-failed-1', { status: 'failed' });
    });

    it('should list all chats without filter', () => {
      const result = runScript(LIST_SCRIPT, {}, workDir);

      expect(result.exitCode).toBe(0);
      const files = result.stdout.split('\n').filter(Boolean);
      expect(files).toHaveLength(4);
      expect(files.some(f => f.includes('list-pending-1.json'))).toBe(true);
      expect(files.some(f => f.includes('list-active-1.json'))).toBe(true);
    });

    it('should filter chats by status', () => {
      const result = runScript(LIST_SCRIPT, {
        CHAT_STATUS: 'pending',
      }, workDir);

      expect(result.exitCode).toBe(0);
      const files = result.stdout.split('\n').filter(Boolean);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain('list-pending-1.json');
    });

    it('should filter by active status', () => {
      const result = runScript(LIST_SCRIPT, {
        CHAT_STATUS: 'active',
      }, workDir);

      expect(result.exitCode).toBe(0);
      const files = result.stdout.split('\n').filter(Boolean);
      expect(files).toHaveLength(1);
      expect(files[0]).toContain('list-active-1.json');
    });

    it('should return empty for non-matching filter', () => {
      const result = runScript(LIST_SCRIPT, {
        CHAT_STATUS: 'nonexistent_status',
      }, workDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('should skip corrupted JSON files', () => {
      writeFileSync(join(chatsDir, 'corrupted-list.json'), 'not json');

      const result = runScript(LIST_SCRIPT, {}, workDir);

      expect(result.exitCode).toBe(0);
      // Should list only the 4 valid files, not the corrupted one
      const files = result.stdout.split('\n').filter(Boolean);
      expect(files).toHaveLength(4);
      // Verify corrupted file is not in the listing
      expect(result.stdout).not.toContain('corrupted-list.json');
    });

    it('should handle empty chats directory', () => {
      // Clear the directory and re-list
      rmSync(chatsDir, { recursive: true });
      mkdirSync(join(workDir, 'workspace', 'chats'), { recursive: true });

      const emptyResult = runScript(LIST_SCRIPT, {}, workDir);
      expect(emptyResult.exitCode).toBe(0);
      expect(emptyResult.stdout).toBe('');
    });

    it('should report error when chats directory does not exist', () => {
      rmSync(join(workDir, 'workspace', 'chats'), { recursive: true });

      const result = runScript(LIST_SCRIPT, {}, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('not found');
    });
  });

  // =========================================================================
  // response.sh
  // =========================================================================
  describe('response.sh', () => {
    beforeEach(() => {
      createChatFile(chatsDir, 'resp-active', {
        status: 'active',
        chatId: 'oc_active_resp',
      });
      createChatFile(chatsDir, 'resp-pending', { status: 'pending' });
      createChatFile(chatsDir, 'resp-responded', {
        status: 'active',
        chatId: 'oc_active_resp2',
        response: {
          content: 'Already answered',
          responder: 'ou_user1',
          repliedAt: '2026-03-24T12:00:00Z',
        },
      });
    });

    it('should record response for active chat', () => {
      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'resp-active',
        CHAT_RESPONSE: 'Looks good, approve it',
        CHAT_RESPONDER: 'ou_developer',
      }, workDir);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('OK');

      const chat = JSON.parse(readFileSync(join(chatsDir, 'resp-active.json'), 'utf-8'));
      expect(chat.response.content).toBe('Looks good, approve it');
      expect(chat.response.responder).toBe('ou_developer');
      expect(chat.response.repliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('should reject response for non-active chat (pending)', () => {
      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'resp-pending',
        CHAT_RESPONSE: 'Response text',
        CHAT_RESPONDER: 'ou_developer',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('pending');
      expect(result.stdout).toContain('expected');
    });

    it('should reject duplicate response (idempotency)', () => {
      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'resp-responded',
        CHAT_RESPONSE: 'Different response',
        CHAT_RESPONDER: 'ou_developer',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('already has a response');
    });

    it('should reject missing CHAT_ID', () => {
      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_RESPONSE: 'text',
        CHAT_RESPONDER: 'ou_user1',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CHAT_ID');
    });

    it('should reject missing CHAT_RESPONSE', () => {
      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'resp-active',
        CHAT_RESPONDER: 'ou_user1',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CHAT_RESPONSE');
    });

    it('should reject missing CHAT_RESPONDER', () => {
      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'resp-active',
        CHAT_RESPONSE: 'text',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('CHAT_RESPONDER');
    });

    it('should reject invalid responder format', () => {
      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'resp-active',
        CHAT_RESPONSE: 'text',
        CHAT_RESPONDER: 'invalid_user',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Invalid responder ID');
    });

    it('should reject oversized response (>10000 chars)', () => {
      const longResponse = 'x'.repeat(10001);
      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'resp-active',
        CHAT_RESPONSE: longResponse,
        CHAT_RESPONDER: 'ou_user1',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('too long');
    });

    it('should reject response for non-existent chat', () => {
      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'nonexistent-chat',
        CHAT_RESPONSE: 'text',
        CHAT_RESPONDER: 'ou_user1',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('not found');
    });

    it('should reject path traversal in CHAT_ID', () => {
      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: '../../../etc/passwd',
        CHAT_RESPONSE: 'text',
        CHAT_RESPONDER: 'ou_user1',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Invalid chat ID');
    });

    it('should handle response for expired chat', () => {
      createChatFile(chatsDir, 'resp-expired', { status: 'expired' });

      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'resp-expired',
        CHAT_RESPONSE: 'too late',
        CHAT_RESPONDER: 'ou_user1',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('expired');
    });

    it('should handle response for failed chat', () => {
      createChatFile(chatsDir, 'resp-failed', { status: 'failed' });

      const result = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'resp-failed',
        CHAT_RESPONSE: 'text',
        CHAT_RESPONDER: 'ou_user1',
      }, workDir);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('failed');
    });
  });

  // =========================================================================
  // chats-activation.sh
  // =========================================================================
  describe('chats-activation.sh', () => {
    let mockLarkCliPath: string;

    /**
     * Create a mock lark-cli that returns a configurable response.
     */
    function createMockLarkCli(response: string, exitCode = 0): void {
      const script = `#!/bin/bash
if [ "$1" = "im" ] && [ "$2" = "+chat-create" ]; then
  echo '${response}'
  exit ${exitCode}
fi
echo "ERROR: Unknown command: $@" >&2
exit 1
`;
      mockLarkCliPath = join(fakeBinDir, 'lark-cli');
      writeFileSync(mockLarkCliPath, script);
      chmodSync(mockLarkCliPath, 0o755);
    }

    /**
     * Create a mock lark-cli that always fails.
     */
    function createFailingMockLarkCli(errorMsg: string, exitCode = 1): void {
      const script = `#!/bin/bash
echo "${errorMsg}" >&2
exit ${exitCode}
`;
      mockLarkCliPath = join(fakeBinDir, 'lark-cli');
      writeFileSync(mockLarkCliPath, script);
      chmodSync(mockLarkCliPath, 0o755);
    }

    it('should exit with error when lark-cli is missing', () => {
      const resultNoLark = runScript(ACTIVATION_SCRIPT, {}, workDir, []);

      expect(resultNoLark.exitCode).toBe(1);
      expect(resultNoLark.stdout).toContain('Missing');
    });

    it('should report no pending chats when directory is empty', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_test"}}');

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No pending chats found');
    });

    it('should activate a pending chat via lark-cli', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_new_group"}}');
      createChatFile(chatsDir, 'activate_me', {
        status: 'pending',
        createGroup: {
          name: 'Activation Test',
          members: ['ou_testuser1'],
        },
      });

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('activated');

      // Verify the chat file was updated
      const chat = JSON.parse(readFileSync(join(chatsDir, 'activate_me.json'), 'utf-8'));
      expect(chat.status).toBe('active');
      expect(chat.chatId).toBe('oc_new_group');
      expect(chat.activatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(chat.activationAttempts).toBe(0);
      expect(chat.lastActivationError).toBeNull();
    });

    it('should mark expired pending chats without calling lark-cli', () => {
      const trackScript = `#!/bin/bash
echo "CALLED" >> "${join(workDir, 'lark-cli-calls.log')}"
echo '{"data":{"chat_id":"oc_test"}}'
`;
      mockLarkCliPath = join(fakeBinDir, 'lark-cli');
      writeFileSync(mockLarkCliPath, trackScript);
      chmodSync(mockLarkCliPath, 0o755);

      createChatFile(chatsDir, 'already_expired', {
        status: 'pending',
        expiresAt: '2020-01-01T00:00:00Z',
      });

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);

      // Verify chat was marked expired
      const chat = JSON.parse(readFileSync(join(chatsDir, 'already_expired.json'), 'utf-8'));
      expect(chat.status).toBe('expired');
      expect(chat.expiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Verify lark-cli was NOT called
      expect(existsSync(join(workDir, 'lark-cli-calls.log'))).toBe(false);
    });

    it('should record error and increment retry on lark-cli failure', () => {
      createFailingMockLarkCli('API rate limit exceeded');
      createChatFile(chatsDir, 'will_fail', {
        status: 'pending',
        activationAttempts: 2,
      });

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      // Verify the script detected the failure and attempted retry
      expect(result.stdout).toContain('attempt 3/5');
      expect(result.stdout).toContain('Failed to create group');
      // Chat should remain pending (not yet at max retries)
      const chat = JSON.parse(readFileSync(join(chatsDir, 'will_fail.json'), 'utf-8'));
      expect(chat.status).toBe('pending');
    });

    it('should mark as failed after 5 retries', () => {
      createFailingMockLarkCli('Permanent error');
      createChatFile(chatsDir, 'max_retries', {
        status: 'pending',
        activationAttempts: 4, // Will become 5 after this run
      });

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      // Verify the script detected max retries and marked as failed
      expect(result.stdout).toContain('max retries');
      expect(result.stdout).toContain('marking as failed');
      // Verify chat is now marked as failed
      const chat = JSON.parse(readFileSync(join(chatsDir, 'max_retries.json'), 'utf-8'));
      expect(chat.status).toBe('failed');
    });

    it('should recover chat with existing chatId to active (idempotent)', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_should_not_call"}}');
      createChatFile(chatsDir, 'crash_recovery', {
        status: 'pending',
        chatId: 'oc_existing_group',
        activatedAt: null,
        createGroup: { name: 'CrashRecoveryGroup', members: ['ou_testuser1'] },
      });

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('recovering');

      const chat = JSON.parse(readFileSync(join(chatsDir, 'crash_recovery.json'), 'utf-8'));
      expect(chat.status).toBe('active');
      expect(chat.chatId).toBe('oc_existing_group');
      expect(chat.activatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('should skip non-pending chats', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_test"}}');
      createChatFile(chatsDir, 'already_active', { status: 'active', chatId: 'oc_active1' });
      createChatFile(chatsDir, 'already_failed', { status: 'failed' });
      createChatFile(chatsDir, 'already_expired_2', { status: 'expired' });

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('No pending chats found');

      // Verify statuses unchanged
      expect(JSON.parse(readFileSync(join(chatsDir, 'already_active.json'), 'utf-8')).status).toBe('active');
      expect(JSON.parse(readFileSync(join(chatsDir, 'already_failed.json'), 'utf-8')).status).toBe('failed');
    });

    it('should skip chats with invalid group name', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_test"}}');
      createChatFile(chatsDir, 'bad_name', {
        status: 'pending',
        createGroup: {
          name: 'Test; rm -rf /',
          members: ['ou_user1'],
        },
      });

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);

      // Chat should remain pending (skipped, not activated)
      const chat = JSON.parse(readFileSync(join(chatsDir, 'bad_name.json'), 'utf-8'));
      expect(chat.status).toBe('pending');
      expect(result.stdout).toContain('unsafe characters');
    });

    it('should skip chats with invalid member format', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_test"}}');
      createChatFile(chatsDir, 'bad_member', {
        status: 'pending',
        createGroup: {
          name: 'Test Group',
          members: ['not_a_valid_id'],
        },
      });

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);

      const chat = JSON.parse(readFileSync(join(chatsDir, 'bad_member.json'), 'utf-8'));
      expect(chat.status).toBe('pending');
      expect(result.stdout).toContain('Invalid member ID');
    });

    it('should skip corrupted JSON files', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_test"}}');
      writeFileSync(join(chatsDir, 'corrupted-activation.json'), '{bad json');

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      const combinedOutput = result.stdout + '\n' + result.stderr;
      expect(combinedOutput).toContain('corrupted');
    });

    it('should respect CHAT_MAX_PER_RUN limit', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_test"}}');

      // Create 15 pending chats with future expiry
      for (let i = 0; i < 15; i++) {
        createChatFile(chatsDir, `rate_limit_${i}`, {
          status: 'pending',
          createGroup: {
            name: `Chat ${i}`,
            members: ['ou_user1'],
          },
        });
      }

      const result = runScript(ACTIVATION_SCRIPT, {
        CHAT_MAX_PER_RUN: '3',
      }, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('max processing limit');

      // Count activated chats
      let activatedCount = 0;
      for (let i = 0; i < 15; i++) {
        const chat = JSON.parse(readFileSync(join(chatsDir, `rate_limit_${i}.json`), 'utf-8'));
        if (chat.status === 'active') activatedCount++;
      }
      expect(activatedCount).toBe(3);
    });

    it('should handle lark-cli timeout (exit code 124)', () => {
      // Create a mock lark-cli that exits with code 124 (timeout signal)
      const timeoutScript = `#!/bin/bash
exit 124
`;
      mockLarkCliPath = join(fakeBinDir, 'lark-cli');
      writeFileSync(mockLarkCliPath, timeoutScript);
      chmodSync(mockLarkCliPath, 0o755);

      createChatFile(chatsDir, 'timeout_chat', {
        status: 'pending',
        activationAttempts: 0,
      });

      const result = runScript(ACTIVATION_SCRIPT, {}, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      // Verify the script detected the timeout condition
      expect(result.stdout).toContain('timed out');
      // Chat should remain pending (retry)
      const chat = JSON.parse(readFileSync(join(chatsDir, 'timeout_chat.json'), 'utf-8'));
      expect(chat.status).toBe('pending');
      expect(chat.activationAttempts).toBe(1);
    });

    it('should accept valid CHAT_MAX_PER_RUN values', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_test"}}');

      const result = runScript(ACTIVATION_SCRIPT, {
        CHAT_MAX_PER_RUN: '100',
      }, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
    });

    it('should fall back to default for invalid CHAT_MAX_PER_RUN', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_test"}}');

      const result = runScript(ACTIVATION_SCRIPT, {
        CHAT_MAX_PER_RUN: 'abc',
      }, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Invalid CHAT_MAX_PER_RUN');
    });

    it('should fall back to default for zero CHAT_MAX_PER_RUN', () => {
      createMockLarkCli('{"data":{"chat_id":"oc_test"}}');

      const result = runScript(ACTIVATION_SCRIPT, {
        CHAT_MAX_PER_RUN: '0',
      }, workDir, [fakeBinDir]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Invalid CHAT_MAX_PER_RUN');
    });
  });

  // =========================================================================
  // End-to-end lifecycle
  // =========================================================================
  describe('end-to-end lifecycle', () => {
    it('should support full lifecycle: create → query → list → respond', () => {
      // Step 1: Create
      const createResult = runScript(CREATE_SCRIPT, {
        CHAT_ID: 'e2e-test',
        CHAT_EXPIRES_AT: FUTURE_EXPIRY,
        CHAT_GROUP_NAME: 'E2E Test',
        CHAT_MEMBERS: '["ou_user1"]',
        CHAT_CONTEXT: '{"source": "test"}',
      }, workDir);

      expect(createResult.exitCode).toBe(0);

      // Step 2: Query
      const queryResult = runScript(QUERY_SCRIPT, {
        CHAT_ID: 'e2e-test',
      }, workDir);

      expect(queryResult.exitCode).toBe(0);
      const chat = JSON.parse(queryResult.stdout);
      expect(chat.status).toBe('pending');
      expect(chat.context.source).toBe('test');

      // Step 3: List (should show pending)
      const listResult = runScript(LIST_SCRIPT, {
        CHAT_STATUS: 'pending',
      }, workDir);

      expect(listResult.exitCode).toBe(0);
      expect(listResult.stdout).toContain('e2e-test.json');

      // Step 4: Simulate activation (update file directly)
      const chatFile = join(chatsDir, 'e2e-test.json');
      const updatedChat = JSON.parse(readFileSync(chatFile, 'utf-8'));
      updatedChat.status = 'active';
      updatedChat.chatId = 'oc_e2e_group';
      updatedChat.activatedAt = '2026-03-24T11:00:00Z';
      writeFileSync(chatFile, JSON.stringify(updatedChat, null, 2));

      // Step 5: Respond
      const responseResult = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'e2e-test',
        CHAT_RESPONSE: 'Approved!',
        CHAT_RESPONDER: 'ou_approver',
      }, workDir);

      expect(responseResult.exitCode).toBe(0);

      // Step 6: Verify response recorded
      const finalQuery = runScript(QUERY_SCRIPT, {
        CHAT_ID: 'e2e-test',
      }, workDir);

      const finalChat = JSON.parse(finalQuery.stdout);
      expect(finalChat.response.content).toBe('Approved!');
      expect(finalChat.response.responder).toBe('ou_approver');

      // Step 7: Verify idempotency - second response should fail
      const dupResult = runScript(RESPONSE_SCRIPT, {
        CHAT_ID: 'e2e-test',
        CHAT_RESPONSE: 'Different response',
        CHAT_RESPONDER: 'ou_other',
      }, workDir);

      expect(dupResult.exitCode).toBe(1);
      expect(dupResult.stdout).toContain('already has a response');
    });
  });
});
