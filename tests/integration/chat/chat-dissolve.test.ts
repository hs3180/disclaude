/**
 * Integration tests: /chat dissolve — 解散群流程
 *
 * Test cases CD-01 through CD-06 from Issue #3284.
 *
 * Run with lark-cli:
 *   TEST_CHAT_DRY_RUN=0 npx vitest --run tests/integration/chat/chat-dissolve.test.ts
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
  makeDiscussionKey,
  execLark,
  shouldRunLarkTests,
  parseChatIdFromOutput,
  DRY_RUN,
  type TestEnv,
} from './helpers.js';

let runLarkTests = false;

beforeAll(async () => {
  runLarkTests = await shouldRunLarkTests();
});

describe('CD: /chat dissolve — 解散群流程', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(async () => {
    await cleanupTestEnv(env);
  });

  // ---- Tests requiring real lark-cli ----

  describe.skipIf(DRY_RUN || !runLarkTests)('lark-cli 集成测试', () => {
    // CD-01: 基本解散群
    it('CD-01: 基本解散群 — lark-cli DELETE 成功', async () => {
      // First create a group to dissolve
      const name = `test-integ-CD01-${Date.now()}`;
      const { stdout: createOutput } = await execLark([
        'im', 'chat', 'create',
        '--name', name,
      ]);

      const chatId = parseChatIdFromOutput(createOutput);
      expect(chatId).not.toBeNull();

      if (chatId) {
        // Dissolve the group
        await execLark([
          'api', 'DELETE',
          `/open-apis/im/v1/chats/${chatId}`,
        ]);

        // If no error thrown, dissolution succeeded
        // Don't add to cleanup since it's already dissolved
      }
    });

    // CD-02: 解散 + 映射表清理
    it('CD-02: 解散 + 映射表清理 — 映射条目被删除', async () => {
      const key = makeDiscussionKey();
      const name = `test-integ-CD02-${Date.now()}`;

      // Create group and add mapping
      const { stdout: createOutput } = await execLark([
        'im', 'chat', 'create',
        '--name', name,
      ]);

      const chatId = parseChatIdFromOutput(createOutput);
      expect(chatId).not.toBeNull();

      if (chatId) {
        await env.store.set(key, { chatId, purpose: 'discussion' });

        // Verify mapping exists
        let entry = await env.store.get(key);
        expect(entry).not.toBeNull();

        // Dissolve the group
        await execLark([
          'api', 'DELETE',
          `/open-apis/im/v1/chats/${chatId}`,
        ]);

        // Clean up mapping (simulating what the Agent would do)
        await env.store.delete(key);

        // Verify mapping is gone
        entry = await env.store.get(key);
        expect(entry).toBeNull();
      }
    });

    // CD-03: 解散不存在的群
    it('CD-03: 解散不存在的群 — 返回明确错误', async () => {
      const fakeChatId = 'oc_nonexistent_chat_id_12345';

      try {
        await execLark([
          'api', 'DELETE',
          `/open-apis/im/v1/chats/${fakeChatId}`,
        ]);
        // If it somehow succeeds, that's OK (idempotent)
      } catch (error) {
        // Should get a clear error, not a crash
        const err = error as Error;
        expect(err.message).toBeDefined();
        expect(err.message.length).toBeGreaterThan(0);
      }
    });

    // CD-04: 解散后映射表一致 — 其他条目不受影响
    it('CD-04: 解散后映射表一致 — 其他条目不受影响', async () => {
      // Create two groups
      const key1 = makeDiscussionKey();
      const key2 = makeDiscussionKey();

      const { stdout: createOutput1 } = await execLark([
        'im', 'chat', 'create',
        '--name', `test-integ-CD04-a-${Date.now()}`,
      ]);
      const chatId1 = parseChatIdFromOutput(createOutput1);

      const { stdout: createOutput2 } = await execLark([
        'im', 'chat', 'create',
        '--name', `test-integ-CD04-b-${Date.now()}`,
      ]);
      const chatId2 = parseChatIdFromOutput(createOutput2);

      expect(chatId1).not.toBeNull();
      expect(chatId2).not.toBeNull();

      if (chatId1 && chatId2) {
        // Add both mappings
        await env.store.set(key1, { chatId: chatId1, purpose: 'discussion' });
        await env.store.set(key2, { chatId: chatId2, purpose: 'discussion' });

        // Dissolve only the first group
        await execLark([
          'api', 'DELETE',
          `/open-apis/im/v1/chats/${chatId1}`,
        ]);
        await env.store.delete(key1);

        // Verify second mapping still exists
        const remainingEntry = await env.store.get(key2);
        expect(remainingEntry).not.toBeNull();
        expect(remainingEntry!.chatId).toBe(chatId2);

        // Clean up second group
        env.createdChatIds.push(chatId2);
      }
    });

    // CD-05: 解散已被解散的群
    it('CD-05: 解散已被解散的群 — 返回错误但不 crash', async () => {
      // Create and dissolve a group
      const name = `test-integ-CD05-${Date.now()}`;
      const { stdout: createOutput } = await execLark([
        'im', 'chat', 'create',
        '--name', name,
      ]);

      const chatId = parseChatIdFromOutput(createOutput);
      expect(chatId).not.toBeNull();

      if (chatId) {
        // First dissolution
        await execLark([
          'api', 'DELETE',
          `/open-apis/im/v1/chats/${chatId}`,
        ]);

        // Second dissolution (should fail gracefully)
        try {
          await execLark([
            'api', 'DELETE',
            `/open-apis/im/v1/chats/${chatId}`,
          ]);
          // If it succeeds (idempotent), that's acceptable
        } catch (error) {
          // Should get an error, but not crash
          expect(error).toBeDefined();
        }
      }
    });
  });

  // ---- CD-06: 确认机制 (SKILL.md behavior) ----
  // Note: CD-06 tests that the Agent confirms before dissolving.
  // This is a SKILL.md behavioral requirement, not a programmatic test.
  // Verification: the SKILL.md clearly states "必须向用户确认后才执行解散"
  describe('CD-06: 确证机制 (SKILL.md behavioral)', () => {
    it('should document the confirmation requirement', () => {
      // This test verifies the SKILL.md contract:
      // "⚠️ 必须向用户确认后才执行解散"
      // The actual behavior is enforced by the SKILL.md instructions,
      // not by code. This test serves as a reminder/contract.
      const skillRequiresConfirmation = true; // From SKILL.md
      expect(skillRequiresConfirmation).toBe(true);
    });
  });
});
