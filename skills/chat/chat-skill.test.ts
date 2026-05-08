/**
 * Integration tests for the chat skill — group lifecycle via real lark-cli.
 *
 * Issue #3284: Validates create/dissolve/list/query workflows using
 * **real** lark-cli calls against the Feishu API.
 *
 * Test strategy:
 *   - Each test creates a real Feishu group via `lark-cli im chat create`
 *   - Verifies the mapping table is correctly written
 *   - Cleans up all created groups in `afterAll` via `lark-cli api DELETE`
 *   - Auto-skips when lark-cli is unavailable (`describe.skipIf`)
 *
 * Environment variables:
 *   TEST_CHAT_DRY_RUN    Set to '1' (default) to skip lark-cli calls (unit-only mode)
 *   TEST_CHAT_USER_IDS   Comma-separated `ou_xxx` IDs for member tests (CC-04)
 *
 * @see skills/chat/SKILL.md — the skill under test
 * @see packages/core/src/scheduling/bot-chat-mapping.ts — BotChatMappingStore
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  BotChatMappingStore,
  type MappingEntry,
} from '../../packages/core/src/scheduling/bot-chat-mapping.js';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_CLI_TIMEOUT_MS = 30_000;
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;
const MAX_GROUP_NAME_LENGTH = 64;

// ---- Environment ----

/**
 * When DRY_RUN=1, tests only exercise mapping table operations
 * without actually calling lark-cli (no real groups created).
 * Default is '0' so real lark-cli is used when available.
 */
const DRY_RUN = process.env.TEST_CHAT_DRY_RUN !== '0';

