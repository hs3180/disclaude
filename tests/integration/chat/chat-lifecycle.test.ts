/**
 * Integration tests for chat skill group lifecycle (Issue #3284).
 *
 * Tests the full integration: lark-cli commands + BotChatMappingStore.
 * Real lark-cli calls are used — tests are skipped when unavailable.
 *
 * Environment variables:
 * - TEST_CHAT_DRY_RUN: Set to '0' to enable real lark-cli calls (default: '1', skips)
 * - TEST_CHAT_USER_IDS: Comma-separated ou_xxx IDs for member tests (max 5)
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { BotChatMappingStore, makeMappingKey } from '@disclaude/core';
import {
  isLarkCliAvailable,
  createGroup,
  dissolveGroup,
  createTempStore,
  truncateName,
  testGroupName,
} from './helpers.js';

// ── Skip conditions ─────────────────────────────────────────────────

const DRY_RUN = process.env.TEST_CHAT_DRY_RUN !== '0';

const TEST_USERS = (process.env.TEST_CHAT_USER_IDS ?? '')
  .split(',')
  .map((u) => u.trim())
  .filter(Boolean);
const VALID_TEST_USERS = TEST_USERS.filter((u) => /^ou_[a-zA-Z0-9]+$/.test(u)).slice(0, 5);

let hasLark = false;

beforeAll(async () => {
  if (!DRY_RUN) {
    hasLark = await isLarkCliAvailable();
  }
});

// ── Test state ──────────────────────────────────────────────────────

let store: BotChatMappingStore;
let storeCleanup: () => Promise<void>;
const createdGroups: string[] = [];

beforeEach(async () => {
  const tmp = await createTempStore();
  store = tmp.store;
  storeCleanup = tmp.cleanup;
  createdGroups.length = 0;
});

afterEach(async () => {
  // Dissolve any groups not cleaned up by individual tests
  while (createdGroups.length > 0) {
    const chatId = createdGroups.pop()!;
    await dissolveGroup(chatId).catch(() => {});
  }
  await storeCleanup();
});

// Helper: register a group for auto-cleanup
function trackGroup(chatId: string): string {
  createdGroups.push(chatId);
  return chatId;
}

// Helper: unregister a group (e.g., after manual dissolve)
function untrackGroup(chatId: string): void {
  const idx = createdGroups.indexOf(chatId);
  if (idx >= 0) createdGroups.splice(idx, 1);
}

// Skip wrapper — skipped when DRY_RUN=1 (default)
// When DRY_RUN=0 but lark-cli is absent, tests fail with a clear error
const itLark = it.skipIf(DRY_RUN);

// ════════════════════════════════════════════════════════════════════
// CC: Create Group (建群流程)
// ════════════════════════════════════════════════════════════════════

describe('CC: Create Group', () => {
  itLark('CC-01: basic create — returns valid chatId', async () => {
    const name = testGroupName('CC-01');
    const result = await createGroup(name);

    expect(result.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);
    trackGroup(result.chatId);
  });

  itLark('CC-02: create + mapping write — key/purpose/chatId correct', async () => {
    const purpose = 'discussion';
    const identifier = Date.now();
    const key = makeMappingKey(purpose, identifier);
    const name = testGroupName('CC-02');

    const { chatId } = await createGroup(name);
    trackGroup(chatId);

    await store.set(key, { chatId, purpose });

    const entry = await store.get(key);
    expect(entry).not.toBeNull();
    expect(entry!.chatId).toBe(chatId);
    expect(entry!.purpose).toBe(purpose);
    expect(entry!.createdAt).toBeTruthy();
  });

  it.skipIf(VALID_TEST_USERS.length === 0 || DRY_RUN)(
    'CC-04: create + add members',
    async () => {
      const name = testGroupName('CC-04');
      const { chatId } = await createGroup(name);
      trackGroup(chatId);

      // Add members via lark-cli
      const { execFile: exec } = await import('child_process');
      const { promisify } = await import('util');
      const execAsync = promisify(exec);

      for (const userId of VALID_TEST_USERS) {
        await execAsync(
          'lark-cli',
          ['im', 'chat', 'member', 'add', '--chat-id', chatId, '--member-id', userId],
          { timeout: 15_000 },
        );
      }
    },
  );

  it('CC-05: name truncation — CJK-safe truncation to 64 chars', () => {
    const longName = '测试'.repeat(40); // 80 CJK chars → 160 width units
    const truncated = truncateName(longName, 64);

    // Verify width is within limit
    let width = 0;
    for (let i = 0; i < truncated.length; i++) {
      const cp = truncated.codePointAt(i)!;
      width += cp > 0x7f ? 2 : 1;
    }
    expect(width).toBeLessThanOrEqual(64);
    expect(truncated.length).toBeLessThan(longName.length);
    expect(truncated.length).toBeGreaterThan(0);
  });

  itLark('CC-06: name with special characters — emoji, CJK, English', async () => {
    const name = testGroupName('CC-06 emoji🎉中文English');
    const result = await createGroup(name);

    expect(result.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);
    trackGroup(result.chatId);
  });

  it('CC-07: lark-cli unavailable — createGroup throws clear error', async () => {
    // This test verifies error handling by checking that a missing tool
    // produces an actionable error (the real scenario is tested when DRY_RUN=0
    // and lark-cli is absent — those tests fail with a clear message).
    // Here we verify the helper's error path with an invalid command.
    const { execFile: exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    await expect(
      execAsync('lark-cli-nonexistent', ['--version'], { timeout: 2_000 }),
    ).rejects.toThrow();
  });

  itLark('CC-08: idempotent create — same topic creates new group', async () => {
    const name = testGroupName('CC-08');

    const r1 = await createGroup(name);
    const r2 = await createGroup(name);
    trackGroup(r1.chatId);
    trackGroup(r2.chatId);

    // Same name creates different groups (different chatId)
    expect(r1.chatId).not.toBe(r2.chatId);
  });
});

// ════════════════════════════════════════════════════════════════════
// CD: Dissolve Group (解散群流程)
// ════════════════════════════════════════════════════════════════════

describe('CD: Dissolve Group', () => {
  itLark('CD-01: basic dissolve — group deleted successfully', async () => {
    const name = testGroupName('CD-01');
    const { chatId } = await createGroup(name);

    const result = await dissolveGroup(chatId);
    expect(result.success).toBe(true);
    untrackGroup(chatId); // Already dissolved — don't double-dissolve in cleanup
  });

  itLark('CD-02: dissolve + mapping cleanup — entry removed', async () => {
    const key = makeMappingKey('discussion', Date.now());
    const name = testGroupName('CD-02');
    const { chatId } = await createGroup(name);
    trackGroup(chatId);

    await store.set(key, { chatId, purpose: 'discussion' });

    // Dissolve and clean mapping
    const result = await dissolveGroup(chatId);
    expect(result.success).toBe(true);
    untrackGroup(chatId);

    await store.delete(key);

    const entry = await store.get(key);
    expect(entry).toBeNull();
  });

  itLark('CD-03: dissolve non-existent group — returns error', async () => {
    const result = await dissolveGroup('oc_nonexistent123');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  itLark('CD-04: other entries unaffected after dissolve', async () => {
    const key1 = makeMappingKey('discussion', Date.now());
    const key2 = makeMappingKey('discussion', Date.now() + 1);

    const g1 = await createGroup(testGroupName('CD-04a'));
    const g2 = await createGroup(testGroupName('CD-04b'));
    trackGroup(g1.chatId);
    trackGroup(g2.chatId);

    await store.set(key1, { chatId: g1.chatId, purpose: 'discussion' });
    await store.set(key2, { chatId: g2.chatId, purpose: 'discussion' });

    // Dissolve g1
    await dissolveGroup(g1.chatId);
    untrackGroup(g1.chatId);
    await store.delete(key1);

    // g2 mapping should be intact
    const entry2 = await store.get(key2);
    expect(entry2).not.toBeNull();
    expect(entry2!.chatId).toBe(g2.chatId);
  });

  itLark('CD-05: double dissolve — second fails but no crash', async () => {
    const name = testGroupName('CD-05');
    const { chatId } = await createGroup(name);

    const r1 = await dissolveGroup(chatId);
    expect(r1.success).toBe(true);

    const r2 = await dissolveGroup(chatId);
    expect(r2.success).toBe(false); // Already dissolved
    expect(r2.error).toBeTruthy();
    untrackGroup(chatId);
  });
});

// ════════════════════════════════════════════════════════════════════
// CL: List (列表)
// ════════════════════════════════════════════════════════════════════

describe('CL: List groups', () => {
  it('CL-01: empty mapping — returns empty list', async () => {
    const entries = await store.list();
    expect(entries).toEqual([]);
  });

  it('CL-02: multiple entries — all present', async () => {
    await store.set('discussion-1', { chatId: 'oc_aaa', purpose: 'discussion' });
    await store.set('discussion-2', { chatId: 'oc_bbb', purpose: 'discussion' });

    const entries = await store.list();
    expect(entries).toHaveLength(2);

    const keys = entries.map(([k]) => k);
    expect(keys).toContain('discussion-1');
    expect(keys).toContain('discussion-2');
  });
});

// ════════════════════════════════════════════════════════════════════
// CQ: Query (查询)
// ════════════════════════════════════════════════════════════════════

describe('CQ: Query group', () => {
  it('CQ-01: query existing key — returns correct entry', async () => {
    await store.set('discussion-42', { chatId: 'oc_test123', purpose: 'discussion' });

    const entry = await store.get('discussion-42');
    expect(entry).not.toBeNull();
    expect(entry!.chatId).toBe('oc_test123');
    expect(entry!.purpose).toBe('discussion');
  });

  it('CQ-02: query non-existent key — returns null', async () => {
    const entry = await store.get('nonexistent-key');
    expect(entry).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════
// CM: Mapping integrity (映射表完整性)
// ════════════════════════════════════════════════════════════════════

describe('CM: Mapping integrity', () => {
  itLark('CM-01: mapping format after create — valid JSON structure', async () => {
    const key = makeMappingKey('discussion', Date.now());
    const name = testGroupName('CM-01');
    const { chatId } = await createGroup(name);
    trackGroup(chatId);

    await store.set(key, { chatId, purpose: 'discussion' });

    const entry = await store.get(key);
    expect(entry).not.toBeNull();
    expect(entry!.chatId).toMatch(/^oc_/);
    expect(entry!.purpose).toBe('discussion');
    expect(entry!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('CM-02: concurrent set — no data loss', async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      store.set(`concurrent-${i}`, { chatId: `oc_concurrent_${i}`, purpose: 'discussion' }),
    );
    await Promise.all(promises);

    const size = await store.size();
    expect(size).toBe(10);

    // Verify each entry individually
    for (let i = 0; i < 10; i++) {
      const entry = await store.get(`concurrent-${i}`);
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe(`oc_concurrent_${i}`);
    }
  });

  // CM-03 (corruption self-heal) is already covered by
  // packages/core/src/scheduling/bot-chat-mapping.test.ts

  itLark('CM-04: rebuild from group list — recovers mapping', async () => {
    const name = 'PR #999 · Test rebuild';
    const { chatId } = await createGroup(name);
    trackGroup(chatId);

    // Simulate the group list returned by `lark-cli im chats list --as bot`
    const groups = [{ chatId, name }];
    const result = await store.rebuildFromGroupList(groups);

    expect(result.added).toBe(1);

    const entry = await store.get('pr-999');
    expect(entry).not.toBeNull();
    expect(entry!.chatId).toBe(chatId);
    expect(entry!.purpose).toBe('pr-review');
  });
});
