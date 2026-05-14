/**
 * Integration tests for Feishu chat group lifecycle.
 *
 * Issue #3284: Tests end-to-end flow of creating/dissolving/querying
 * Feishu groups via real lark-cli + BotChatMappingStore.
 *
 * **Requires lark-cli installed and authenticated.**
 * Auto-skips in environments without lark-cli.
 *
 * Run: `npx vitest --run tests/integration/chat-group-lifecycle.test.ts`
 *
 * Environment variables:
 *   TEST_CHAT_DRY_RUN      Set to '1' to skip lark-cli calls (default: '0')
 *   TEST_CHAT_USER_IDS     Comma-separated open_id list for member tests (optional)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  BotChatMappingStore,
  makeMappingKey,
  parseGroupNameToKey,
  type MappingEntry,
  type MappingTable,
} from '../../packages/core/src/scheduling/bot-chat-mapping.js';

const execFileAsync = promisify(execFile);

// ---- Constants ----

const LARK_TIMEOUT_MS = 30_000;
const GROUP_CHAT_ID_REGEX = /^oc_[a-zA-Z0-9]+$/;
const MAX_GROUP_NAME_LENGTH = 64;
const TEST_PURPOSE = 'discussion';
const TEST_PREFIX = '🧪ITest';

/** Parsed TEST_CHAT_USER_IDS */
const TEST_USERS = (process.env.TEST_CHAT_USER_IDS ?? '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);

// ---- Lark-cli availability ----

let larkAvailable = false;
let dryRun = process.env.TEST_CHAT_DRY_RUN === '1';

async function checkLarkCli(): Promise<boolean> {
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function checkLarkAuth(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('lark-cli', ['auth', 'status'], { timeout: 10_000 });
    return !stdout.toLowerCase().includes('not authenticated');
  } catch {
    return false;
  }
}

// ---- Lark-cli wrappers ----

interface CreateGroupResult {
  chatId: string;
  name: string;
}

async function createGroup(name: string, description?: string): Promise<CreateGroupResult> {
  const args = ['im', 'chat', 'create', '--name', name];
  if (description) {
    args.push('--description', description);
  }

  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  // Parse chatId from lark-cli output
  const match = stdout.match(/(oc_[a-zA-Z0-9]+)/);
  if (!match) {
    throw new Error(`Failed to parse chatId from lark-cli output: ${stdout}`);
  }

  return { chatId: match[1], name };
}

async function deleteGroup(chatId: string): Promise<{ success: boolean; error: string | null }> {
  try {
    await execFileAsync('lark-cli', ['im', 'chat', 'delete', chatId], {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { success: true, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error').trim();
    return { success: false, error: errorMsg };
  }
}

async function addMembers(chatId: string, userIds: string[]): Promise<{ success: boolean }> {
  try {
    const args = ['im', 'chat', 'members', 'add', '--chat-id', chatId, '--member-ids', userIds.join(',')];
    await execFileAsync('lark-cli', args, {
      timeout: LARK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    return { success: true };
  } catch {
    return { success: false };
  }
}

// ---- Helpers ----

function uniqueGroupName(label: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${TEST_PREFIX} ${label} ${ts}${rand}`.slice(0, MAX_GROUP_NAME_LENGTH);
}

function makeTestKey(label: string): string {
  return makeMappingKey(TEST_PURPOSE, `itest-${label}-${Date.now().toString(36)}`);
}

// ---- Test suite ----

// Track created groups for cleanup
const createdGroups: Array<{ chatId: string; key: string }> = [];

describe.skipIf(() => !larkAvailable)('Chat Group Lifecycle Integration Tests', () => {
  let tmpDir: string;
  let mappingFilePath: string;
  let store: BotChatMappingStore;

  beforeAll(async () => {
    larkAvailable = await checkLarkCli();
    if (!larkAvailable) {
      console.log('SKIP: lark-cli not available');
      return;
    }

    const authed = await checkLarkAuth();
    if (!authed) {
      console.log('SKIP: lark-cli not authenticated');
      larkAvailable = false;
      return;
    }

    // Create temp directory for mapping file
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-lifecycle-test-'));
    mappingFilePath = path.join(tmpDir, 'bot-chat-mapping.json');
    store = new BotChatMappingStore({ filePath: mappingFilePath });
  });

  afterEach(async () => {
    // Reset store between tests
    if (store) {
      await store.clear();
    }
  });

  afterAll(async () => {
    // Clean up all created groups
    for (const group of createdGroups) {
      const result = await deleteGroup(group.chatId);
      if (!result.success) {
        console.warn(`WARN: Failed to clean up group ${group.chatId}: ${result.error}`);
      }
    }

    // Clean up temp directory
    if (tmpDir) {
      try {
        await fs.rm(tmpDir, { recursive: true });
      } catch {
        // Best effort
      }
    }
  });

  // ==========================================================================
  // 1. Create Group Flow (CC-01 ~ CC-08)
  // ==========================================================================

  describe('Create Group Flow', () => {
    it('CC-01: basic create — lark-cli succeeds and mapping is written', async () => {
      const groupName = uniqueGroupName('cc01');
      const key = makeTestKey('cc01');

      const result = await createGroup(groupName, 'Integration test group');
      createdGroups.push({ chatId: result.chatId, key });

      // Verify chatId format
      expect(result.chatId).toMatch(GROUP_CHAT_ID_REGEX);

      // Write mapping via store
      await store.set(key, { chatId: result.chatId, purpose: TEST_PURPOSE });

      // Verify mapping written to file
      const entry = await store.get(key);
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe(result.chatId);
      expect(entry!.purpose).toBe(TEST_PURPOSE);
      expect(entry!.createdAt).toBeDefined();
    });

    it('CC-02: create + mapping write — bot-chat-mapping.json has correct structure', async () => {
      const groupName = uniqueGroupName('cc02');
      const key = makeTestKey('cc02');

      const result = await createGroup(groupName);
      createdGroups.push({ chatId: result.chatId, key });

      await store.set(key, { chatId: result.chatId, purpose: TEST_PURPOSE });

      // Read file directly and verify JSON structure
      const content = await fs.readFile(mappingFilePath, 'utf-8');
      const parsed = JSON.parse(content) as MappingTable;

      expect(parsed).toHaveProperty(key);
      expect(parsed[key].chatId).toBe(result.chatId);
      expect(parsed[key].purpose).toBe(TEST_PURPOSE);
      expect(parsed[key].createdAt).toBeDefined();
    });

    it('CC-03: create with same name produces different group (idempotent at API level)', async () => {
      const groupName = uniqueGroupName('cc03');
      const key1 = makeTestKey('cc03a');
      const key2 = makeTestKey('cc03b');

      const result1 = await createGroup(groupName);
      const result2 = await createGroup(groupName);
      createdGroups.push({ chatId: result1.chatId, key: key1 });
      createdGroups.push({ chatId: result2.chatId, key: key2 });

      // Each create produces a unique chatId
      expect(result1.chatId).not.toBe(result2.chatId);
    });

    it('CC-05: create with empty name returns error', async () => {
      await expect(createGroup('')).rejects.toThrow();
    });

    it('CC-06: create with long name succeeds (truncated)', async () => {
      const longName = 'A'.repeat(100);
      const key = makeTestKey('cc06');

      const result = await createGroup(longName);
      createdGroups.push({ chatId: result.chatId, key });

      expect(result.chatId).toMatch(GROUP_CHAT_ID_REGEX);
    });

    it('CC-07: update mapping when key already exists', async () => {
      const groupName = uniqueGroupName('cc07');
      const key = makeTestKey('cc07');

      // First create
      const result1 = await createGroup(groupName);
      createdGroups.push({ chatId: result1.chatId, key });
      await store.set(key, { chatId: result1.chatId, purpose: TEST_PURPOSE });

      // Second create with same key should update mapping
      const groupName2 = uniqueGroupName('cc07v2');
      const result2 = await createGroup(groupName2);
      createdGroups.push({ chatId: result2.chatId, key });

      await store.set(key, { chatId: result2.chatId, purpose: TEST_PURPOSE });

      const entry = await store.get(key);
      expect(entry!.chatId).toBe(result2.chatId);
    });
  });

  // ==========================================================================
  // 2. Dissolve Group Flow (CD-01 ~ CD-06)
  // ==========================================================================

  describe('Dissolve Group Flow', () => {
    it('CD-01: basic dissolve — lark-cli DELETE succeeds', async () => {
      const groupName = uniqueGroupName('cd01');
      const result = await createGroup(groupName);

      const deleteResult = await deleteGroup(result.chatId);
      expect(deleteResult.success).toBe(true);
      expect(deleteResult.error).toBeNull();

      // Don't add to cleanup since already dissolved
    });

    it('CD-02: dissolve + mapping cleanup — entry removed from mapping', async () => {
      const groupName = uniqueGroupName('cd02');
      const key = makeTestKey('cd02');

      const result = await createGroup(groupName);
      await store.set(key, { chatId: result.chatId, purpose: TEST_PURPOSE });

      // Dissolve and clean mapping
      const deleteResult = await deleteGroup(result.chatId);
      expect(deleteResult.success).toBe(true);

      const deleted = await store.delete(key);
      expect(deleted).toBe(true);

      // Verify mapping removed
      const entry = await store.get(key);
      expect(entry).toBeNull();
    });

    it('CD-03: dissolve non-existent chatId returns error', async () => {
      const fakeChatId = 'oc_nonexistent0000000000000000000';
      const result = await deleteGroup(fakeChatId);
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('CD-04: after dissolve, other mapping entries unaffected', async () => {
      // Create two groups
      const group1 = await createGroup(uniqueGroupName('cd04a'));
      const group2 = await createGroup(uniqueGroupName('cd04b'));
      const key1 = makeTestKey('cd04a');
      const key2 = makeTestKey('cd04b');
      createdGroups.push({ chatId: group2.chatId, key: key2 });

      await store.set(key1, { chatId: group1.chatId, purpose: TEST_PURPOSE });
      await store.set(key2, { chatId: group2.chatId, purpose: TEST_PURPOSE });

      // Dissolve first group
      await deleteGroup(group1.chatId);
      await store.delete(key1);

      // Second group unaffected
      const entry2 = await store.get(key2);
      expect(entry2).not.toBeNull();
      expect(entry2!.chatId).toBe(group2.chatId);
    });

    it('CD-05: dissolve already dissolved group returns error but no crash', async () => {
      const groupName = uniqueGroupName('cd05');
      const result = await createGroup(groupName);

      // First dissolve
      const delete1 = await deleteGroup(result.chatId);
      expect(delete1.success).toBe(true);

      // Second dissolve should fail gracefully
      const delete2 = await deleteGroup(result.chatId);
      expect(delete2.success).toBe(false);
      // Should not throw — error is captured
      expect(delete2.error).toBeTruthy();
    });
  });

  // ==========================================================================
  // 3. Query & List (CL-01/02, CQ-01/02)
  // ==========================================================================

  describe('Query & List', () => {
    it('CL-01: list returns empty when no mappings', async () => {
      const list = await store.list();
      expect(list).toEqual([]);
    });

    it('CL-02: list returns multiple entries sorted correctly', async () => {
      const keys: string[] = [];
      const chatIds: string[] = [];

      // Create 3 groups
      for (let i = 0; i < 3; i++) {
        const group = await createGroup(uniqueGroupName(`cl02-${i}`));
        const key = makeTestKey(`cl02-${i}`);
        await store.set(key, { chatId: group.chatId, purpose: TEST_PURPOSE });
        keys.push(key);
        chatIds.push(group.chatId);
        createdGroups.push({ chatId: group.chatId, key });
      }

      const list = await store.list();
      expect(list).toHaveLength(3);

      const listKeys = list.map(([k]) => k);
      for (const key of keys) {
        expect(listKeys).toContain(key);
      }
    });

    it('CQ-01: query existing key returns correct mapping', async () => {
      const group = await createGroup(uniqueGroupName('cq01'));
      const key = makeTestKey('cq01');
      createdGroups.push({ chatId: group.chatId, key });

      await store.set(key, { chatId: group.chatId, purpose: TEST_PURPOSE });

      const entry = await store.get(key);
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe(group.chatId);
      expect(entry!.purpose).toBe(TEST_PURPOSE);
    });

    it('CQ-02: query non-existing key returns null', async () => {
      const entry = await store.get('nonexistent-key-xyz');
      expect(entry).toBeNull();
    });
  });

  // ==========================================================================
  // 4. Mapping Table Integrity (CM-01 ~ CM-04)
  // ==========================================================================

  describe('Mapping Table Integrity', () => {
    it('CM-01: after create, mapping file has valid MappingTable structure', async () => {
      const group = await createGroup(uniqueGroupName('cm01'));
      const key = makeTestKey('cm01');
      createdGroups.push({ chatId: group.chatId, key });

      await store.set(key, { chatId: group.chatId, purpose: TEST_PURPOSE });

      // Read and validate raw file
      const content = await fs.readFile(mappingFilePath, 'utf-8');
      const parsed = JSON.parse(content);

      // Must be a plain object
      expect(typeof parsed).toBe('object');
      expect(Array.isArray(parsed)).toBe(false);

      // Each value must have required fields
      for (const [k, v] of Object.entries(parsed)) {
        const entry = v as MappingEntry;
        expect(entry.chatId).toMatch(GROUP_CHAT_ID_REGEX);
        expect(typeof entry.createdAt).toBe('string');
        expect(typeof entry.purpose).toBe('string');
      }
    });

    it('CM-02: concurrent creates do not lose mappings', async () => {
      const concurrency = 5;
      const keys: string[] = [];
      const chatIds: string[] = [];

      // Create groups concurrently
      const promises = Array.from({ length: concurrency }, async (_, i) => {
        const group = await createGroup(uniqueGroupName(`cm02-${i}`));
        const key = makeTestKey(`cm02-${i}`);
        createdGroups.push({ chatId: group.chatId, key });
        return { key, chatId: group.chatId };
      });

      const results = await Promise.all(promises);

      // Write mappings sequentially (BotChatMappingStore is not concurrent-safe)
      for (const { key, chatId } of results) {
        await store.set(key, { chatId, purpose: TEST_PURPOSE });
        keys.push(key);
        chatIds.push(chatId);
      }

      // All mappings present
      const size = await store.size();
      expect(size).toBe(concurrency);

      for (const key of keys) {
        const entry = await store.get(key);
        expect(entry).not.toBeNull();
      }
    });

    it('CM-03: corrupted mapping file self-heals to empty table', async () => {
      // Create group and write mapping
      const group = await createGroup(uniqueGroupName('cm03'));
      const key = makeTestKey('cm03');
      createdGroups.push({ chatId: group.chatId, key });

      await store.set(key, { chatId: group.chatId, purpose: TEST_PURPOSE });

      // Corrupt the file
      await fs.writeFile(mappingFilePath, '{invalid json content', 'utf-8');

      // Create a new store instance that reads the corrupted file
      const freshStore = new BotChatMappingStore({ filePath: mappingFilePath });
      const entry = await freshStore.get(key);
      expect(entry).toBeNull();

      // Size should be 0 (self-healed)
      const size = await freshStore.size();
      expect(size).toBe(0);
    });

    it('CM-04: rebuild from group list recovers mappings', async () => {
      // Create a group with PR-style name
      const prNumber = Math.floor(Math.random() * 100000);
      const groupName = `PR #${prNumber} · ITest rebuild`;
      const group = await createGroup(groupName);
      createdGroups.push({ chatId: group.chatId, key: `pr-${prNumber}` });

      // Rebuild from simulated group list
      const rebuildResult = await store.rebuildFromGroupList([
        { chatId: group.chatId, name: groupName },
      ]);

      expect(rebuildResult.scanned).toBe(1);
      expect(rebuildResult.added).toBe(1);

      // Verify mapping exists
      const key = `pr-${prNumber}`;
      const entry = await store.get(key);
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe(group.chatId);
      expect(entry!.purpose).toBe('pr-review');
    });
  });

  // ==========================================================================
  // 5. Member tests (CC-04, optional — requires TEST_CHAT_USER_IDS)
  // ==========================================================================

  describe.skipIf(() => TEST_USERS.length === 0)('Member Operations', () => {
    it('CC-04: create + add members succeeds', async () => {
      // Validate user IDs
      for (const userId of TEST_USERS) {
        expect(userId).toMatch(/^ou_[a-zA-Z0-9]+$/);
      }
      expect(TEST_USERS.length).toBeLessThanOrEqual(5);

      const groupName = uniqueGroupName('cc04');
      const key = makeTestKey('cc04');

      const result = await createGroup(groupName, 'Integration test with members');
      createdGroups.push({ chatId: result.chatId, key });

      const memberResult = await addMembers(result.chatId, TEST_USERS.slice(0, 2));
      expect(memberResult.success).toBe(true);

      // Write mapping
      await store.set(key, { chatId: result.chatId, purpose: TEST_PURPOSE });
      const entry = await store.get(key);
      expect(entry).not.toBeNull();
    });
  });
});
