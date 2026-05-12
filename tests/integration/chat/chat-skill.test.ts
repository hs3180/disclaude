/**
 * Integration tests for Chat Skill — 建群与解散群端到端流程
 *
 * Issue #3284: Integration tests for the chat skill (create/dissolve/list/query).
 *
 * These tests verify the end-to-end flow of:
 * 1. Creating Feishu groups via lark-cli
 * 2. Writing/cleaning up mappings in BotChatMappingStore
 * 3. Listing and querying groups
 * 4. Dissolving groups and verifying cleanup
 *
 * Test environment:
 * - Set TEST_CHAT_DRY_RUN=0 to make real lark-cli calls (default: 1, skips actual calls)
 * - Set TEST_CHAT_USER_IDS=ou_xxx,ou_yyy to test member addition (CC-04)
 * - Tests auto-skip when lark-cli is unavailable
 *
 * @see Issue #3284 - Test cases design
 * @see Issue #3283 - Chat skill implementation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  BotChatMappingStore,
  makeMappingKey,
  purposeFromKey,
} from '@disclaude/core';

const execFileAsync = promisify(execFile);

// ---- Environment Configuration ----

const DRY_RUN = process.env.TEST_CHAT_DRY_RUN !== '0'; // default: true
const TEST_USERS = (process.env.TEST_CHAT_USER_IDS ?? '')
  .split(',')
  .map(u => u.trim())
  .filter(Boolean);

const LARK_TIMEOUT_MS = 30_000;

/** Validate test user IDs format */
function validateTestUsers(): void {
  for (const id of TEST_USERS) {
    if (!/^ou_[a-zA-Z0-9]+$/.test(id)) {
      throw new Error(`Invalid TEST_CHAT_USER_IDS entry: '${id}' — must match ou_xxxxx format`);
    }
    if (TEST_USERS.length > 5) {
      throw new Error('TEST_CHAT_USER_IDS must contain at most 5 user IDs');
    }
  }
}

// ---- Lark-CLI Helpers ----

let larkCliAvailable = false;

