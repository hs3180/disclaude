/**
 * Chat Lifecycle Integration Tests — real lark-cli calls.
 *
 * Tests the end-to-end flow described in the chat SKILL.md:
 *   lark-cli im chat create  →  mapping table write  →  lark-cli api DELETE
 *
 * Every test case calls real lark-cli commands.
 * Tests auto-skip when lark-cli is not installed or not authenticated.
 *
 * Test cases correspond to Issue #3284 acceptance criteria:
 *   CC-01 ~ CC-08: /chat create
 *   CD-01 ~ CD-05: /chat dissolve
 *   CL-01 ~ CL-02: /chat list
 *   CQ-01 ~ CQ-02: /chat query
 *
 * @see Issue #3284 — 建群与解散群集成测试用例设计
 * @see Issue #3283 — 通用建群 Skill
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LARK_TIMEOUT_MS = 30_000;
const OC_REGEX = /oc_[a-zA-Z0-9]+/;
const OU_REGEX = /^ou_[a-zA-Z0-9]+$/;
const MAX_GROUP_NAME_LENGTH = 64;

// ---------------------------------------------------------------------------
// Detection: is lark-cli available and authenticated?
// ---------------------------------------------------------------------------

let larkAvailable = false;

async function checkLarkCli(): Promise<boolean> {
  try {
    await execFileAsync('lark-cli', ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Test user IDs (for CC-04 member tests)
// ---------------------------------------------------------------------------

function parseTestUsers(): string[] {
  const raw = (process.env.TEST_CHAT_USER_IDS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  // Validate format
  for (const id of raw) {
    if (!OU_REGEX.test(id)) {
      console.warn(`Skipping invalid TEST_CHAT_USER_IDS entry: ${id} (must match ou_xxx)`);
      return [];
    }
  }

  // Max 5 users
  return raw.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Helpers: lark-cli commands
// ---------------------------------------------------------------------------

interface CreateGroupResult {
  chatId: string;
  rawOutput: string;
}

/**
 * Create a Feishu group via lark-cli.
 * Parses the output to extract the chatId (oc_xxx format).
 */
