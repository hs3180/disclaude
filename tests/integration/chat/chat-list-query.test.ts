/**
 * Integration tests: /chat list & /chat query — 查询与列表
 *
 * Test cases CL-01, CL-02, CQ-01, CQ-02 from Issue #3284.
 *
 * These tests operate on the mapping file only and do NOT require lark-cli.
 * They always run (dry-run safe).
 *
 * @see Issue #3284 — Chat integration test design
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  createTestEnv,
  cleanupTestEnv,
  readMappingFile,
  type TestEnv,
} from './helpers.js';

describe('CL: /chat list — 列出讨论群', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(async () => {
    await cleanupTestEnv(env);
  });

  // CL-01: 列表空
  it('CL-01: 列表空 — 映射表为空时返回空列表', async () => {
    const entries = await env.store.list();
    expect(entries).toEqual([]);
    expect(entries).toHaveLength(0);

    // Also verify via direct file read
    const mapping = readMappingFile(env.mappingPath);
    // File may not exist yet (lazy init), or be empty
    if (mapping) {
      expect(Object.keys(mapping)).toHaveLength(0);
    }
  });

  // CL-02: 列表多条
  it('CL-02: 列表多条 — 多个群正确展示', async () => {
    const now = Date.now();

    // Add multiple mapping entries with different timestamps
    await env.store.set('discussion-1001', {
      chatId: 'oc_aaa',
      purpose: 'discussion',
      createdAt: new Date(now - 2000).toISOString(),
    });
    await env.store.set('discussion-1002', {
      chatId: 'oc_bbb',
      purpose: 'discussion',
      createdAt: new Date(now - 1000).toISOString(),
    });
    await env.store.set('discussion-1003', {
      chatId: 'oc_ccc',
      purpose: 'discussion',
      createdAt: new Date(now).toISOString(),
    });

    // Also add a non-discussion entry (should be excluded from discussion list)
    await env.store.set('pr-123', {
      chatId: 'oc_pr',
      purpose: 'pr-review',
      createdAt: new Date(now).toISOString(),
    });

    // List discussion entries only
    const discussions = await env.store.listByPurpose('discussion');
    expect(discussions).toHaveLength(3);

    const keys = discussions.map(([key]) => key);
    expect(keys).toContain('discussion-1001');
    expect(keys).toContain('discussion-1002');
    expect(keys).toContain('discussion-1003');

    // Verify all entries have correct structure
    for (const [, entry] of discussions) {
      expect(entry.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);
      expect(entry.purpose).toBe('discussion');
      expect(entry.createdAt).toBeDefined();
    }

    // Total mapping should include PR entry
    const all = await env.store.list();
    expect(all).toHaveLength(4);
  });

  // Additional: verify mapping file is valid JSON after writes
  it('should maintain valid JSON structure after multiple writes', async () => {
    for (let i = 0; i < 5; i++) {
      await env.store.set(`discussion-test-${i}`, {
        chatId: `oc_test_${i}`,
        purpose: 'discussion',
      });
    }

    const mapping = readMappingFile(env.mappingPath);
    expect(mapping).not.toBeNull();
    expect(Object.keys(mapping!)).toHaveLength(5);

    for (let i = 0; i < 5; i++) {
      const key = `discussion-test-${i}`;
      expect(mapping![key]).toBeDefined();
      expect(mapping![key].chatId).toBe(`oc_test_${i}`);
      expect(mapping![key].purpose).toBe('discussion');
    }
  });
});

describe('CQ: /chat query — 查询特定讨论群', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = createTestEnv();
  });

  afterEach(async () => {
    await cleanupTestEnv(env);
  });

  // CQ-01: 查询存在的 key
  it('CQ-01: 查询存在的 key — 返回正确的映射条目', async () => {
    const key = 'discussion-1714800000';
    await env.store.set(key, {
      chatId: 'oc_query_test',
      purpose: 'discussion',
      createdAt: '2026-05-04T08:00:00.000Z',
    });

    const entry = await env.store.get(key);
    expect(entry).not.toBeNull();
    expect(entry!.chatId).toBe('oc_query_test');
    expect(entry!.purpose).toBe('discussion');
    expect(entry!.createdAt).toBe('2026-05-04T08:00:00.000Z');
  });

  // CQ-02: 查询不存在的 key
  it('CQ-02: 查询不存在的 key — 返回 null', async () => {
    // Populate some entries
    await env.store.set('discussion-existing', {
      chatId: 'oc_exists',
      purpose: 'discussion',
    });

    // Query a non-existent key
    const entry = await env.store.get('discussion-nonexistent');
    expect(entry).toBeNull();
  });

  // Additional: query with different key patterns
  it('should distinguish between different key patterns', async () => {
    await env.store.set('discussion-100', {
      chatId: 'oc_disc',
      purpose: 'discussion',
    });
    await env.store.set('pr-100', {
      chatId: 'oc_pr',
      purpose: 'pr-review',
    });

    const discEntry = await env.store.get('discussion-100');
    const prEntry = await env.store.get('pr-100');

    expect(discEntry!.chatId).toBe('oc_disc');
    expect(prEntry!.chatId).toBe('oc_pr');
  });

  // Additional: query after update
  it('should reflect updates in subsequent queries', async () => {
    const key = 'discussion-updated';
    await env.store.set(key, {
      chatId: 'oc_old',
      purpose: 'discussion',
    });

    let entry = await env.store.get(key);
    expect(entry!.chatId).toBe('oc_old');

    // Update the entry
    await env.store.set(key, {
      chatId: 'oc_new',
      purpose: 'discussion',
    });

    entry = await env.store.get(key);
    expect(entry!.chatId).toBe('oc_new');
  });
});
