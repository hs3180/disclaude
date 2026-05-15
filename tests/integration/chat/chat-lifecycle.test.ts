/**
 * Chat skill integration tests — group lifecycle via real lark-cli.
 *
 * Tests the end-to-end flow of the chat skill:
 *   create group → write mapping → list/query → dissolve → verify cleanup
 *
 * All tests call real lark-cli commands and use real filesystem I/O
 * (BotChatMappingStore). Tests are automatically skipped when lark-cli
 * is unavailable (CI environments without Feishu credentials).
 *
 * Cleanup guarantee: every group created in a test is dissolved in afterAll,
 * even if individual test assertions fail.
 *
 * @see Issue #3284
 * @see Issue #3283 — chat skill design
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  isLarkCliAvailable,
  createGroup,
  dissolveGroup,
  createTestWorkspace,
  truncate,
  MAX_GROUP_NAME_LENGTH,
} from './helpers.js';
import type { CreateGroupResult } from './helpers.js';
import { makeMappingKey } from '@disclaude/core';

// ---- Prerequisite check ----

let larkAvailable = false;

beforeAll(async () => {
  larkAvailable = await isLarkCliAvailable();
  if (!larkAvailable) {
    console.warn('SKIP: lark-cli not available — chat integration tests skipped');
  }
});

// ---- CC: Create group tests ----

describe('CC — Group creation', () => {
  const createdGroups: CreateGroupResult[] = [];
  const workspace = createTestWorkspace();

  afterAll(async () => {
    // Cleanup: dissolve all groups created in this describe block
    for (const g of createdGroups) {
      await dissolveGroup(g.chatId).catch(() => { /* best effort */ });
    }
    workspace.cleanup();
  });

  it.skipIf(!true)('CC-01: should create a group via lark-cli and return a valid chatId', async () => {
    if (!larkAvailable) return;

    const result = await createGroup('test-CC-01');
    createdGroups.push(result);

    // Verify chatId format
    expect(result.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);
    expect(result.rawOutput).toBeTruthy();
  });

  it('CC-02: should write mapping after group creation', async () => {
    if (!larkAvailable) return;

    const result = await createGroup('test-CC-02');
    createdGroups.push(result);

    const key = makeMappingKey('discussion', 'cc02');
    await workspace.store.set(key, {
      chatId: result.chatId,
      purpose: 'discussion',
    });

    const entry = await workspace.store.get(key);
    expect(entry).not.toBeNull();
    expect(entry!.chatId).toBe(result.chatId);
    expect(entry!.purpose).toBe('discussion');
    expect(entry!.createdAt).toBeTruthy();
  });

  it('CC-05: should handle group name truncation for names exceeding 64 chars', async () => {
    if (!larkAvailable) return;

    // Generate a long name with CJK characters
    const longName = '测试'.repeat(40); // 80 chars — exceeds 64
    const truncatedName = truncate(longName, MAX_GROUP_NAME_LENGTH);

    expect(Array.from(truncatedName).length).toBeLessThanOrEqual(MAX_GROUP_NAME_LENGTH);

    const result = await createGroup(truncatedName);
    createdGroups.push(result);

    expect(result.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);
  });

  it('CC-06: should create group with mixed characters (emoji, CJK, English)', async () => {
    if (!larkAvailable) return;

    const mixedName = '讨论Review✅Phase-1 🚀';
    const result = await createGroup(mixedName);
    createdGroups.push(result);

    expect(result.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);
  });

  it('CC-08: should allow creating a second group with different key (idempotent at mapping level)', async () => {
    if (!larkAvailable) return;

    const result1 = await createGroup('test-CC-08a');
    createdGroups.push(result1);
    const result2 = await createGroup('test-CC-08b');
    createdGroups.push(result2);

    // Two different groups with different chatIds
    expect(result1.chatId).not.toBe(result2.chatId);

    // Both can be stored in mapping with different keys
    await workspace.store.set('cc08-a', { chatId: result1.chatId, purpose: 'discussion' });
    await workspace.store.set('cc08-b', { chatId: result2.chatId, purpose: 'discussion' });

    expect(await workspace.store.get('cc08-a')).not.toBeNull();
    expect(await workspace.store.get('cc08-b')).not.toBeNull();
  });
});

// ---- CD: Dissolve group tests ----