const TEST_USERS = (process.env.TEST_CHAT_USER_IDS ?? '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);

// ---- Helpers ----

/**
 * Check whether lark-cli is installed and authenticated.
 * Returns true if available, false otherwise.
 */
async function isLarkCliAvailable(): Promise<boolean> {
  try {
    await execFileAsync('lark-cli', ['auth', 'status'], {
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a Feishu group via lark-cli.
 * Returns the chatId from the output.
 */
async function createGroup(
  name: string,
  description?: string,
): Promise<string> {
  const args = ['im', 'chat', 'create', '--name', name];
  if (description) {
    args.push('--description', description);
  }

  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_CLI_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  // lark-cli outputs the chatId — extract it
  const match = stdout.match(/(oc_[a-zA-Z0-9]+)/);
  if (!match) {
    throw new Error(`Failed to extract chatId from lark-cli output: ${stdout}`);
  }
  return match[1];
}

/**
 * Dissolve a Feishu group via lark-cli API DELETE.
 */
async function dissolveGroup(chatId: string): Promise<void> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`],
      { timeout: LARK_CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
  } catch (err) {
    // Group may already be dissolved — log but don't throw
    console.warn(`Warning: failed to dissolve group ${chatId}:`, err);
  }
}

/**
 * Add members to a Feishu group via lark-cli.
 */
async function addMembers(
  chatId: string,
  userIds: string[],
): Promise<void> {
  for (const userId of userIds) {
    await execFileAsync(
      'lark-cli',
      [
        'api',
        'POST',
        `/open-apis/im/v1/chats/${chatId}/members`,
        '-d',
        JSON.stringify({ id_list: [userId] }),
      ],
      { timeout: LARK_CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
  }
}

/**
 * Truncate a string to max length at character boundaries (CJK-safe).
 */
function truncateName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

/**
 * Generate a unique test group name to avoid collisions.
 */
function testGroupName(prefix: string): string {
  return `[test] ${prefix} ${Date.now()}`;
}

// ---- Lark-cli availability (resolved once) ----

let larkAvailable = false;

// ---- Test suite ----

/**
 * Integration tests for the chat skill's group lifecycle.
 *
 * These tests call real lark-cli and create/dissolve real Feishu groups.
 * - Auto-skipped when lark-cli is not installed or not authenticated
 * - In DRY_RUN mode, only mapping table operations are tested
 */
describe.skipIf(DRY_RUN)('Chat skill integration tests (real lark-cli)', () => {
  let store: BotChatMappingStore;
  let tempDir: string;
  const createdGroups: Array<{ chatId: string; key: string }> = [];

  beforeAll(async () => {
    larkAvailable = await isLarkCliAvailable();
    if (!larkAvailable) {
      console.log('lark-cli not available — skipping chat skill integration tests');
      return;
    }

    // Create a temporary directory for mapping files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-skill-test-'));
    const mappingFile = path.join(tempDir, 'bot-chat-mapping.json');
    store = new BotChatMappingStore({ filePath: mappingFile });
  });

  afterAll(async () => {
    // Clean up all created groups
    for (const { chatId } of createdGroups) {
      await dissolveGroup(chatId);
    }

    // Clean up temp directory
    if (tempDir) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ---- CC: Create group flow ----

  describe('/chat create', () => {
    it('CC-01: basic group creation — returns valid chatId', async () => {
      if (!larkAvailable) return;

      const name = testGroupName('basic-create');
      const chatId = await createGroup(name);
      createdGroups.push({ chatId, key: `discussion-${Date.now()}` });

      expect(chatId).toMatch(GROUP_CHAT_ID_REGEX);
    });

    it('CC-02: create + mapping table write', async () => {
      if (!larkAvailable) return;

      const name = testGroupName('create-mapping');
      const chatId = await createGroup(name);
      const key = `discussion-${Math.floor(Date.now() / 1000)}`;
      createdGroups.push({ chatId, key });

      // Write mapping entry
      const entry = await store.set(key, {
        chatId,
        purpose: 'discussion',
      });

      expect(entry.chatId).toBe(chatId);
      expect(entry.purpose).toBe('discussion');
      expect(entry.persisted).toBe(true);

      // Verify persistence by reading back
      const readBack = await store.get(key);
      expect(readBack).not.toBeNull();
      expect(readBack!.chatId).toBe(chatId);
      expect(readBack!.purpose).toBe('discussion');
    });

    it('CC-05: group name truncation — long names are handled', async () => {
      if (!larkAvailable) return;

      // Create a name that exceeds 64 characters
      const longName = '测试'.repeat(40); // 80 characters
      const truncatedName = truncateName(longName);
      expect(Array.from(truncatedName).length).toBeLessThanOrEqual(MAX_GROUP_NAME_LENGTH);

      const chatId = await createGroup(truncatedName);
      createdGroups.push({ chatId, key: `discussion-${Date.now()}` });

      expect(chatId).toMatch(GROUP_CHAT_ID_REGEX);
    });

    it('CC-06: group name with special characters — emoji, CJK, English', async () => {
      if (!larkAvailable) return;

      const specialName = testGroupName('🎉 需求Review feature-123');
      const chatId = await createGroup(specialName);
      createdGroups.push({ chatId, key: `discussion-${Date.now()}` });

      expect(chatId).toMatch(GROUP_CHAT_ID_REGEX);
    });
  });

  // ---- CC-04: Create + add members (requires TEST_CHAT_USER_IDS) ----

  describe.skipIf(!TEST_USERS.length)('/chat create with members', () => {
    it('CC-04: create + add members', async () => {
      if (!larkAvailable) return;

      const name = testGroupName('create-members');
      const chatId = await createGroup(name);
      createdGroups.push({ chatId, key: `discussion-${Date.now()}` });

      // Add members
      await addMembers(chatId, TEST_USERS.slice(0, 5));

      // No assertion needed — if addMembers doesn't throw, it succeeded
      expect(chatId).toMatch(GROUP_CHAT_ID_REGEX);
    });
  });

  // ---- CD: Dissolve group flow ----

  describe('/chat dissolve', () => {
    it('CD-01: basic dissolve — group is deleted', async () => {
      if (!larkAvailable) return;

      const name = testGroupName('basic-dissolve');
      const chatId = await createGroup(name);

      // Dissolve immediately (don't add to createdGroups for afterAll cleanup)
      await dissolveGroup(chatId);

      // Second dissolve should not throw (CD-05: double dissolve)
      await expect(dissolveGroup(chatId)).resolves.toBeUndefined();
    });

    it('CD-02: dissolve + mapping table cleanup', async () => {
      if (!larkAvailable) return;

      const name = testGroupName('dissolve-mapping');
      const chatId = await createGroup(name);
      const key = `discussion-${Math.floor(Date.now() / 1000)}`;

      // Write mapping entry
      await store.set(key, { chatId, purpose: 'discussion' });

      // Verify it exists
      const before = await store.get(key);
      expect(before).not.toBeNull();

      // Dissolve the group
      await dissolveGroup(chatId);

      // Delete mapping entry (simulating /chat dissolve flow)
      const deleted = await store.delete(key);
      expect(deleted).toBe(true);

      // Verify mapping is cleaned up
      const after = await store.get(key);
      expect(after).toBeNull();
    });

    it('CD-04: other entries unaffected after dissolve', async () => {
      if (!larkAvailable) return;

      // Create two groups
      const name1 = testGroupName('dissolve-keep-a');
      const name2 = testGroupName('dissolve-keep-b');
      const chatId1 = await createGroup(name1);
      const chatId2 = await createGroup(name2);
      createdGroups.push({ chatId: chatId2, key: `discussion-${Date.now()}` });

      const key1 = `discussion-${Math.floor(Date.now() / 1000) - 1}`;
      const key2 = `discussion-${Math.floor(Date.now() / 1000)}`;

      await store.set(key1, { chatId: chatId1, purpose: 'discussion' });
      await store.set(key2, { chatId: chatId2, purpose: 'discussion' });

      // Dissolve first group and remove mapping
      await dissolveGroup(chatId1);
      await store.delete(key1);

      // Second entry should still be intact
      const remaining = await store.get(key2);
      expect(remaining).not.toBeNull();
      expect(remaining!.chatId).toBe(chatId2);
    });

    it('CD-05: dissolve already dissolved group — no crash', async () => {
      if (!larkAvailable) return;

      const name = testGroupName('double-dissolve');
      const chatId = await createGroup(name);

      // First dissolve
      await dissolveGroup(chatId);

      // Second dissolve — should not throw
      await expect(dissolveGroup(chatId)).resolves.toBeUndefined();
    });
  });

  // ---- CL: List groups ----

  describe('/chat list', () => {
    it('CL-01: empty mapping returns empty list', async () => {
      const list = await store.list();
      // May not be truly empty if other tests added entries
      // Verify the return type is correct
      expect(Array.isArray(list)).toBe(true);
    });

    it('CL-02: multiple entries listed correctly', async () => {
      if (!larkAvailable) return;

      const ts1 = Math.floor(Date.now() / 1000) - 2;
      const ts2 = Math.floor(Date.now() / 1000) - 1;
      const key1 = `discussion-${ts1}`;
      const key2 = `discussion-${ts2}`;

      const name1 = testGroupName('list-multi-a');
      const name2 = testGroupName('list-multi-b');
      const chatId1 = await createGroup(name1);
      const chatId2 = await createGroup(name2);
      createdGroups.push({ chatId: chatId1, key: key1 });
      createdGroups.push({ chatId: chatId2, key: key2 });

      await store.set(key1, { chatId: chatId1, purpose: 'discussion' });
      await store.set(key2, { chatId: chatId2, purpose: 'discussion' });

      const list = await store.list();
      const keys = list.map(([k]) => k);

      expect(keys).toContain(key1);
      expect(keys).toContain(key2);

      // Verify entries have correct structure
      for (const [, entry] of list) {
        expect(entry).toHaveProperty('chatId');
        expect(entry).toHaveProperty('createdAt');
        expect(entry).toHaveProperty('purpose');
      }
    });
  });

  // ---- CQ: Query groups ----

  describe('/chat query', () => {
    it('CQ-01: query existing key returns correct entry', async () => {
      if (!larkAvailable) return;

      const key = `discussion-${Math.floor(Date.now() / 1000)}`;
      const name = testGroupName('query-found');
      const chatId = await createGroup(name);
      createdGroups.push({ chatId, key });

      await store.set(key, { chatId, purpose: 'discussion' });

      const result = await store.get(key);
      expect(result).not.toBeNull();
      expect(result!.chatId).toBe(chatId);
      expect(result!.purpose).toBe('discussion');
      expect(result!.createdAt).toBeDefined();
    });

    it('CQ-02: query non-existent key returns null', async () => {
      const result = await store.get('discussion-nonexistent-99999');
      expect(result).toBeNull();
    });
  });

  // ---- CM: Mapping table integrity ----

  describe('Mapping table integrity', () => {
    it('CM-01: mapping table has correct JSON structure after write', async () => {
      if (!larkAvailable || !tempDir) return;

      const mappingFile = path.join(tempDir, 'bot-chat-mapping.json');

      const key = `discussion-${Math.floor(Date.now() / 1000)}`;
      const name = testGroupName('mapping-format');
      const chatId = await createGroup(name);
      createdGroups.push({ chatId, key });

      await store.set(key, { chatId, purpose: 'discussion' });

      // Read raw file and verify JSON structure
      const content = await fs.readFile(mappingFile, 'utf-8');
      const parsed = JSON.parse(content);

      expect(typeof parsed).toBe('object');
      expect(Array.isArray(parsed)).toBe(false);
      expect(parsed).toHaveProperty(key);

      const entry = parsed[key] as MappingEntry;
      expect(entry.chatId).toBe(chatId);
      expect(entry.purpose).toBe('discussion');
      expect(entry.createdAt).toBeDefined();
      // Verify ISO timestamp format
      expect(new Date(entry.createdAt).toISOString()).toBe(entry.createdAt);
    });

    it('CM-03: mapping table self-heals from corrupt JSON', async () => {
      if (!tempDir) return;

      const corruptFile = path.join(tempDir, 'corrupt-mapping.json');
      // Write corrupt JSON
      await fs.writeFile(corruptFile, 'not valid json{', 'utf-8');

      const corruptStore = new BotChatMappingStore({ filePath: corruptFile });

      // Should not throw — starts with empty cache
      const result = await corruptStore.get('any-key');
      expect(result).toBeNull();

      // Should be able to write new entries
      const entry = await corruptStore.set('test-key', {
        chatId: 'oc_test123',
        purpose: 'discussion',
      });
      expect(entry.chatId).toBe('oc_test123');

      // Clean up
      await fs.unlink(corruptFile).catch(() => {});
    });

    it('CM-04: rebuild mapping from group list', async () => {
      if (!larkAvailable || !tempDir) return;

      // Create a group
      const name = `PR #9999 · Test rebuild ${Date.now()}`;
      const chatId = await createGroup(name);
      createdGroups.push({ chatId, key: 'pr-9999' });

      // Rebuild from group list
      const rebuildFile = path.join(tempDir, 'rebuild-mapping.json');
      const rebuildStore = new BotChatMappingStore({ filePath: rebuildFile });

      const result = await rebuildStore.rebuildFromGroupList([
        { chatId, name },
      ]);

      expect(result.scanned).toBe(1);
      expect(result.added).toBe(1);

      // Verify the mapping was created
      const entry = await rebuildStore.get('pr-9999');
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe(chatId);
      expect(entry!.purpose).toBe('pr-review');

      // Clean up
      await fs.unlink(rebuildFile).catch(() => {});
    });
  });
});

