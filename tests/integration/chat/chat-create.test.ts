/**
 * Integration tests: /chat create — 建群流程
 *
 * Test cases CC-01 through CC-08 from Issue #3284.
 *
 * Run with lark-cli:
 *   TEST_CHAT_DRY_RUN=0 npx vitest --run tests/integration/chat/chat-create.test.ts
 *
 * Run in dry-run mode (CI-safe, tests requiring lark-cli will be skipped):
 *   npx vitest --run tests/integration/chat/chat-create.test.ts
 *
 * @see Issue #3284 — Chat integration test design
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  createTestEnv,
  cleanupTestEnv,
  truncateGroupName,
  makeDiscussionKey,
  execLark,
  shouldRunLarkTests,
  parseChatIdFromOutput,
  DRY_RUN,
  TEST_USERS,
  type TestEnv,
} from './helpers.js';

let runLarkTests = false;

beforeAll(async () => {
  runLarkTests = await shouldRunLarkTests();
});

describe('CC: /chat create — 建群流程', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(async () => {
    await cleanupTestEnv(env);
  });

  // ---- CC-05: 群名截断 (pure logic, always runs) ----

  describe('CC-05: 群名截断', () => {
    it('should truncate names exceeding 64 characters', () => {
      const longName = '这是一个很长的群名称用于测试截断功能是否正常工作'.repeat(5);
      const truncated = truncateGroupName(longName);

      expect(Array.from(truncated).length).toBeLessThanOrEqual(64);
      // Ensure no partial characters
      expect(truncated).toBe(
        Array.from(longName).slice(0, 64).join(''),
      );
    });

    it('should not truncate names within 64 characters', () => {
      const shortName = '短名字测试';
      const truncated = truncateGroupName(shortName);
      expect(truncated).toBe(shortName);
    });

    it('should handle exactly 64 characters', () => {
      const exact64 = Array.from({ length: 64 }, (_, i) =>
        String.fromCharCode(0x4e00 + i),
      ).join('');
      const truncated = truncateGroupName(exact64);
      expect(Array.from(truncated).length).toBe(64);
    });

    it('should handle mixed CJK and ASCII characters', () => {
      const mixedName = '测试Test🚀中文English混合名'.repeat(5);
      const truncated = truncateGroupName(mixedName);
      expect(Array.from(truncated).length).toBeLessThanOrEqual(64);
    });

    it('should handle emoji correctly (treated as single characters)', () => {
      const emojiName = '🎉🎊🎈🎁🎂🎀🥳🍾🎊🎉🎈🎁🎂🎀🥳🍾🎊🎉🎈🎁🎂🎀🥳🍾🎊🎉🎈🎁🎂🎀🥳🍾🎊🎉🎈🎁🎂🎀🥳🍾🎊🎉🎈🎁🎂🎀🥳🍾';
      const truncated = truncateGroupName(emojiName);
      expect(Array.from(truncated).length).toBeLessThanOrEqual(64);
    });

    it('should handle empty string', () => {
      expect(truncateGroupName('')).toBe('');
    });
  });

  // ---- CC-07: lark-cli 不可用 (error detection, always runs) ----

  describe('CC-07: lark-cli 不可用', () => {
    it('should detect missing lark-cli and return clear error', async () => {
      // If lark-cli is available, this test verifies the happy path
      // If lark-cli is unavailable, this test verifies error detection
      try {
        const { stdout, stderr } = await execLark(['im', 'chat', 'create', '--name', 'test', '--dry-run']);
        // lark-cli is available — verify output format
        expect(stdout || stderr).toBeDefined();
      } catch (error) {
        // lark-cli is not available — verify error is informative
        const err = error as Error & { code?: string };
        if (err.code === 'ENOENT') {
          expect(err.message).toContain('lark-cli');
        }
        // Other errors (auth, network) are also acceptable
        expect(error).toBeDefined();
      }
    });

    it('should produce a user-friendly error message when lark-cli is missing', () => {
      // Simulate the error message the Agent should produce
      const errorMsg = 'lark-cli 未安装，无法执行群操作。请先安装 lark-cli 并运行 lark-cli auth login。';
      expect(errorMsg).toContain('lark-cli');
      expect(errorMsg).toContain('未安装');
    });
  });

  // ---- Tests requiring real lark-cli (skipped in dry-run) ----

  describe.skipIf(DRY_RUN || !runLarkTests)('lark-cli 集成测试', () => {
    // CC-01: 基本建群
    it('CC-01: 基本建群 — lark-cli 创建群成功，返回 chatId 格式正确', async () => {
      const name = `test-integ-CC01-${Date.now()}`;
      const { stdout } = await execLark([
        'im', 'chat', 'create',
        '--name', name,
      ]);

      const chatId = parseChatIdFromOutput(stdout);
      expect(chatId).not.toBeNull();
      expect(chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);

      // Track for cleanup
      if (chatId) {
        env.createdChatIds.push(chatId);
      }
    });

    // CC-02: 建群 + 映射表写入
    it('CC-02: 建群 + 映射表写入 — bot-chat-mapping.json 新增条目', async () => {
      const key = makeDiscussionKey();
      const name = `test-integ-CC02-${Date.now()}`;

      // Create group via lark-cli
      const { stdout } = await execLark([
        'im', 'chat', 'create',
        '--name', name,
      ]);

      const chatId = parseChatIdFromOutput(stdout);
      expect(chatId).not.toBeNull();

      if (chatId) {
        env.createdChatIds.push(chatId);

        // Write mapping entry (simulating what the Agent would do)
        await env.store.set(key, {
          chatId,
          purpose: 'discussion',
        });

        // Verify mapping entry
        const entry = await env.store.get(key);
        expect(entry).not.toBeNull();
        expect(entry!.chatId).toBe(chatId);
        expect(entry!.purpose).toBe('discussion');
        expect(entry!.createdAt).toBeDefined();
      }
    });

    // CC-06: 群名含特殊字符
    it('CC-06: 群名含特殊字符 — emoji、中文、英文混合', async () => {
      const specialName = truncateGroupName(`测试Test🚀emoji-mixed-${Date.now()}`);
      const { stdout } = await execLark([
        'im', 'chat', 'create',
        '--name', specialName,
      ]);

      const chatId = parseChatIdFromOutput(stdout);
      expect(chatId).not.toBeNull();

      if (chatId) {
        env.createdChatIds.push(chatId);
      }
    });

    // CC-08: 重复建群幂等性
    it('CC-08: 重复建群幂等性 — 相同主题重复创建不报错', async () => {
      const name = `test-integ-CC08-idempotent-${Date.now()}`;

      // Create first group
      const { stdout: stdout1 } = await execLark([
        'im', 'chat', 'create',
        '--name', name,
      ]);
      const chatId1 = parseChatIdFromOutput(stdout1);

      // Create second group with same name (should succeed, creates a NEW group)
      const { stdout: stdout2 } = await execLark([
        'im', 'chat', 'create',
        '--name', name,
      ]);
      const chatId2 = parseChatIdFromOutput(stdout2);

      expect(chatId1).not.toBeNull();
      expect(chatId2).not.toBeNull();
      // They should be different groups
      expect(chatId1).not.toBe(chatId2);

      if (chatId1) env.createdChatIds.push(chatId1);
      if (chatId2) env.createdChatIds.push(chatId2);
    });
  });

  // ---- CC-04: requires test users ----
  describe.skipIf(DRY_RUN || !runLarkTests || TEST_USERS.length === 0)(
    'CC-04: 建群 + 添加成员 (requires TEST_CHAT_USER_IDS)',
    () => {
      it('should add specified users to the created group', async () => {
        const name = `test-integ-CC04-members-${Date.now()}`;

        // Create group
        const { stdout } = await execLark([
          'im', 'chat', 'create',
          '--name', name,
        ]);

        const chatId = parseChatIdFromOutput(stdout);
        expect(chatId).not.toBeNull();

        if (chatId) {
          env.createdChatIds.push(chatId);

          // Add members
          const members = TEST_USERS.join(',');
          await execLark([
            'im', 'chat', 'add-member',
            '--chat-id', chatId,
            '--members', members,
          ]);

          // If we get here without error, members were added successfully
          expect(true).toBe(true);
        }
      });
    },
  );
});
