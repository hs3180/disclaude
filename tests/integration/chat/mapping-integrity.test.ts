/**
 * Integration tests: Mapping table integrity
 *
 * Test cases CM-01 through CM-04 from Issue #3284.
 *
 * Note: CM-03 (映射表损坏自愈) and CM-04 (从群列表重建映射) are already
 * comprehensively tested in the BotChatMappingStore unit tests
 * (packages/core/src/scheduling/bot-chat-mapping.test.ts).
 * Those tests are not duplicated here.
 *
 * @see Issue #3284 — Chat integration test design
 * @see packages/core/src/scheduling/bot-chat-mapping.test.ts — unit tests for CM-03, CM-04
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
} from 'vitest';
import {
  createTestEnv,
  cleanupTestEnv,
  readMappingFile,
  shouldRunLarkTests,
  parseChatIdFromOutput,
  makeDiscussionKey,
  execLark,
  DRY_RUN,
  type TestEnv,
} from './helpers.js';

describe('CM: Mapping table integrity', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(async () => {
    await cleanupTestEnv(env);
  });

  // ---- CM-01: 建群后映射表格式正确 ----
  // Note: In dry-run mode, we test the format by directly setting entries
  // (simulating successful group creation)

  describe('CM-01: 建群后映射表格式正确', () => {
    it('should have valid MappingTable JSON structure after creating group', async () => {
      const key = makeDiscussionKey();
      const chatId = 'oc_cm01_test';

      // Simulate group creation followed by mapping write
      await env.store.set(key, {
        chatId,
        purpose: 'discussion',
      });

      // Read and verify the file format
      const mapping = readMappingFile(env.mappingPath);
      expect(mapping).not.toBeNull();
      expect(typeof mapping).toBe('object');
      expect(Array.isArray(mapping)).toBe(false);

      // Verify entry structure
      const entry = mapping![key];
      expect(entry).toBeDefined();
      expect(entry.chatId).toBe(chatId);
      expect(entry.purpose).toBe('discussion');
      expect(entry.createdAt).toBeDefined();

      // Verify createdAt is valid ISO date
      const createdAt = new Date(entry.createdAt);
      expect(createdAt.getTime()).not.toBeNaN();
    });

    it('should support multiple entry types in the same mapping file', async () => {
      // Add discussion entries (using realistic Feishu chatId format)
      await env.store.set('discussion-001', {
        chatId: 'oc_disc1a2b3c',
        purpose: 'discussion',
      });
      await env.store.set('discussion-002', {
        chatId: 'oc_disc4d5e6f',
        purpose: 'discussion',
      });

      // Add PR review entries (should coexist)
      await env.store.set('pr-100', {
        chatId: 'oc_pr100abc',
        purpose: 'pr-review',
      });

      const mapping = readMappingFile(env.mappingPath);
      expect(mapping).not.toBeNull();
      expect(Object.keys(mapping!)).toHaveLength(3);

      // Verify each entry has the required fields
      for (const [key, entry] of Object.entries(mapping!)) {
        expect(entry.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);
        expect(entry.purpose).toBeDefined();
        expect(entry.createdAt).toBeDefined();
        expect(typeof entry.chatId).toBe('string');
        expect(typeof entry.purpose).toBe('string');
        expect(typeof entry.createdAt).toBe('string');
      }
    });
  });

  // ---- CM-02: 并发建群不丢失 ----

  describe('CM-02: 并发建群不丢失', () => {
    it('should not lose entries when multiple writes happen concurrently', async () => {
      const concurrentWrites = 10;
      const writes = [];

      for (let i = 0; i < concurrentWrites; i++) {
        writes.push(
          env.store.set(`discussion-concurrent-${i}`, {
            chatId: `oc_concurrent_${i}`,
            purpose: 'discussion',
          }),
        );
      }

      await Promise.all(writes);

      // Verify all entries are present
      const entries = await env.store.list();
      expect(entries).toHaveLength(concurrentWrites);

      for (let i = 0; i < concurrentWrites; i++) {
        const entry = await env.store.get(`discussion-concurrent-${i}`);
        expect(entry).not.toBeNull();
        expect(entry!.chatId).toBe(`oc_concurrent_${i}`);
      }
    });

    it('should handle rapid sequential writes without loss', async () => {
      for (let i = 0; i < 20; i++) {
        await env.store.set(`discussion-rapid-${i}`, {
          chatId: `oc_rapid_${i}`,
          purpose: 'discussion',
        });
      }

      const size = await env.store.size();
      expect(size).toBe(20);

      // Verify each entry
      for (let i = 0; i < 20; i++) {
        const entry = await env.store.get(`discussion-rapid-${i}`);
        expect(entry).not.toBeNull();
        expect(entry!.chatId).toBe(`oc_rapid_${i}`);
      }
    });
  });

  // ---- CM-03: 映射表损坏自愈 ----
  // NOTE: Already covered by BotChatMappingStore unit tests.
  // See: packages/core/src/scheduling/bot-chat-mapping.test.ts
  //   - 'should handle invalid JSON gracefully'
  //   - 'should handle non-object JSON gracefully'
  //   - 'should handle directory creation errors gracefully'
  describe('CM-03: 映射表损坏自愈', () => {
    it('should gracefully handle corrupted mapping file (covered by unit tests)', () => {
      // This test case is already comprehensively covered in:
      // packages/core/src/scheduling/bot-chat-mapping.test.ts
      // - 'should handle invalid JSON gracefully'
      // - 'should handle non-object JSON gracefully'
      // See unit tests for full coverage.
      expect(true).toBe(true);
    });
  });

  // ---- CM-04: 从群列表重建映射 ----
  // NOTE: Already covered by BotChatMappingStore unit tests.
  // See: packages/core/src/scheduling/bot-chat-mapping.test.ts
  //   - 'should build new mappings from group names'
  //   - 'should keep existing mappings that match'
  //   - 'should update chatId if existing mapping has different chatId'
  //   - 'should remove mappings not found in scan when removeStale is true'
  describe('CM-04: 从群列表重建映射', () => {
    it('should rebuild mapping from group list (covered by unit tests)', () => {
      // This test case is already comprehensively covered in:
      // packages/core/src/scheduling/bot-chat-mapping.test.ts
      // - 'should build new mappings from group names'
      // - 'should keep existing mappings that match'
      // - 'should remove mappings not found in scan when removeStale is true'
      // See unit tests for full coverage.
      expect(true).toBe(true);
    });
  });

  // ---- Real lark-cli integration (skipped in dry-run) ----
  let runLarkTests = false;
  beforeAll(async () => {
    runLarkTests = await shouldRunLarkTests();
  });

  describe.skipIf(DRY_RUN || !runLarkTests)(
    'CM-01: lark-cli integration',
    () => {
      it('should have correct mapping format after real group creation', async () => {
        const key = makeDiscussionKey();
        const name = `test-integ-CM01-${Date.now()}`;

        const { stdout } = await execLark([
          'im', 'chat', 'create',
          '--name', name,
        ]);

        const chatId = parseChatIdFromOutput(stdout);
        expect(chatId).not.toBeNull();

        if (chatId) {
          env.createdChatIds.push(chatId);

          await env.store.set(key, {
            chatId,
            purpose: 'discussion',
          });

          // Verify the mapping file has valid structure
          const mapping = readMappingFile(env.mappingPath);
          expect(mapping).not.toBeNull();

          const entry = mapping![key];
          expect(entry).toBeDefined();
          expect(entry.chatId).toBe(chatId);
          expect(entry.purpose).toBe('discussion');
          expect(new Date(entry.createdAt).getTime()).not.toBeNaN();
        }
      });
    },
  );
});