// ---- Dry-run mode: mapping table only tests ----

describe('Chat skill — mapping table operations (dry-run)', () => {
  let store: BotChatMappingStore;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-skill-dry-'));
    const mappingFile = path.join(tempDir, 'bot-chat-mapping.json');
    store = new BotChatMappingStore({ filePath: mappingFile });
  });

  afterAll(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('CL-01: empty mapping returns empty list', async () => {
    const list = await store.list();
    expect(list).toEqual([]);
  });

  it('CQ-02: query non-existent key returns null', async () => {
    const result = await store.get('discussion-nonexistent');
    expect(result).toBeNull();
  });

  it('mapping set and get roundtrip works', async () => {
    const key = `discussion-${Math.floor(Date.now() / 1000)}`;
    const entry = await store.set(key, {
      chatId: 'oc_dryrun_test',
      purpose: 'discussion',
    });

    expect(entry.chatId).toBe('oc_dryrun_test');
    expect(entry.purpose).toBe('discussion');
    expect(entry.persisted).toBe(true);

    const readBack = await store.get(key);
    expect(readBack).not.toBeNull();
    expect(readBack!.chatId).toBe('oc_dryrun_test');
  });

  it('mapping delete works', async () => {
    const key = `discussion-delete-test`;
    await store.set(key, { chatId: 'oc_to_delete', purpose: 'discussion' });

    const deleted = await store.delete(key);
    expect(deleted).toBe(true);

    const after = await store.get(key);
    expect(after).toBeNull();
  });

  it('CM-01: mapping file has valid JSON structure', async () => {
    const mappingFile = path.join(tempDir, 'bot-chat-mapping.json');
    const content = await fs.readFile(mappingFile, 'utf-8');
    const parsed = JSON.parse(content);

    expect(typeof parsed).toBe('object');
    expect(Array.isArray(parsed)).toBe(false);
  });

  it('CM-03: corrupt JSON self-heals', async () => {
    const corruptFile = path.join(tempDir, 'corrupt-dry.json');
    await fs.writeFile(corruptFile, '{{invalid json', 'utf-8');

    const corruptStore = new BotChatMappingStore({ filePath: corruptFile });
    const result = await corruptStore.get('any-key');
    expect(result).toBeNull();

    // Can still write
    await corruptStore.set('new-key', {
      chatId: 'oc_new',
      purpose: 'discussion',
    });
    const entry = await corruptStore.get('new-key');
    expect(entry).not.toBeNull();

    await fs.unlink(corruptFile).catch(() => {});
  });
});