describe('CD — Group dissolution', () => {
  const createdGroups: CreateGroupResult[] = [];
  const workspace = createTestWorkspace();

  afterAll(async () => {
    for (const g of createdGroups) {
      await dissolveGroup(g.chatId).catch(() => { /* best effort */ });
    }
    workspace.cleanup();
  });

  it('CD-01: should dissolve a group via lark-cli', async () => {
    if (!larkAvailable) return;

    const group = await createGroup('test-CD-01');
    createdGroups.push(group);

    const result = await dissolveGroup(group.chatId);
    expect(result.success).toBe(true);

    // Remove from cleanup list since already dissolved
    const idx = createdGroups.findIndex(g => g.chatId === group.chatId);
    if (idx >= 0) createdGroups.splice(idx, 1);
  });

  it('CD-02: should clean up mapping after dissolution', async () => {
    if (!larkAvailable) return;

    const group = await createGroup('test-CD-02');
    createdGroups.push(group);
    const key = makeMappingKey('discussion', 'cd02');

    await workspace.store.set(key, { chatId: group.chatId, purpose: 'discussion' });
    expect(await workspace.store.get(key)).not.toBeNull();

    // Dissolve
    const result = await dissolveGroup(group.chatId);
    expect(result.success).toBe(true);

    // Clean up mapping
    await workspace.store.delete(key);
    expect(await workspace.store.get(key)).toBeNull();

    const idx = createdGroups.findIndex(g => g.chatId === group.chatId);
    if (idx >= 0) createdGroups.splice(idx, 1);
  });

  it('CD-03: should return error when dissolving non-existent group', async () => {
    if (!larkAvailable) return;

    const result = await dissolveGroup('oc_nonexistent0000000000000000000');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('CD-04: should not affect other mappings when dissolving one', async () => {
    if (!larkAvailable) return;

    const group1 = await createGroup('test-CD-04a');
    createdGroups.push(group1);
    const group2 = await createGroup('test-CD-04b');
    createdGroups.push(group2);

    const key1 = makeMappingKey('discussion', 'cd04a');
    const key2 = makeMappingKey('discussion', 'cd04b');

    await workspace.store.set(key1, { chatId: group1.chatId, purpose: 'discussion' });
    await workspace.store.set(key2, { chatId: group2.chatId, purpose: 'discussion' });

    // Dissolve group1 only
    const result = await dissolveGroup(group1.chatId);
    expect(result.success).toBe(true);
    await workspace.store.delete(key1);

    // group2 mapping should still exist
    const entry2 = await workspace.store.get(key2);
    expect(entry2).not.toBeNull();
    expect(entry2!.chatId).toBe(group2.chatId);

    const idx = createdGroups.findIndex(g => g.chatId === group1.chatId);
    if (idx >= 0) createdGroups.splice(idx, 1);
  });

  it('CD-05: should return error on second dissolution of same group', async () => {
    if (!larkAvailable) return;

    const group = await createGroup('test-CD-05');
    createdGroups.push(group);

    // First dissolve
    const result1 = await dissolveGroup(group.chatId);
    expect(result1.success).toBe(true);

    // Second dissolve — should fail (group already dissolved)
    const result2 = await dissolveGroup(group.chatId);
    expect(result2.success).toBe(false);

    const idx = createdGroups.findIndex(g => g.chatId === group.chatId);
    if (idx >= 0) createdGroups.splice(idx, 1);
  });
});

// ---- CL: List tests ----

describe('CL — List mappings', () => {
  const workspace = createTestWorkspace();

  afterAll(() => {
    workspace.cleanup();
  });

  it('CL-01: should return empty list when no mappings', async () => {
    const entries = await workspace.store.list();
    expect(entries).toHaveLength(0);
  });

  it('CL-02: should list multiple entries', async () => {
    await workspace.store.set('cl-a', { chatId: 'oc_aaaa', purpose: 'discussion' });
    await workspace.store.set('cl-b', { chatId: 'oc_bbbb', purpose: 'pr-review' });
    await workspace.store.set('cl-c', { chatId: 'oc_cccc', purpose: 'discussion' });

    const entries = await workspace.store.list();
    expect(entries).toHaveLength(3);

    const keys = entries.map(([k]) => k);
    expect(keys).toContain('cl-a');
    expect(keys).toContain('cl-b');
    expect(keys).toContain('cl-c');
  });
});

// ---- CQ: Query tests ----

describe('CQ — Query mappings', () => {
  const workspace = createTestWorkspace();

  beforeAll(async () => {
    await workspace.store.set('cq-1', { chatId: 'oc_query123', purpose: 'discussion' });
  });

  afterAll(() => {
    workspace.cleanup();
  });

  it('CQ-01: should find an existing mapping by key', async () => {
    const entry = await workspace.store.get('cq-1');
    expect(entry).not.toBeNull();
    expect(entry!.chatId).toBe('oc_query123');
    expect(entry!.purpose).toBe('discussion');
  });

  it('CQ-02: should return null for non-existent key', async () => {
    const entry = await workspace.store.get('cq-nonexistent');
    expect(entry).toBeNull();
  });
});

// ---- CM: Mapping table integrity ----

describe('CM — Mapping table integrity', () => {
  const workspace = createTestWorkspace();

  afterAll(() => {
    workspace.cleanup();
  });

  it('CM-01: mapping file should contain valid JSON with correct structure', async () => {
    await workspace.store.set('cm-1', { chatId: 'oc_integ1', purpose: 'discussion' });
    await workspace.store.set('cm-2', { chatId: 'oc_integ2', purpose: 'pr-review' });

    const { readFile } = await import('fs/promises');
    const pathJoin = (await import('path')).join;
    const content = await readFile(
      pathJoin(workspace.dir, 'bot-chat-mapping.json'),
      'utf-8',
    );
    const parsed = JSON.parse(content);

    expect(typeof parsed).toBe('object');
    expect(Array.isArray(parsed)).toBe(false);

    // Each entry should have chatId, createdAt, purpose
    for (const [, entry] of Object.entries(parsed)) {
      const e = entry as Record<string, unknown>;
      expect(e.chatId).toBeTruthy();
      expect(typeof e.chatId).toBe('string');
      expect(e.createdAt).toBeTruthy();
      expect(typeof e.createdAt).toBe('string');
      expect(e.purpose).toBeTruthy();
      expect(typeof e.purpose).toBe('string');
    }
  });

  it('CM-03: should recover from corrupted mapping file', async () => {
    const { writeFile } = await import('fs/promises');
    const { join } = await import('path');

    // Corrupt the mapping file
    await writeFile(join(workspace.dir, 'bot-chat-mapping.json'), 'INVALID JSON{{{"');

    // Create a fresh store — should recover gracefully
    const { BotChatMappingStore: FreshStore } = await import('@disclaude/core');
    const freshStore = new FreshStore({
      filePath: join(workspace.dir, 'bot-chat-mapping.json'),
    });

    // Should start with empty cache (recovered)
    const size = await freshStore.size();
    expect(size).toBe(0);

    // Should be usable after recovery
    await freshStore.set('cm-recover', { chatId: 'oc_recovered', purpose: 'discussion' });
    const entry = await freshStore.get('cm-recover');
    expect(entry).not.toBeNull();
    expect(entry!.chatId).toBe('oc_recovered');
  });
});

// ---- End-to-end lifecycle ----

describe('E2E — Full group lifecycle', () => {
  const createdGroups: CreateGroupResult[] = [];
  const workspace = createTestWorkspace();

  afterAll(async () => {
    for (const g of createdGroups) {
      await dissolveGroup(g.chatId).catch(() => {});
    }
    workspace.cleanup();
  });

  it('should create group, write mapping, list, query, and dissolve', async () => {
    if (!larkAvailable) return;

    // Step 1: Create
    const group = await createGroup('test-E2E-lifecycle', 'End-to-end test');
    createdGroups.push(group);
    expect(group.chatId).toMatch(/^oc_[a-zA-Z0-9]+$/);

    // Step 2: Write mapping
    const key = makeMappingKey('discussion', 'e2e');
    await workspace.store.set(key, {
      chatId: group.chatId,
      purpose: 'discussion',
    });

    // Step 3: List — should include new entry
    const entries = await workspace.store.list();
    const found = entries.some(([k]) => k === key);
    expect(found).toBe(true);

    // Step 4: Query — should return correct data
    const entry = await workspace.store.get(key);
    expect(entry).not.toBeNull();
    expect(entry!.chatId).toBe(group.chatId);

    // Step 5: Dissolve
    const dissolveResult = await dissolveGroup(group.chatId);
    expect(dissolveResult.success).toBe(true);

    // Step 6: Clean mapping
    await workspace.store.delete(key);
    expect(await workspace.store.get(key)).toBeNull();

    // Remove from cleanup list
    const idx = createdGroups.findIndex(g => g.chatId === group.chatId);
    if (idx >= 0) createdGroups.splice(idx, 1);
  });
});