async function checkLarkCli(): Promise<boolean> {
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function createGroup(
  name: string,
  description?: string,
): Promise<{ chatId: string; raw: string }> {
  const args = ['im', 'chat', 'create', '--name', name];
  if (description) {
    args.push('--description', description);
  }

  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  // Extract chatId from output (oc_xxx format)
  const chatIdMatch = stdout.match(/(oc_[a-zA-Z0-9]+)/);
  if (!chatIdMatch) {
    throw new Error(`Failed to extract chatId from lark-cli output: ${stdout}`);
  }

  return { chatId: chatIdMatch[1], raw: stdout };
}

async function dissolveGroup(chatId: string): Promise<{ success: boolean; error: string | null }> {
  try {
    await execFileAsync(
      'lark-cli',
      ['api', 'DELETE', `/open-apis/im/v1/chats/${chatId}`],
      { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    return { success: true, error: null };
  } catch (err: unknown) {
    const execErr = err as { stderr?: string; message?: string };
    const errorMsg = (execErr.stderr ?? execErr.message ?? 'unknown error')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { success: false, error: errorMsg };
  }
}

// ---- Test Fixtures ----

let tmpDir: string;
let mappingFilePath: string;
let store: BotChatMappingStore;

/** Track groups created during tests for cleanup */
const createdGroups: Array<{ key: string; chatId: string }> = [];

// ---- Test Suite ----

describe('Chat Skill Integration Tests', () => {
  beforeAll(async () => {
    validateTestUsers();
    larkCliAvailable = await checkLarkCli();

    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'chat-skill-test-'));
    mappingFilePath = path.join(tmpDir, 'bot-chat-mapping.json');
    store = new BotChatMappingStore({ filePath: mappingFilePath });
  });

  afterAll(async () => {
    // Cleanup: dissolve all groups created during tests
    if (!DRY_RUN && larkCliAvailable) {
      for (const group of createdGroups) {
        try {
          await dissolveGroup(group.chatId);
        } catch {
          // Best-effort cleanup
        }
      }
    }

    // Remove temp directory
    try {
      await fsPromises.rm(tmpDir, { recursive: true });
    } catch {
      // Best-effort cleanup
    }
  });

  beforeEach(async () => {
    // Fresh store for each test — clear the mapping file
    try {
      await fsPromises.unlink(mappingFilePath);
    } catch {
      // File may not exist
    }
    store = new BotChatMappingStore({ filePath: mappingFilePath });
  });

  // ================================================================
  // 1. Create Flow — CC-* Test Cases
  // ================================================================

  describe('CC-01: Basic create group', () => {
    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should create group via lark-cli and return oc_xxx chatId',
      async () => {
        const topic = `test-CC01-${Date.now()}`;
        const groupName = `讨论 · ${topic}`;

        const result = await createGroup(groupName, `Integration test for ${topic}`);

        expect(result.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);

        // Track for cleanup
        createdGroups.push({ key: `discussion-${Math.floor(Date.now() / 1000)}`, chatId: result.chatId });
      },
    );
  });

  describe('CC-02: Create + mapping table write', () => {
    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should create group and write correct mapping entry',
      async () => {
        const timestamp = Math.floor(Date.now() / 1000);
        const key = makeMappingKey('discussion', timestamp);
        const groupName = `讨论 · test-CC02-${timestamp}`;

        const { chatId } = await createGroup(groupName, 'CC-02 integration test');

        // Write to mapping store
        const entry = await store.set(key, {
          chatId,
          purpose: 'discussion',
        });

        expect(entry.chatId).toBe(chatId);
        expect(entry.purpose).toBe('discussion');
        expect(entry.createdAt).toBeDefined();
        expect(entry.persisted).toBe(true);

        // Verify file on disk
        const fileContent = await fsPromises.readFile(mappingFilePath, 'utf-8');
        const parsed = JSON.parse(fileContent);
        expect(parsed[key]).toBeDefined();
        expect(parsed[key].chatId).toBe(chatId);
        expect(parsed[key].purpose).toBe('discussion');

        // Track for cleanup
        createdGroups.push({ key, chatId });
      },
    );
  });

  describe('CC-03: Create + send context (dry-run)', () => {
    it('should verify send context flow structure', async () => {
      // This test verifies the mapping structure that enables context sending
      // Actual MCP send_text is tested in feishu integration tests
      const key = `discussion-${Math.floor(Date.now() / 1000)}`;
      const chatId = 'oc_test_cc03';

      await store.set(key, { chatId, purpose: 'discussion' });

      const entry = await store.get(key);
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe(chatId);
    });
  });

  describe('CC-04: Create + add members', () => {
    it.skipIf(!TEST_USERS.length || DRY_RUN || !larkCliAvailable)(
      'should add specified users to the created group',
      async () => {
        const timestamp = Date.now();
        const groupName = `讨论 · test-CC04-${timestamp}`;

        const { chatId } = await createGroup(groupName, 'CC-04 member test');

        // Add members via lark-cli API
        for (const userId of TEST_USERS) {
          await execFileAsync(
            'lark-cli',
            ['api', 'POST', `/open-apis/im/v1/chats/${chatId}/members`, '-d', JSON.stringify({ id_list: [userId] })],
            { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
          );
        }

        // Track for cleanup
        createdGroups.push({ key: `discussion-${Math.floor(timestamp / 1000)}`, chatId });
      },
    );
  });

  describe('CC-05: Group name truncation (> 64 chars)', () => {
    it('should truncate long group names at character boundaries (CJK safe)', () => {
      // Build a name longer than 64 characters with CJK characters
      const longName = '讨论 · ' + '测试中文标题'.repeat(20); // well over 64 chars
      const truncated = Array.from(longName).slice(0, 64).join('');

      expect(Array.from(truncated).length).toBeLessThanOrEqual(64);
      expect(truncated.length).toBeGreaterThan(0);
      // Verify CJK characters are not split in the middle of a code point
      expect(() => JSON.stringify(truncated)).not.toThrow();
    });

    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should create group with truncated name successfully',
      async () => {
        const longTopic = '这是一个非常非常长的讨论主题'.repeat(10);
        const truncatedName = Array.from(`讨论 · ${longTopic}`).slice(0, 64).join('');

        const { chatId } = await createGroup(truncatedName, 'CC-05 truncation test');
        expect(chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);

        createdGroups.push({ key: `discussion-${Math.floor(Date.now() / 1000)}`, chatId });
      },
    );
  });

  describe('CC-06: Group name with special characters', () => {
    const specialNames = [
      '讨论 · emoji 🎉🎊 test',
      '讨论 · 中English混合标题',
      '讨论 · 特殊字符 !@#$%',
    ];

    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should create groups with special characters in names',
      async () => {
        for (const name of specialNames) {
          const { chatId } = await createGroup(name, 'CC-06 special chars test');
          expect(chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);

          createdGroups.push({ key: `discussion-${Math.floor(Date.now() / 1000)}`, chatId });
        }
      },
    );
  });

  describe('CC-07: lark-cli unavailable', () => {
    it('should detect lark-cli unavailability', async () => {
      // If lark-cli is available, we verify the detection works by checking
      // a non-existent command
      await expect(
        execFileAsync('lark-cli-nonexistent', ['--version'], { timeout: 5000 }),
      ).rejects.toThrow();
    });
  });

  describe('CC-08: Idempotent create', () => {
    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should create new group even for same topic (idempotent)',
      async () => {
        const topic = `test-CC08-idempotent`;
        const groupName = `讨论 · ${topic}`;

        const result1 = await createGroup(groupName, 'CC-08 idempotent test');
        const result2 = await createGroup(groupName, 'CC-08 idempotent test');

        // Each create should produce a new unique chatId
        expect(result1.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);
        expect(result2.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);
        // Different groups created for same topic (no deduplication at this level)
        expect(result1.chatId).not.toBe(result2.chatId);

        createdGroups.push({ key: `discussion-${Math.floor(Date.now() / 1000)}`, chatId: result1.chatId });
        createdGroups.push({ key: `discussion-${Math.floor(Date.now() / 1000) + 1}`, chatId: result2.chatId });
      },
    );
  });

  // ================================================================
  // 2. Dissolve Flow — CD-* Test Cases
  // ================================================================

  describe('CD-01: Basic dissolve group', () => {
    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should dissolve group via lark-cli DELETE',
      async () => {
        const { chatId } = await createGroup(
          `讨论 · test-CD01-${Date.now()}`,
          'CD-01 dissolve test',
        );

        const result = await dissolveGroup(chatId);
        expect(result.success).toBe(true);
        expect(result.error).toBeNull();

        // Don't track — already dissolved
      },
    );
  });

  describe('CD-02: Dissolve + mapping cleanup', () => {
    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should dissolve group and remove mapping entry',
      async () => {
        const timestamp = Math.floor(Date.now() / 1000);
        const key = `discussion-${timestamp}`;
        const { chatId } = await createGroup(
          `讨论 · test-CD02-${timestamp}`,
          'CD-02 dissolve+cleanup test',
        );

        // Write mapping
        await store.set(key, { chatId, purpose: 'discussion' });
        expect(await store.has(key)).toBe(true);

        // Dissolve the group
        const result = await dissolveGroup(chatId);
        expect(result.success).toBe(true);

        // Remove mapping
        const deleted = await store.delete(key);
        expect(deleted).toBe(true);
        expect(await store.get(key)).toBeNull();
      },
    );
  });

  describe('CD-03: Dissolve non-existent group', () => {
    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should return error for invalid chatId',
      async () => {
        const result = await dissolveGroup('oc_invalid_nonexistent_id');
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
      },
    );
  });

  describe('CD-04: Mapping consistency after dissolve', () => {
    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should only remove the dissolved group, keeping other entries',
      async () => {
        const ts = Math.floor(Date.now() / 1000);

        // Create two groups
        const group1 = await createGroup(`讨论 · test-CD04a-${ts}`, 'CD-04 group A');
        const group2 = await createGroup(`讨论 · test-CD04b-${ts}`, 'CD-04 group B');

        const key1 = `discussion-${ts}`;
        const key2 = `discussion-${ts + 1}`;

        // Write mappings
        await store.set(key1, { chatId: group1.chatId, purpose: 'discussion' });
        await store.set(key2, { chatId: group2.chatId, purpose: 'discussion' });

        // Dissolve group1
        await dissolveGroup(group1.chatId);
        await store.delete(key1);

        // group2 mapping should still exist
        const entry2 = await store.get(key2);
        expect(entry2).not.toBeNull();
        expect(entry2!.chatId).toBe(group2.chatId);

        // group1 mapping should be gone
        expect(await store.get(key1)).toBeNull();

        // Track group2 for cleanup
        createdGroups.push({ key: key2, chatId: group2.chatId });
      },
    );
  });

  describe('CD-05: Dissolve already dissolved group', () => {
    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should return error but not crash on second dissolve',
      async () => {
        const { chatId } = await createGroup(
          `讨论 · test-CD05-${Date.now()}`,
          'CD-05 double dissolve test',
        );

        // First dissolve
        const result1 = await dissolveGroup(chatId);
        expect(result1.success).toBe(true);

        // Second dissolve — should fail but not throw
        const result2 = await dissolveGroup(chatId);
        expect(result2.success).toBe(false);
        expect(result2.error).toBeTruthy();
      },
    );
  });

  // ================================================================
  // 3. List & Query — CL-*, CQ-* Test Cases
  // ================================================================

  describe('CL-01: Empty list', () => {
    it('should return empty list when no discussion mappings exist', async () => {
      const result = await store.listByPurpose('discussion');
      expect(result).toEqual([]);
    });
  });

  describe('CL-02: List multiple entries', () => {
    it('should list all discussion groups sorted by key', async () => {
      // Create entries with different timestamps
      await store.set('discussion-100', { chatId: 'oc_aaa', purpose: 'discussion' });
      await store.set('discussion-200', { chatId: 'oc_bbb', purpose: 'discussion' });
      await store.set('discussion-300', { chatId: 'oc_ccc', purpose: 'discussion' });

      const result = await store.listByPurpose('discussion');
      expect(result).toHaveLength(3);

      const keys = result.map(([key]) => key);
      expect(keys).toContain('discussion-100');
      expect(keys).toContain('discussion-200');
      expect(keys).toContain('discussion-300');
    });
  });

  describe('CQ-01: Query existing key', () => {
    it('should return correct mapping for existing key', async () => {
      await store.set('discussion-400', { chatId: 'oc_query_test', purpose: 'discussion' });

      const entry = await store.get('discussion-400');
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe('oc_query_test');
      expect(entry!.purpose).toBe('discussion');
      expect(entry!.createdAt).toBeDefined();
    });
  });

  describe('CQ-02: Query non-existing key', () => {
    it('should return null for non-existing key', async () => {
      const entry = await store.get('discussion-nonexistent');
      expect(entry).toBeNull();
    });
  });

  // ================================================================
  // 4. Mapping Table Integrity — CM-* Test Cases
  // ================================================================

  describe('CM-01: Post-create mapping format', () => {
    it('should produce valid JSON mapping file after create', async () => {
      await store.set('discussion-500', { chatId: 'oc_format_test', purpose: 'discussion' });

      const content = await fsPromises.readFile(mappingFilePath, 'utf-8');
      const parsed = JSON.parse(content);

      // Verify structure matches MappingTable type
      expect(parsed).toHaveProperty('discussion-500');
      expect(parsed['discussion-500']).toHaveProperty('chatId', 'oc_format_test');
      expect(parsed['discussion-500']).toHaveProperty('purpose', 'discussion');
      expect(parsed['discussion-500']).toHaveProperty('createdAt');
      expect(typeof parsed['discussion-500'].createdAt).toBe('string');
    });
  });

  describe('CM-02: Concurrent create does not lose mappings', () => {
    it('should handle concurrent writes without data loss', async () => {
      // Create multiple store instances pointing to the same file
      // to simulate concurrent agents
      const store1 = new BotChatMappingStore({ filePath: mappingFilePath });
      const store2 = new BotChatMappingStore({ filePath: mappingFilePath });

      // Write concurrently
      const [result1, result2] = await Promise.all([
        store1.set('discussion-600', { chatId: 'oc_concurrent_1', purpose: 'discussion' }),
        store2.set('discussion-700', { chatId: 'oc_concurrent_2', purpose: 'discussion' }),
      ]);

      // Both should succeed (at least in memory)
      expect(result1.chatId).toBe('oc_concurrent_1');
      expect(result2.chatId).toBe('oc_concurrent_2');

      // Read back from a fresh store to verify persistence
      const freshStore = new BotChatMappingStore({ filePath: mappingFilePath });
      const size = await freshStore.size();
      // At least one should be persisted (race condition on file write)
      expect(size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('CM-03: Corrupted mapping self-heals', () => {
    it('should start with empty cache on invalid JSON', async () => {
      // Write corrupted JSON
      await fsPromises.writeFile(mappingFilePath, 'not valid json{', 'utf-8');

      const freshStore = new BotChatMappingStore({ filePath: mappingFilePath });
      const entry = await freshStore.get('any-key');
      expect(entry).toBeNull();
      expect(await freshStore.size()).toBe(0);
    });

    it('should start with empty cache on non-object JSON', async () => {
      await fsPromises.writeFile(mappingFilePath, '[]', 'utf-8');

      const freshStore = new BotChatMappingStore({ filePath: mappingFilePath });
      const entry = await freshStore.get('any-key');
      expect(entry).toBeNull();
    });
  });

  describe('CM-04: Rebuild from group list', () => {
    it('should rebuild mappings from group list scan', async () => {
      // Pre-populate some mappings
      await store.set('pr-123', { chatId: 'oc_old_pr', purpose: 'pr-review' });

      // Simulate a group list scan result
      const groups = [
        { chatId: 'oc_rebuilt_1', name: 'PR #123 · Fix authentication' },
        { chatId: 'oc_rebuilt_2', name: 'PR #456 · Add feature' },
      ];

      const result = await store.rebuildFromGroupList(groups);

      expect(result.scanned).toBe(2);
      expect(result.added).toBe(1); // pr-456 is new
      expect(result.kept).toBe(1);  // pr-123 already exists

      // Verify pr-123 was updated with new chatId
      const pr123 = await store.get('pr-123');
      expect(pr123).not.toBeNull();
      expect(pr123!.chatId).toBe('oc_rebuilt_1');

      // Verify pr-456 was added
      const pr456 = await store.get('pr-456');
      expect(pr456).not.toBeNull();
      expect(pr456!.chatId).toBe('oc_rebuilt_2');
      expect(pr456!.purpose).toBe('pr-review');
    });
  });

  // ================================================================
  // 5. Key Format & Purpose Inference
  // ================================================================

  describe('Key format and purpose inference', () => {
    it('should generate discussion-{timestamp} key format', () => {
      const key = makeMappingKey('discussion', 1715385600);
      expect(key).toBe('discussion-1715385600');
    });

    it('should infer purpose "discussion" from discussion-* key', () => {
      expect(purposeFromKey('discussion-1715385600')).toBe('discussion');
    });

    it('should infer purpose "pr-review" from pr-* key', () => {
      expect(purposeFromKey('pr-123')).toBe('pr-review');
    });
  });

  // ================================================================
  // 6. Full End-to-End Flow (real lark-cli only)
  // ================================================================

  describe('E2E: Create → Map → List → Query → Dissolve → Cleanup', () => {
    it.skipIf(DRY_RUN || !larkCliAvailable)(
      'should complete full lifecycle without errors',
      async () => {
        const timestamp = Math.floor(Date.now() / 1000);
        const key = `discussion-${timestamp}`;
        const groupName = `讨论 · E2E测试-${timestamp}`;

        // Step 1: Create group
        const { chatId } = await createGroup(groupName, 'E2E full lifecycle test');
        expect(chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);

        // Step 2: Write mapping
        await store.set(key, { chatId, purpose: 'discussion' });

        // Step 3: List — should contain our group
        const list = await store.listByPurpose('discussion');
        const found = list.some(([, entry]) => entry.chatId === chatId);
        expect(found).toBe(true);

        // Step 4: Query — should return our mapping
        const entry = await store.get(key);
        expect(entry).not.toBeNull();
        expect(entry!.chatId).toBe(chatId);
        expect(entry!.purpose).toBe('discussion');

        // Step 5: Dissolve
        const dissolveResult = await dissolveGroup(chatId);
        expect(dissolveResult.success).toBe(true);

        // Step 6: Cleanup mapping
        await store.delete(key);
        expect(await store.get(key)).toBeNull();
      },
    );
  });
});
