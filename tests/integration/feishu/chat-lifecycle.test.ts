/**
 * Chat lifecycle integration tests — real lark-cli end-to-end tests.
 *
 * Tests the full pipeline for creating, dissolving, listing, and querying
 * Feishu discussion groups using real lark-cli commands and BotChatMappingStore.
 *
 * **These tests call real Feishu APIs via lark-cli.**
 * They are skipped by default. Run with:
 *
 *   FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu/chat-lifecycle
 *
 * Prerequisites:
 *   - lark-cli installed and authenticated (`lark auth status` passes)
 *   - Bot has permission to create/dissolve groups
 *   - TEST_CHAT_USER_IDS (optional): comma-separated ou_xxx IDs for member tests
 *
 * @see Issue #3284 — 建群与解散群集成测试用例设计
 * @see Issue #3283 — 通用建群 Skill (the feature these tests validate)
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  describeIfChat,
  CHAT_ID_REGEX,
  createGroup,
  dissolveGroup,
  addGroupMembers,
  isLarkCliAvailable,
  createTempDir,
  cleanupTempDir,
  createTestMappingStore,
  truncateGroupName,
  getTestUserIds,
  makeMappingKey,
} from './chat-lifecycle-helpers.js';
import type { BotChatMappingStore } from '../../../packages/core/src/scheduling/index.js';

// ---- Test-wide state ----

/** Track all created group chatIds for cleanup in afterAll. */
const createdChatIds: string[] = [];

/** Temp directory for test mapping files. */
let tempDir: string;

/** BotChatMappingStore instance for mapping tests. */
let mappingStore: BotChatMappingStore;

/** Whether lark-cli is actually available in this environment. */
let larkAvailable = false;

/** Test user IDs for member tests (null if not configured). */
let testUserIds: string[] | null = null;

// ---- Setup & Teardown ----

