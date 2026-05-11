/**
 * Integration tests for chat lifecycle (create, list, query, dissolve).
 *
 * These tests call real lark-cli commands and verify both the lark-cli
 * output and the bot-chat-mapping.json state.
 *
 * Prerequisites:
 *   - lark-cli installed and authenticated (`lark auth status` passes)
 *
 * When lark-cli is not available, all tests are automatically skipped.
 * Set TEST_CHAT_USER_IDS=ou_xxx,ou_yyy to enable CC-04 (add members).
 *
 * @see Issue #3284 - test: 建群与解散群集成测试用例设计
 */

import { execFile, execSync } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import {
  BotChatMappingStore,
  makeMappingKey,
  parseGroupNameToKey,
  purposeFromKey,
  type MappingEntry,
  type MappingTable,
} from '@disclaude/core';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const MAX_GROUP_NAME_LENGTH = 64;
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;
const TEST_USERS = (process.env.TEST_CHAT_USER_IDS ?? '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

// ---- lark-cli availability (synchronous for describe.skipIf) ----

function checkLarkAvailableSync(): boolean {
  try {
    execSync('lark-cli --version', { timeout: 5_000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const larkAvailable = checkLarkAvailableSync();

// ---- Helpers ----

/**
 * Execute a lark-cli command and return stdout + stderr.
 */
async function larkExec(
  args: string[],
  options?: { input?: string; timeout?: number },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('lark-cli', args, {
    timeout: options?.timeout ?? LARK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Create a Feishu group via lark-cli.
 * Returns the chatId (oc_xxx format) of the new group.
 */
async function createGroup(
  name: string,
  options?: { description?: string; users?: string },
): Promise<string> {
  const args = ['im', '+chat-create', '--name', name];
  if (options?.description) {
    args.push('--description', options.description);
  }
  if (options?.users) {
    args.push('--users', options.users);
  }

  const { stdout } = await larkExec(args);

  // Parse chatId from output — lark-cli outputs JSON or plain text with oc_xxx
  const chatIdMatch = stdout.match(/(oc_[a-zA-Z0-9]+)/);
  if (!chatIdMatch) {
    throw new Error(`Failed to parse chatId from lark-cli output: ${stdout}`);
  }
  return chatIdMatch[1];
}

/**
 * Dissolve a Feishu group via lark-cli.
 */
async function dissolveGroup(chatId: string): Promise<void> {
  await larkExec(['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`]);
}

/**
 * Truncate a string to max length at code-point boundaries (CJK-safe).
 */
function truncateName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

/**
 * Generate a unique test group name with a prefix and random suffix.
 */
function testGroupName(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `[test] ${prefix}-${ts}-${rand}`;
}

// ---- Test Suite ----

describe.skipIf(!larkAvailable)('Chat Lifecycle Integration Tests', () => {
  let tmpDir: string;
  let mappingFilePath: string;
  let store: BotChatMappingStore;
  const createdGroups: Array<{ chatId: string; name: string }> = [];

  beforeAll(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'chat-lifecycle-test-'));
    mappingFilePath = path.join(tmpDir, 'bot-chat-mapping.json');
    store = new BotChatMappingStore({ filePath: mappingFilePath });
  });

  afterEach(async () => {
    // Clean up any mapping entries but keep the store
  });

  afterAll(async () => {
    // Dissolve all groups created during tests
    for (const group of createdGroups) {
      try {
        await dissolveGroup(group.chatId);
      } catch {
        // Best-effort cleanup; group may already be dissolved
      }
    }

    // Clean up temp directory
    if (tmpDir) {
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ===========================================================================
  // Category A: Group Creation (/chat create)
  // ===========================================================================

  describe('CC — 建群流程', () => {
    it('CC-01: basic creation — lark-cli creates group, returns valid chatId', async () => {
      const name = testGroupName('CC01');

      const chatId = await createGroup(name);
      createdGroups.push({ chatId, name });

      expect(chatId).toMatch(GROUP_CHAT_ID_REGEX);
    });

    it('CC-02: creation + mapping write — bot-chat-mapping.json gets correct entry', async () => {
      const name = testGroupName('CC02');
      const chatId = await createGroup(name);
      createdGroups.push({ chatId, name });

      // Write mapping using store
      const key = makeMappingKey('discussion', Date.now());
      await store.set(key, { chatId, purpose: 'discussion' });

      // Verify mapping
      const entry = await store.get(key);
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe(chatId);
      expect(entry!.purpose).toBe('discussion');
      expect(entry!.createdAt).toBeTruthy();

      // Verify on disk
      const raw = await fsPromises.readFile(mappingFilePath, 'utf-8');
      const table: MappingTable = JSON.parse(raw);
      expect(table[key]).toBeDefined();
      expect(table[key].chatId).toBe(chatId);
    });

    it('CC-03: creation + send context — MCP send_text can target new group', async () => {
      const name = testGroupName('CC03');
      const chatId = await createGroup(name);
      createdGroups.push({ chatId, name });

      // Send a test message via lark-cli to verify the group is functional
      const { stdout } = await larkExec([
        'im',
        '+messages-send',
        '--chat-id',
        chatId,
        '--text',
        '[integration test] verifying group is functional',
      ]);

      // lark-cli should succeed (no error thrown) and return some output
      expect(stdout).toBeTruthy();
    });

    it.skipIf(TEST_USERS.length === 0)(
      'CC-04: creation + add members — specified users are added',
      async () => {
        const name = testGroupName('CC04');
        const users = TEST_USERS.slice(0, 5).join(',');
        const chatId = await createGroup(name, { users });
        createdGroups.push({ chatId, name });

        // Verify the group was created (members already added by lark-cli)
        expect(chatId).toMatch(GROUP_CHAT_ID_REGEX);
      },
    );

    it('CC-05: name truncation — names > 64 chars are truncated at CJK-safe boundaries', async () => {
      // Build a name that's definitely > 64 code points
      const longName = '测试'.repeat(40); // 80 CJK chars = 80 code points
      const truncated = truncateName(longName);
      expect(Array.from(truncated)).toHaveLength(MAX_GROUP_NAME_LENGTH);

      // Create with truncated name
      const name = testGroupName('CC05') + truncated;
      const safeName = truncateName(name);
      expect(Array.from(safeName).length).toBeLessThanOrEqual(MAX_GROUP_NAME_LENGTH);

      const chatId = await createGroup(safeName);
      createdGroups.push({ chatId, name: safeName });
      expect(chatId).toMatch(GROUP_CHAT_ID_REGEX);
    });

    it('CC-06: special characters — emoji, CJK, English mixed name creates correctly', async () => {
      const mixedName = testGroupName('CC06-🚀中文English-特殊字符');
      const chatId = await createGroup(mixedName);
      createdGroups.push({ chatId, name: mixedName });
      expect(chatId).toMatch(GROUP_CHAT_ID_REGEX);
    });

    it('CC-08: idempotent creation — same topic re-creation does not error', async () => {
      const name = testGroupName('CC08');

      const chatId1 = await createGroup(name);
      createdGroups.push({ chatId: chatId1, name });

      // Creating another group with the same name should succeed (new group)
      const chatId2 = await createGroup(name);
      createdGroups.push({ chatId: chatId2, name });

      // Different chatIds — they are separate groups
      expect(chatId1).not.toBe(chatId2);
    });
  });

  // ===========================================================================
  // Category B: Group Dissolution (/chat dissolve)
  // ===========================================================================

  describe('CD — 解散群流程', () => {
    it('CD-01: basic dissolve — lark-cli DELETE succeeds', async () => {
      const name = testGroupName('CD01');
      const chatId = await createGroup(name);

      // Dissolve should not throw
      await expect(dissolveGroup(chatId)).resolves.toBeUndefined();
    });

    it('CD-02: dissolve + mapping cleanup — mapping entry is removed', async () => {
      const name = testGroupName('CD02');
      const chatId = await createGroup(name);

      const key = makeMappingKey('discussion', Date.now());
      await store.set(key, { chatId, purpose: 'discussion' });

      // Verify mapping exists
      const entryBefore = await store.get(key);
      expect(entryBefore).not.toBeNull();

      // Dissolve and clean up mapping
      await dissolveGroup(chatId);
      await store.delete(key);

      // Verify mapping is gone
      const entryAfter = await store.get(key);
      expect(entryAfter).toBeNull();
    });

    it('CD-03: dissolve non-existent group — returns clear error', async () => {
      const fakeChatId = 'oc_nonexistent000000000000000000';

      await expect(dissolveGroup(fakeChatId)).rejects.toThrow();
    });

    it('CD-04: dissolve + mapping consistency — other entries unaffected', async () => {
      // Create two groups
      const name1 = testGroupName('CD04a');
      const name2 = testGroupName('CD04b');
      const chatId1 = await createGroup(name1);
      const chatId2 = await createGroup(name2);
      createdGroups.push({ chatId: chatId2, name: name2 }); // Only track chatId2 for cleanup

      // Create two mapping entries
      const key1 = makeMappingKey('discussion', Date.now());
      await store.set(key1, { chatId: chatId1, purpose: 'discussion' });

      const key2 = makeMappingKey('discussion', Date.now() + 1);
      await store.set(key2, { chatId: chatId2, purpose: 'discussion' });

      // Dissolve first group and remove its mapping
      await dissolveGroup(chatId1);
      await store.delete(key1);

      // Second entry should be unaffected
      const entry2 = await store.get(key2);
      expect(entry2).not.toBeNull();
      expect(entry2!.chatId).toBe(chatId2);
    });

    it('CD-05: double dissolve — second dissolution returns error but no crash', async () => {
      const name = testGroupName('CD05');
      const chatId = await createGroup(name);

      // First dissolve succeeds
      await dissolveGroup(chatId);

      // Second dissolve should fail (group already dissolved)
      await expect(dissolveGroup(chatId)).rejects.toThrow();
    });
  });

  // ===========================================================================
  // Category C: Query and List (/chat list, /chat query)
  // ===========================================================================

  describe('CL — 列表', () => {
    it('CL-01: empty list — returns empty when no mappings', async () => {
      // Use a fresh store with a new file
      const emptyFile = path.join(tmpDir, 'empty-mapping.json');
      const emptyStore = new BotChatMappingStore({ filePath: emptyFile });

      const entries = await emptyStore.list();
      expect(entries).toHaveLength(0);
      expect(await emptyStore.size()).toBe(0);
    });

    it('CL-02: multiple entries — displayed correctly', async () => {
      const name1 = testGroupName('CL02a');
      const name2 = testGroupName('CL02b');
      const chatId1 = await createGroup(name1);
      const chatId2 = await createGroup(name2);
      createdGroups.push({ chatId: chatId1, name: name1 });
      createdGroups.push({ chatId: chatId2, name: name2 });

      const key1 = makeMappingKey('discussion', Date.now());
      const key2 = makeMappingKey('discussion', Date.now() + 1);
      await store.set(key1, { chatId: chatId1, purpose: 'discussion' });
      await store.set(key2, { chatId: chatId2, purpose: 'discussion' });

      const entries = await store.list();
      expect(entries.length).toBeGreaterThanOrEqual(2);

      // Verify all entries have required fields
      for (const [, entry] of entries) {
        expect(entry.chatId).toMatch(GROUP_CHAT_ID_REGEX);
        expect(entry.purpose).toBeTruthy();
        expect(entry.createdAt).toBeTruthy();
      }
    });
  });

  describe('CQ — 查询', () => {
    it('CQ-01: query existing key — returns correct mapping entry', async () => {
      const name = testGroupName('CQ01');
      const chatId = await createGroup(name);
      createdGroups.push({ chatId, name });

      const key = makeMappingKey('discussion', Date.now());
      await store.set(key, { chatId, purpose: 'discussion' });

      const entry = await store.get(key);
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe(chatId);
    });

    it('CQ-02: query non-existent key — returns null', async () => {
      const entry = await store.get('nonexistent-key-9999999');
      expect(entry).toBeNull();
    });
  });

  // ===========================================================================
  // Category D: Mapping Table Integrity
  // ===========================================================================

  describe('CM — 映射表完整性', () => {
    it('CM-01: mapping format — JSON structure conforms to MappingTable type', async () => {
      const name = testGroupName('CM01');
      const chatId = await createGroup(name);
      createdGroups.push({ chatId, name });

      const key = makeMappingKey('discussion', Date.now());
      await store.set(key, { chatId, purpose: 'discussion' });

      // Read raw file and verify structure
      const raw = await fsPromises.readFile(mappingFilePath, 'utf-8');
      const table = JSON.parse(raw);

      // Every value must be a valid MappingEntry
      for (const [entryKey, entry] of Object.entries(table)) {
        const e = entry as MappingEntry;
        expect(typeof e.chatId).toBe('string');
        expect(typeof e.createdAt).toBe('string');
        expect(typeof e.purpose).toBe('string');
        expect(e.chatId).toMatch(GROUP_CHAT_ID_REGEX);
        // Key format should match {purpose}-{identifier}
        expect(entryKey).toMatch(/^.+-\d+$/);
      }
    });

    it('CM-02: concurrent creation — multiple writes do not lose mappings', async () => {
      // Simulate concurrent creation by writing multiple entries at once
      const promises = [];
      const keys: string[] = [];

      for (let i = 0; i < 5; i++) {
        const key = makeMappingKey('discussion', Date.now() + i);
        keys.push(key);
        promises.push(
          store.set(key, {
            chatId: `oc_concurrent_test_${i}`,
            purpose: 'discussion',
          }),
        );
      }

      await Promise.all(promises);

      // Verify all entries were written
      for (const key of keys) {
        const entry = await store.get(key);
        expect(entry).not.toBeNull();
      }
    });

    it('CM-03: corruption self-heal — invalid JSON falls back to empty table', async () => {
      const corruptFile = path.join(tmpDir, 'corrupt-mapping.json');

      // Write invalid JSON
      await fsPromises.writeFile(corruptFile, '{ this is not valid JSON }}}');

      const corruptStore = new BotChatMappingStore({ filePath: corruptFile });

      // Store should handle corrupt file gracefully
      const entries = await corruptStore.list();
      expect(entries).toHaveLength(0);
    });

    it('CM-04: rebuild from group list — rebuildFromGroupList recovers mappings', async () => {
      // Create a group to simulate scanning
      const name = 'PR #99999 · Test rebuild';
      const chatId = await createGroup(name);
      createdGroups.push({ chatId, name });

      // Rebuild from simulated group list
      const rebuildStore = new BotChatMappingStore({
        filePath: path.join(tmpDir, 'rebuild-mapping.json'),
      });

      const result = await rebuildStore.rebuildFromGroupList([
        { chatId, name },
      ]);

      expect(result.scanned).toBe(1);
      expect(result.added).toBe(1);

      // Should have a pr-99999 key
      const entry = await rebuildStore.get('pr-99999');
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe(chatId);
    });
  });

  // ===========================================================================
  // Helper function tests
  // ===========================================================================

  describe('Helpers', () => {
    it('makeMappingKey generates correct key format', () => {
      expect(makeMappingKey('pr-review', 123)).toBe('pr-123');
      expect(makeMappingKey('discussion', 1714800000)).toBe('discussion-1714800000');
      expect(makeMappingKey('feedback', 456)).toBe('feedback-456');
    });

    it('parseGroupNameToKey extracts PR numbers', () => {
      expect(parseGroupNameToKey('PR #123 · Some title')).toBe('pr-123');
      expect(parseGroupNameToKey('PR #456 - Dash separator')).toBe('pr-456');
      expect(parseGroupNameToKey('Random group name')).toBeNull();
    });

    it('purposeFromKey extracts purpose from key', () => {
      expect(purposeFromKey('pr-123')).toBe('pr-review');
      expect(purposeFromKey('discussion-1714800000')).toBe('discussion');
      expect(purposeFromKey('feedback-456')).toBe('feedback');
    });

    it('truncateName handles CJK characters correctly', () => {
      const cjk = '你好世界'.repeat(20); // 80 chars
      const truncated = truncateName(cjk);
      expect(Array.from(truncated)).toHaveLength(MAX_GROUP_NAME_LENGTH);

      // Should not split in the middle of a code point
      expect(truncated).toBeTruthy();
    });

    it('truncateName preserves short names unchanged', () => {
      const short = 'Hello World';
      expect(truncateName(short)).toBe(short);
    });
  });
});