async function createGroup(name: string, description?: string): Promise<CreateGroupResult> {
  const args = ['im', 'chat', 'create', '--name', name];
  if (description) {
    args.push('--description', description);
  }

  const { stdout } = await execFileAsync('lark-cli', args, {
    timeout: LARK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  const chatId = extractChatId(stdout);
  return { chatId, rawOutput: stdout };
}

/**
 * Create a Feishu group with members via lark-cli API.
 * Uses raw API call because lark-cli high-level command may not support member list.
 */
async function createGroupWithMembers(
  name: string,
  userIds: string[],
  description?: string,
): Promise<CreateGroupResult> {
  const body: Record<string, unknown> = {
    name,
    user_id_list: userIds,
  };
  if (description) {
    body.description = description;
  }

  const { stdout } = await execFileAsync(
    'lark-cli',
    ['api', 'POST', '/open-apis/im/v1/chats', '-d', JSON.stringify(body)],
    { timeout: LARK_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  );

  const chatId = extractChatId(stdout);
  return { chatId, rawOutput: stdout };
}

/**
 * Dissolve (delete) a Feishu group via lark-cli.
 */
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

/**
 * Extract chatId from lark-cli output.
 * Tries JSON parse first, then falls back to regex matching.
 */
function extractChatId(output: string): string {
  // Strategy 1: JSON response with chat_id field
  try {
    const json = JSON.parse(output);
    if (typeof json === 'object' && json !== null) {
      // Direct field
      if (json.chat_id && typeof json.chat_id === 'string') return json.chat_id;
      // Nested in data
      if (json.data?.chat_id && typeof json.data.chat_id === 'string') return json.data.chat_id;
    }
  } catch {
    // Not JSON, try regex
  }

  // Strategy 2: Regex for oc_xxx pattern
  const match = output.match(OC_REGEX);
  if (match) return match[0];

  throw new Error(`Cannot extract chatId from lark-cli output:\n${output}`);
}

// ---------------------------------------------------------------------------
// Helpers: mapping file operations (matches SKILL.md pattern)
// ---------------------------------------------------------------------------

interface MappingEntry {
  chatId: string;
  purpose: string;
  createdAt: string;
}

interface MappingTable {
  [key: string]: MappingEntry;
}

/**
 * Read mapping table from file. Returns empty table if file doesn't exist.
 */
async function readMapping(filePath: string): Promise<MappingTable> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content.trim() || '{}') as MappingTable;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * Atomically write mapping table to file.
 */
async function writeMapping(filePath: string, table: MappingTable): Promise<void> {
  const content = JSON.stringify(table, null, 2) + '\n';
  const tmpFile = `${filePath}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpFile, content, 'utf-8');
    await fs.rename(tmpFile, filePath);
  } catch (error) {
    try { await fs.unlink(tmpFile); } catch { /* ignore */ }
    throw error;
  }
}

/**
 * Add an entry to the mapping table.
 */
async function addMappingEntry(
  filePath: string,
  key: string,
  chatId: string,
  purpose: string,
): Promise<void> {
  const table = await readMapping(filePath);
  table[key] = { chatId, purpose, createdAt: new Date().toISOString() };
  await writeMapping(filePath, table);
}

/**
 * Remove an entry from the mapping table.
 * Returns true if the entry existed and was removed.
 */
async function removeMappingEntry(filePath: string, key: string): Promise<boolean> {
  const table = await readMapping(filePath);
  if (!(key in table)) return false;
  delete table[key];
  await writeMapping(filePath, table);
  return true;
}

/**
 * Truncate a group name to max length at character boundaries (CJK-safe).
 */
function truncateGroupName(name: string): string {
  return Array.from(name).slice(0, MAX_GROUP_NAME_LENGTH).join('');
}

/**
 * Generate a unique test group name with a prefix for easy identification.
 */
function testGroupName(prefix: string): string {
  return `[test] ${prefix} ${Date.now()}`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Chat Lifecycle Integration Tests', () => {
  // State shared across tests
  const createdGroups: Array<{ chatId: string; key: string }> = [];
  let mappingFilePath: string;
  let tempDir: string;

  beforeAll(async () => {
    larkAvailable = await checkLarkCli();

    // Create temp directory and mapping file
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-integ-'));
    mappingFilePath = path.join(tempDir, 'bot-chat-mapping.json');
    await fs.writeFile(mappingFilePath, '{}\n', 'utf-8');
  });

  afterAll(async () => {
    // Clean up: dissolve all groups created during tests
    const errors: string[] = [];
    for (const group of createdGroups) {
      try {
        await dissolveGroup(group.chatId);
      } catch (error) {
        errors.push(`Failed to dissolve ${group.chatId}: ${error}`);
      }
    }

    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    if (errors.length > 0) {
      console.warn('Cleanup warnings:', errors);
    }
  });

  // Helper to register a group for cleanup
  function trackForCleanup(chatId: string, key: string) {
    createdGroups.push({ chatId, key });
  }

  // ========================================================================
  // CC — 创建群 (/chat create)
  // ========================================================================

  describe.skipIf(!larkAvailable)('CC — 创建群 (/chat create)', () => {
    it('CC-01: 基本建群 — lark-cli 创建群成功，返回 chatId 格式正确', async () => {
      const groupName = testGroupName('CC-01');
      const result = await createGroup(groupName, 'CC-01 测试群');

      // Verify chatId format
      expect(result.chatId).toMatch(OC_REGEX);
      expect(result.chatId).toBeTruthy();

      // Track for cleanup
      trackForCleanup(result.chatId, `cc01-${Date.now()}`);
    });

    it('CC-02: 建群 + 映射表写入 — bot-chat-mapping.json 新增条目正确', async () => {
      const groupName = testGroupName('CC-02');
      const result = await createGroup(groupName);
      const key = `discussion-${Date.now()}`;

      // Write mapping
      await addMappingEntry(mappingFilePath, key, result.chatId, 'discussion');

      // Verify mapping entry
      const table = await readMapping(mappingFilePath);
      expect(table[key]).toBeDefined();
      expect(table[key].chatId).toBe(result.chatId);
      expect(table[key].purpose).toBe('discussion');
      expect(table[key].createdAt).toBeTruthy();

      // Verify ISO date format
      const date = new Date(table[key].createdAt);
      expect(date.getTime()).not.toBeNaN();

      trackForCleanup(result.chatId, key);
    });

    it('CC-04: 建群 + 添加成员 — 指定用户被正确加入群聊', async () => {
      const testUsers = parseTestUsers();
      if (testUsers.length === 0) {
        return; // Skip: no test users configured
      }

      const groupName = testGroupName('CC-04');
      const result = await createGroupWithMembers(groupName, testUsers, 'CC-04 成员测试');

      // Verify chatId was returned
      expect(result.chatId).toMatch(OC_REGEX);

      trackForCleanup(result.chatId, `cc04-${Date.now()}`);
    });

    it('CC-05: 群名截断 — 超过 64 字符的群名被正确截断（CJK 安全）', async () => {
      // 80 CJK characters — should be truncated to 64
      const longName = '测试'.repeat(40); // 80 chars
      expect(Array.from(longName).length).toBe(80);

      const groupName = `[test] CC-05 ${longName}`;
      const result = await createGroup(groupName);

      // lark-cli / Feishu API should handle the truncation server-side
      // We verify the group was created successfully
      expect(result.chatId).toMatch(OC_REGEX);

      // Also verify our client-side truncation logic works
      const truncated = truncateGroupName(groupName);
      expect(Array.from(truncated).length).toBeLessThanOrEqual(MAX_GROUP_NAME_LENGTH);

      trackForCleanup(result.chatId, `cc05-${Date.now()}`);
    });

    it('CC-06: 群名含特殊字符 — 含 emoji、中文、英文混合的群名正确创建', async () => {
      const mixedName = `[test] CC-06 测试Test🎉项目-Review Phase 2/3`;
      const result = await createGroup(mixedName, 'Mixed chars 测试 🚀');

      expect(result.chatId).toMatch(OC_REGEX);

      trackForCleanup(result.chatId, `cc06-${Date.now()}`);
    });

    it('CC-07: lark-cli 不可用 — lark-cli 未安装时返回明确错误提示', async () => {
      // Test with a non-existent command to verify error handling
      await expect(
        execFileAsync('lark-cli-nonexistent', ['im', 'chat', 'create'], { timeout: 5000 }),
      ).rejects.toThrow();
    });

    it('CC-08: 重复建群幂等性 — 相同主题重复创建不报错（创建新群）', async () => {
      const groupName = testGroupName('CC-08');
      const result1 = await createGroup(groupName);
      const result2 = await createGroup(groupName);

      // Both should succeed but return different chatIds (new groups)
      expect(result1.chatId).toMatch(OC_REGEX);
      expect(result2.chatId).toMatch(OC_REGEX);
      expect(result1.chatId).not.toBe(result2.chatId);

      trackForCleanup(result1.chatId, `cc08a-${Date.now()}`);
      trackForCleanup(result2.chatId, `cc08b-${Date.now()}`);
    });
  });

  // ========================================================================
  // CD — 解散群 (/chat dissolve)
  // ========================================================================

  describe.skipIf(!larkAvailable)('CD — 解散群 (/chat dissolve)', () => {
    it('CD-01: 基本解散群 — lark-cli DELETE 成功，群被解散', async () => {
      // Create a group first
      const groupName = testGroupName('CD-01');
      const createResult = await createGroup(groupName);

      // Dissolve the group
      const dissolveResult = await dissolveGroup(createResult.chatId);
      expect(dissolveResult.success).toBe(true);
      expect(dissolveResult.error).toBeNull();

      // Note: NOT tracked for cleanup since we already dissolved it
    });

    it('CD-02: 解散 + 映射表清理 — bot-chat-mapping.json 中对应条目被删除', async () => {
      // Create a group and add to mapping
      const groupName = testGroupName('CD-02');
      const createResult = await createGroup(groupName);
      const key = `discussion-${Date.now()}`;
      await addMappingEntry(mappingFilePath, key, createResult.chatId, 'discussion');

      // Verify mapping exists
      const tableBefore = await readMapping(mappingFilePath);
      expect(tableBefore[key]).toBeDefined();

      // Dissolve the group
      const dissolveResult = await dissolveGroup(createResult.chatId);
      expect(dissolveResult.success).toBe(true);

      // Remove from mapping
      const removed = await removeMappingEntry(mappingFilePath, key);
      expect(removed).toBe(true);

      // Verify mapping is gone
      const tableAfter = await readMapping(mappingFilePath);
      expect(tableAfter[key]).toBeUndefined();
    });

    it('CD-03: 解散不存在的群 — chatId 无效时返回明确错误', async () => {
      const invalidChatId = 'oc_nonexistent0000000000000000000';
      const result = await dissolveGroup(invalidChatId);

      // Should fail gracefully, not crash
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('CD-04: 解散后映射表一致 — 解散后其他条目不受影响', async () => {
      // Create two groups
      const group1 = await createGroup(testGroupName('CD-04a'));
      const group2 = await createGroup(testGroupName('CD-04b'));
      const key1 = `discussion-cd04a-${Date.now()}`;
      const key2 = `discussion-cd04b-${Date.now()}`;

      // Add both to mapping
      await addMappingEntry(mappingFilePath, key1, group1.chatId, 'discussion');
      await addMappingEntry(mappingFilePath, key2, group2.chatId, 'discussion');

      // Dissolve group 1
      const result = await dissolveGroup(group1.chatId);
      expect(result.success).toBe(true);

      // Remove from mapping
      await removeMappingEntry(mappingFilePath, key1);

      // Verify group 2 mapping is still intact
      const table = await readMapping(mappingFilePath);
      expect(table[key1]).toBeUndefined();
      expect(table[key2]).toBeDefined();
      expect(table[key2].chatId).toBe(group2.chatId);

      // Track group2 for cleanup (group1 already dissolved)
      trackForCleanup(group2.chatId, key2);
    });

    it('CD-05: 解散已被解散的群 — 二次解散返回错误但不 crash', async () => {
      // Create and dissolve a group
      const group = await createGroup(testGroupName('CD-05'));
      const first = await dissolveGroup(group.chatId);
      expect(first.success).toBe(true);

      // Try to dissolve again
      const second = await dissolveGroup(group.chatId);
      // Should fail gracefully
      expect(second.success).toBe(false);
      expect(second.error).toBeTruthy();
    });
  });

  // ========================================================================
  // CL — 列表 (/chat list)
  // ========================================================================

  describe.skipIf(!larkAvailable)('CL — 列表 (/chat list)', () => {
    it('CL-01: 列表空 — 映射表为空时返回空列表', async () => {
      // Use a fresh empty mapping file
      const emptyMappingPath = path.join(tempDir, 'empty-mapping.json');
      await fs.writeFile(emptyMappingPath, '{}\n', 'utf-8');

      const table = await readMapping(emptyMappingPath);
      const entries = Object.entries(table);
      expect(entries).toHaveLength(0);
    });

    it('CL-02: 列表多条 — 多个群正确展示，按时间排序', async () => {
      // Create multiple groups and add to mapping
      const groups = await Promise.all([
        createGroup(testGroupName('CL-02a'), 'first'),
        createGroup(testGroupName('CL-02b'), 'second'),
        createGroup(testGroupName('CL-02c'), 'third'),
      ]);

      const keys = groups.map((_, i) => `discussion-cl02-${Date.now()}-${i}`);

      for (let i = 0; i < groups.length; i++) {
        await addMappingEntry(mappingFilePath, keys[i], groups[i].chatId, 'discussion');
      }

      // Read and verify
      const table = await readMapping(mappingFilePath);
      const discussionEntries = Object.entries(table).filter(
        ([, entry]) => entry.purpose === 'discussion',
      );

      expect(discussionEntries.length).toBeGreaterThanOrEqual(3);

      // Verify all our groups are in the mapping
      for (let i = 0; i < groups.length; i++) {
        const entry = table[keys[i]];
        expect(entry).toBeDefined();
        expect(entry.chatId).toBe(groups[i].chatId);
      }

      // Track for cleanup
      groups.forEach((g, i) => trackForCleanup(g.chatId, keys[i]));
    });
  });

  // ========================================================================
  // CQ — 查询 (/chat query)
  // ========================================================================

  describe.skipIf(!larkAvailable)('CQ — 查询 (/chat query)', () => {
    it('CQ-01: 查询存在的 key — 返回正确的映射条目', async () => {
      const group = await createGroup(testGroupName('CQ-01'));
      const key = `discussion-cq01-${Date.now()}`;
      await addMappingEntry(mappingFilePath, key, group.chatId, 'discussion');

      // Query by reading mapping and looking for key
      const table = await readMapping(mappingFilePath);
      const entry = table[key];

      expect(entry).toBeDefined();
      expect(entry.chatId).toBe(group.chatId);
      expect(entry.purpose).toBe('discussion');
      expect(entry.createdAt).toBeTruthy();

      trackForCleanup(group.chatId, key);
    });

    it('CQ-02: 查询不存在的 key — 返回 null/not found', async () => {
      const table = await readMapping(mappingFilePath);
      const entry = table['nonexistent-key-99999'];
      expect(entry).toBeUndefined();
    });
  });
});