describeIfChat('Chat lifecycle integration tests (real lark-cli)', () => {
  beforeAll(async () => {
    // Verify lark-cli is actually available
    larkAvailable = await isLarkCliAvailable();
    if (!larkAvailable) {
      console.warn(
        'SKIP: lark-cli not found in PATH — chat lifecycle tests will be skipped',
      );
    }

    // Parse optional test user IDs
    try {
      testUserIds = getTestUserIds();
    } catch (err) {
      console.warn(`SKIP: ${(err as Error).message}`);
      testUserIds = null;
    }

    // Create temp dir and mapping store
    tempDir = createTempDir();
    mappingStore = createTestMappingStore(tempDir);
  });

  afterAll(async () => {
    // Clean up: dissolve all created groups
    for (const chatId of createdChatIds) {
      try {
        await dissolveGroup(chatId);
      } catch {
        // Best-effort cleanup — don't fail the test suite
      }
    }

    // Remove temp directory
    if (tempDir) {
      cleanupTempDir(tempDir);
    }
  });

  // ---- CC — Create Group Tests ----

  describe('CC — Create group', () => {
    it('CC-01: should create a group and return valid chatId', async () => {
      if (!larkAvailable) return;

      const name = `Test CC-01 ${Date.now()}`;
      const result = await createGroup(name);

      expect(result.success).toBe(true);
      expect(result.chatId).not.toBeNull();
      expect(result.chatId).toMatch(CHAT_ID_REGEX);

      // Track for cleanup
      createdChatIds.push(result.chatId!);
    });

    it('CC-02: should create group and write mapping entry', async () => {
      if (!larkAvailable) return;

      const timestamp = Date.now();
      const name = `Test CC-02 ${timestamp}`;
      const result = await createGroup(name, 'Integration test: CC-02');

      expect(result.success).toBe(true);
      expect(result.chatId).not.toBeNull();
      createdChatIds.push(result.chatId!);

      // Write mapping entry
      const key = makeMappingKey('discussion', timestamp);
      const entry = await mappingStore.set(key, {
        chatId: result.chatId!,
        purpose: 'discussion',
      });

      expect(entry.chatId).toBe(result.chatId);
      expect(entry.purpose).toBe('discussion');
      expect(entry.createdAt).toBeDefined();
      expect(entry.persisted).toBe(true);

      // Verify retrieval
      const retrieved = await mappingStore.get(key);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.chatId).toBe(result.chatId);
    });

    it('CC-04: should create group and add members', async () => {
      if (!larkAvailable) return;
      if (!testUserIds || testUserIds.length === 0) return;

      const name = `Test CC-04 ${Date.now()}`;
      const result = await createGroup(name, 'Integration test: CC-04');

      expect(result.success).toBe(true);
      expect(result.chatId).not.toBeNull();
      createdChatIds.push(result.chatId!);

      // Add members
      const memberResult = await addGroupMembers(result.chatId!, testUserIds);
      expect(memberResult.success).toBe(true);
    });

    it('CC-05: should truncate group names exceeding 64 characters (CJK safe)', async () => {
      if (!larkAvailable) return;

      // Build a name that's 80 characters long with mixed CJK and ASCII
      const longName = '测试'.repeat(20) + 'abcdefghij'; // 40 + 10 = 50 chars, under 64
      const veryLongName = '测试'.repeat(30) + 'extra padding here'; // 60 + 17 = 77 chars
      const truncated = truncateGroupName(veryLongName);

      // Verify truncation at character boundary
      expect(Array.from(truncated).length).toBeLessThanOrEqual(64);

      const result = await createGroup(veryLongName);

      expect(result.success).toBe(true);
      expect(result.chatId).not.toBeNull();
      createdChatIds.push(result.chatId!);
    });

    it('CC-06: should handle group names with special characters (emoji, Chinese, English)', async () => {
      if (!larkAvailable) return;

      const specialName = `测试Test🎉特殊字符${Date.now()}`;
      const result = await createGroup(specialName, 'Mixed emoji + CJK + ASCII');

      expect(result.success).toBe(true);
      expect(result.chatId).not.toBeNull();
      createdChatIds.push(result.chatId!);
    });

    it('CC-07: should return error when lark-cli is not available', async () => {
      // This test validates the skip/error path when lark-cli is missing.
      // We simulate this by checking the isLarkCliAvailable function.
      if (!larkAvailable) {
        // lark-cli is genuinely not available — verify createGroup fails
        const result = await createGroup(`Test CC-07 ${Date.now()}`);
        expect(result.success).toBe(false);
        expect(result.error).not.toBeNull();
      }
      // If lark-cli IS available, this scenario can't be tested without mocking.
      // The skip mechanism itself (describeIfChat) covers the CI skip case.
    });

    it('CC-08: should create different groups for same topic (idempotent, not deduped)', async () => {
      if (!larkAvailable) return;

      const topic = `Same Topic ${Date.now()}`;
      const result1 = await createGroup(topic);
      const result2 = await createGroup(topic);

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      // Both should succeed with different chatIds
      expect(result1.chatId).not.toBeNull();
      expect(result2.chatId).not.toBeNull();
      expect(result1.chatId).not.toBe(result2.chatId);

      createdChatIds.push(result1.chatId!);
      createdChatIds.push(result2.chatId!);
    });
  });

  // ---- CD — Dissolve Group Tests ----

  describe('CD — Dissolve group', () => {
    it('CD-01: should dissolve a created group', async () => {
      if (!larkAvailable) return;

      // Create a group first
      const name = `Test CD-01 ${Date.now()}`;
      const createResult = await createGroup(name);
      expect(createResult.success).toBe(true);
      expect(createResult.chatId).not.toBeNull();

      // Dissolve the group
      const dissolveResult = await dissolveGroup(createResult.chatId!);
      expect(dissolveResult.success).toBe(true);

      // Don't add to cleanup — already dissolved
    });

    it('CD-02: should dissolve group and clean up mapping entry', async () => {
      if (!larkAvailable) return;

      // Create group + mapping
      const timestamp = Date.now();
      const name = `Test CD-02 ${timestamp}`;
      const createResult = await createGroup(name);
      expect(createResult.success).toBe(true);
      expect(createResult.chatId).not.toBeNull();

      const key = makeMappingKey('discussion', timestamp);
      await mappingStore.set(key, {
        chatId: createResult.chatId!,
        purpose: 'discussion',
      });

      // Verify mapping exists
      const before = await mappingStore.get(key);
      expect(before).not.toBeNull();

      // Dissolve group
      const dissolveResult = await dissolveGroup(createResult.chatId!);
      expect(dissolveResult.success).toBe(true);

      // Clean up mapping
      const deleted = await mappingStore.delete(key);
      expect(deleted).toBe(true);

      // Verify mapping is gone
      const after = await mappingStore.get(key);
      expect(after).toBeNull();
    });

    it('CD-03: should return error when dissolving non-existent chatId', async () => {
      if (!larkAvailable) return;

      const fakeChatId = 'oc_nonexistent1234567890';
      const result = await dissolveGroup(fakeChatId);

      // Should fail with an error
      expect(result.success).toBe(false);
      expect(result.error).not.toBeNull();
    });

    it('CD-04: should not affect other mappings when dissolving one group', async () => {
      if (!larkAvailable) return;

      // Create two groups with mappings
      const ts1 = Date.now();
      const name1 = `Test CD-04a ${ts1}`;
      const create1 = await createGroup(name1);
      expect(create1.success).toBe(true);
      createdChatIds.push(create1.chatId!);

      const ts2 = ts1 + 1;
      const name2 = `Test CD-04b ${ts2}`;
      const create2 = await createGroup(name2);
      expect(create2.success).toBe(true);

      const key1 = makeMappingKey('discussion', ts1);
      const key2 = makeMappingKey('discussion', ts2);

      await mappingStore.set(key1, { chatId: create1.chatId!, purpose: 'discussion' });
      await mappingStore.set(key2, { chatId: create2.chatId!, purpose: 'discussion' });

      // Dissolve only the second group
      const dissolveResult = await dissolveGroup(create2.chatId!);
      expect(dissolveResult.success).toBe(true);

      await mappingStore.delete(key2);

      // Verify first group's mapping still exists
      const entry1 = await mappingStore.get(key1);
      expect(entry1).not.toBeNull();
      expect(entry1!.chatId).toBe(create1.chatId);

      // Verify second group's mapping is gone
      const entry2 = await mappingStore.get(key2);
      expect(entry2).toBeNull();
    });

    it('CD-05: should return error when dissolving already-dissolved group', async () => {
      if (!larkAvailable) return;

      // Create and dissolve a group
      const name = `Test CD-05 ${Date.now()}`;
      const createResult = await createGroup(name);
      expect(createResult.success).toBe(true);

      const dissolve1 = await dissolveGroup(createResult.chatId!);
      expect(dissolve1.success).toBe(true);

      // Try dissolving again
      const dissolve2 = await dissolveGroup(createResult.chatId!);
      expect(dissolve2.success).toBe(false);
      expect(dissolve2.error).not.toBeNull();
    });
  });

  // ---- CL — List Groups (via BotChatMappingStore) ----

  describe('CL — List groups', () => {
    it('CL-01: should return empty list when no mappings exist', async () => {
      const emptyStore = createTestMappingStore(createTempDir());
      const list = await emptyStore.list();
      expect(list).toEqual([]);
    });

    it('CL-02: should list multiple discussion groups', async () => {
      if (!larkAvailable) return;

      // Create two groups with mappings
      const ts1 = Date.now();
      const ts2 = ts1 + 1;

      const create1 = await createGroup(`Test CL-02a ${ts1}`);
      const create2 = await createGroup(`Test CL-02b ${ts2}`);

      expect(create1.success).toBe(true);
      expect(create2.success).toBe(true);
      createdChatIds.push(create1.chatId!);
      createdChatIds.push(create2.chatId!);

      const key1 = makeMappingKey('discussion', ts1);
      const key2 = makeMappingKey('discussion', ts2);

      await mappingStore.set(key1, { chatId: create1.chatId!, purpose: 'discussion' });
      await mappingStore.set(key2, { chatId: create2.chatId!, purpose: 'discussion' });

      // List all discussion-purpose groups
      const discussions = await mappingStore.listByPurpose('discussion');

      // Should contain at least the two we just created
      const discussionKeys = discussions.map(([key]) => key);
      expect(discussionKeys).toContain(key1);
      expect(discussionKeys).toContain(key2);
    });
  });

  // ---- CQ — Query Group (via BotChatMappingStore) ----

  describe('CQ — Query group', () => {
    it('CQ-01: should query existing mapping by key', async () => {
      if (!larkAvailable) return;

      const ts = Date.now();
      const name = `Test CQ-01 ${ts}`;
      const createResult = await createGroup(name);
      expect(createResult.success).toBe(true);
      createdChatIds.push(createResult.chatId!);

      const key = makeMappingKey('discussion', ts);
      await mappingStore.set(key, { chatId: createResult.chatId!, purpose: 'discussion' });

      // Query
      const entry = await mappingStore.get(key);
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe(createResult.chatId);
      expect(entry!.purpose).toBe('discussion');
    });

    it('CQ-02: should return null for non-existent key', async () => {
      const entry = await mappingStore.get('discussion-nonexistent-999');
      expect(entry).toBeNull();
    });
  });
});
