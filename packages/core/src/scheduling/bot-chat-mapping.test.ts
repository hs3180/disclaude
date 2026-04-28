/**
 * Unit tests for BotChatMappingStore
 *
 * Issue #2947: Bot group chat mapping management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BotChatMappingStore,
  makeMappingKey,
  parseGroupNameToKey,
  purposeFromKey,
  type MappingTable,
} from './bot-chat-mapping.js';
import * as fsPromises from 'fs/promises';

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    unlink: vi.fn(),
  },
  mkdir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

describe('BotChatMappingStore', () => {
  let store: BotChatMappingStore;
  const filePath = '/tmp/test-bot-chat-mapping.json';

  beforeEach(() => {
    store = new BotChatMappingStore({ filePath });

    // Mock mkdir to succeed
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    // Mock readFile to return file not found
    const enoentError = new Error('Not found') as NodeJS.ErrnoException;
    enoentError.code = 'ENOENT';
    vi.mocked(fsPromises.readFile).mockRejectedValue(enoentError);
    // Mock writeFile and rename for persistence
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
    vi.mocked(fsPromises.rename).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Constructor ----

  describe('constructor', () => {
    it('should create a BotChatMappingStore', () => {
      expect(store).toBeDefined();
    });
  });

  // ---- get / has ----

  describe('get', () => {
    it('should return null for non-existent key', async () => {
      const result = await store.get('pr-999');
      expect(result).toBeNull();
    });

    it('should return the mapping entry after set', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });

      const result = await store.get('pr-123');
      expect(result).not.toBeNull();
      expect(result!.chatId).toBe('oc_xxx');
      expect(result!.purpose).toBe('pr-review');
      expect(result!.createdAt).toBeDefined();
    });
  });

  describe('has', () => {
    it('should return false for non-existent key', async () => {
      const result = await store.has('pr-999');
      expect(result).toBe(false);
    });

    it('should return true after set', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      const result = await store.has('pr-123');
      expect(result).toBe(true);
    });
  });

  // ---- set ----

  describe('set', () => {
    it('should create a mapping entry and persist to file', async () => {
      const entry = await store.set('pr-123', { chatId: 'oc_abc', purpose: 'pr-review' });

      expect(entry.chatId).toBe('oc_abc');
      expect(entry.purpose).toBe('pr-review');
      expect(entry.createdAt).toBeDefined();

      // Verify persistence was called
      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('.tmp'),
        expect.stringContaining('"oc_abc"'),
        'utf-8',
      );
      expect(fsPromises.rename).toHaveBeenCalled();
    });

    it('should use provided createdAt if specified', async () => {
      const customDate = '2026-04-28T10:00:00.000Z';
      const entry = await store.set('pr-123', {
        chatId: 'oc_xxx',
        purpose: 'pr-review',
        createdAt: customDate,
      });

      expect(entry.createdAt).toBe(customDate);
    });

    it('should auto-generate createdAt if not provided', async () => {
      const before = new Date();
      const entry = await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      const after = new Date();

      const createdAt = new Date(entry.createdAt);
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should update an existing mapping', async () => {
      await store.set('pr-123', { chatId: 'oc_old', purpose: 'pr-review' });
      await store.set('pr-123', { chatId: 'oc_new', purpose: 'pr-review' });

      const result = await store.get('pr-123');
      expect(result!.chatId).toBe('oc_new');
    });

    it('should handle writeFile errors gracefully', async () => {
      vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error('Write error'));

      // Should not throw
      const entry = await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      expect(entry.chatId).toBe('oc_xxx');
    });
  });

  // ---- delete ----

  describe('delete', () => {
    it('should return false for non-existent key', async () => {
      const result = await store.delete('pr-999');
      expect(result).toBe(false);
    });

    it('should remove a mapping entry', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      const deleted = await store.delete('pr-123');

      expect(deleted).toBe(true);
      const entry = await store.get('pr-123');
      expect(entry).toBeNull();
    });

    it('should persist after deletion', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      vi.mocked(fsPromises.writeFile).mockClear();
      vi.mocked(fsPromises.rename).mockClear();

      await store.delete('pr-123');

      expect(fsPromises.writeFile).toHaveBeenCalled();
      expect(fsPromises.rename).toHaveBeenCalled();
    });
  });

  // ---- list / listByPurpose ----

  describe('list', () => {
    it('should return empty array when no mappings exist', async () => {
      const result = await store.list();
      expect(result).toEqual([]);
    });

    it('should return all mapping entries', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await store.set('pr-456', { chatId: 'oc_yyy', purpose: 'pr-review' });
      await store.set('discussion-1', { chatId: 'oc_zzz', purpose: 'discussion' });

      const result = await store.list();
      expect(result).toHaveLength(3);

      const keys = result.map(([key]) => key);
      expect(keys).toContain('pr-123');
      expect(keys).toContain('pr-456');
      expect(keys).toContain('discussion-1');
    });
  });

  describe('listByPurpose', () => {
    it('should filter entries by purpose', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await store.set('pr-456', { chatId: 'oc_yyy', purpose: 'pr-review' });
      await store.set('discussion-1', { chatId: 'oc_zzz', purpose: 'discussion' });

      const result = await store.listByPurpose('pr-review');
      expect(result).toHaveLength(2);

      const keys = result.map(([key]) => key);
      expect(keys).toContain('pr-123');
      expect(keys).toContain('pr-456');
    });

    it('should return empty array for non-existent purpose', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });

      const result = await store.listByPurpose('nonexistent');
      expect(result).toEqual([]);
    });
  });

  // ---- rebuildFromGroupList ----

  describe('rebuildFromGroupList', () => {
    it('should build new mappings from group names', async () => {
      const groups = [
        { chatId: 'oc_aaa', name: 'PR #123 · Fix authentication bug' },
        { chatId: 'oc_bbb', name: 'PR #456 · Add new feature' },
      ];

      const result = await store.rebuildFromGroupList(groups);

      expect(result.scanned).toBe(2);
      expect(result.added).toBe(2);
      expect(result.kept).toBe(0);
      expect(result.removed).toBe(0);

      const entry123 = await store.get('pr-123');
      expect(entry123).not.toBeNull();
      expect(entry123!.chatId).toBe('oc_aaa');
      expect(entry123!.purpose).toBe('pr-review');

      const entry456 = await store.get('pr-456');
      expect(entry456).not.toBeNull();
      expect(entry456!.chatId).toBe('oc_bbb');
    });

    it('should keep existing mappings that match', async () => {
      await store.set('pr-123', { chatId: 'oc_aaa', purpose: 'pr-review' });

      const groups = [
        { chatId: 'oc_aaa', name: 'PR #123 · Fix authentication bug' },
      ];

      const result = await store.rebuildFromGroupList(groups);

      expect(result.scanned).toBe(1);
      expect(result.added).toBe(0);
      expect(result.kept).toBe(1);
    });

    it('should update chatId if existing mapping has different chatId', async () => {
      await store.set('pr-123', { chatId: 'oc_old', purpose: 'pr-review' });

      const groups = [
        { chatId: 'oc_new', name: 'PR #123 · Fix authentication bug' },
      ];

      const result = await store.rebuildFromGroupList(groups);

      expect(result.kept).toBe(1);

      const entry = await store.get('pr-123');
      expect(entry!.chatId).toBe('oc_new');
    });

    it('should keep mappings not found in scan by default (append-only)', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await store.set('pr-789', { chatId: 'oc_yyy', purpose: 'pr-review' });

      const groups = [
        { chatId: 'oc_xxx', name: 'PR #123 · Fix authentication bug' },
      ];

      const result = await store.rebuildFromGroupList(groups);

      expect(result.scanned).toBe(1);
      expect(result.kept).toBe(1);
      expect(result.removed).toBe(0);

      // pr-789 should be kept (append-only mode)
      const entry789 = await store.get('pr-789');
      expect(entry789).not.toBeNull();

      // pr-123 should still exist
      const keptEntry = await store.get('pr-123');
      expect(keptEntry).not.toBeNull();
    });

    it('should remove mappings not found in scan when removeStale is true', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await store.set('pr-789', { chatId: 'oc_yyy', purpose: 'pr-review' });

      const groups = [
        { chatId: 'oc_xxx', name: 'PR #123 · Fix authentication bug' },
      ];

      const result = await store.rebuildFromGroupList(groups, { removeStale: true });

      expect(result.scanned).toBe(1);
      expect(result.kept).toBe(1);
      expect(result.removed).toBe(1);

      // pr-789 should be removed
      const entry = await store.get('pr-789');
      expect(entry).toBeNull();

      // pr-123 should still exist
      const keptEntry = await store.get('pr-123');
      expect(keptEntry).not.toBeNull();
    });

    it('should skip groups with unparseable names', async () => {
      const groups = [
        { chatId: 'oc_aaa', name: 'PR #123 · Fix authentication bug' },
        { chatId: 'oc_bbb', name: 'Random group name' },
        { chatId: 'oc_ccc', name: 'Some other chat' },
      ];

      const result = await store.rebuildFromGroupList(groups);

      expect(result.scanned).toBe(3);
      expect(result.added).toBe(1);

      const entry = await store.get('pr-123');
      expect(entry).not.toBeNull();
    });

    it('should handle empty group list (append-only, keeps existing)', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });

      const result = await store.rebuildFromGroupList([]);

      expect(result.scanned).toBe(0);
      expect(result.removed).toBe(0);

      // Existing mapping should still exist
      const entry = await store.get('pr-123');
      expect(entry).not.toBeNull();
    });

    it('should remove all mappings on empty group list when removeStale is true', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });

      const result = await store.rebuildFromGroupList([], { removeStale: true });

      expect(result.scanned).toBe(0);
      expect(result.removed).toBe(1);

      const entry = await store.get('pr-123');
      expect(entry).toBeNull();
    });

    it('should persist after rebuild', async () => {
      const groups = [
        { chatId: 'oc_aaa', name: 'PR #123 · Fix authentication bug' },
      ];

      vi.mocked(fsPromises.writeFile).mockClear();
      vi.mocked(fsPromises.rename).mockClear();

      await store.rebuildFromGroupList(groups);

      expect(fsPromises.writeFile).toHaveBeenCalled();
      expect(fsPromises.rename).toHaveBeenCalled();
    });
  });

  // ---- size / clear ----

  describe('size', () => {
    it('should return 0 for empty store', async () => {
      expect(await store.size()).toBe(0);
    });

    it('should return the correct count', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await store.set('pr-456', { chatId: 'oc_yyy', purpose: 'pr-review' });

      expect(await store.size()).toBe(2);
    });

    it('should update after delete', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await store.delete('pr-123');

      expect(await store.size()).toBe(0);
    });
  });

  describe('clear', () => {
    it('should remove all mappings', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await store.set('pr-456', { chatId: 'oc_yyy', purpose: 'pr-review' });

      await store.clear();

      expect(await store.size()).toBe(0);
      expect(await store.get('pr-123')).toBeNull();
      expect(await store.get('pr-456')).toBeNull();
    });

    it('should persist empty mapping after clear', async () => {
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      vi.mocked(fsPromises.writeFile).mockClear();

      await store.clear();

      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('{}'),
        'utf-8',
      );
    });
  });

  // ---- Initialization / Persistence ----

  describe('initialization', () => {
    it('should load existing mapping file from disk', async () => {
      const existingData: MappingTable = {
        'pr-123': { chatId: 'oc_loaded', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
      };

      vi.mocked(fsPromises.readFile).mockResolvedValue(JSON.stringify(existingData));

      const freshStore = new BotChatMappingStore({ filePath });
      const entry = await freshStore.get('pr-123');

      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe('oc_loaded');
      expect(entry!.purpose).toBe('pr-review');
    });

    it('should handle ENOENT gracefully (new file)', async () => {
      const enoentError = new Error('Not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.mocked(fsPromises.readFile).mockRejectedValue(enoentError);

      const freshStore = new BotChatMappingStore({ filePath });
      const entry = await freshStore.get('pr-123');
      expect(entry).toBeNull();
    });

    it('should handle invalid JSON gracefully', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('not valid json{');

      const freshStore = new BotChatMappingStore({ filePath });
      const entry = await freshStore.get('pr-123');
      expect(entry).toBeNull();
    });

    it('should handle non-object JSON gracefully', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('[]');

      const freshStore = new BotChatMappingStore({ filePath });
      const entry = await freshStore.get('pr-123');
      expect(entry).toBeNull();
    });

    it('should handle directory creation errors gracefully', async () => {
      vi.mocked(fsPromises.mkdir).mockRejectedValue(new Error('Permission denied'));

      // Should not throw
      await store.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      const result = await store.get('pr-123');
      expect(result).not.toBeNull();
    });
  });
});

// ---- Pure function tests ----

describe('parseGroupNameToKey', () => {
  it('should parse PR group names with middle dot', () => {
    expect(parseGroupNameToKey('PR #123 · Fix authentication bug')).toBe('pr-123');
  });

  it('should parse PR group names with bullet', () => {
    expect(parseGroupNameToKey('PR #456 • Add feature')).toBe('pr-456');
  });

  it('should parse PR group names with hyphen', () => {
    expect(parseGroupNameToKey('PR #789 - Some fix')).toBe('pr-789');
  });

  it('should parse PR group names with en dash', () => {
    expect(parseGroupNameToKey('PR #100 – Title')).toBe('pr-100');
  });

  it('should parse PR group names with em dash', () => {
    expect(parseGroupNameToKey('PR #200 — Title')).toBe('pr-200');
  });

  it('should return null for non-matching names', () => {
    expect(parseGroupNameToKey('Random group')).toBeNull();
    expect(parseGroupNameToKey('Some other chat')).toBeNull();
  });

  it('should return null for empty string', () => {
    expect(parseGroupNameToKey('')).toBeNull();
  });
});

describe('makeMappingKey', () => {
  it('should generate pr- prefix for pr-review purpose', () => {
    expect(makeMappingKey('pr-review', 123)).toBe('pr-123');
    expect(makeMappingKey('pr-review', '456')).toBe('pr-456');
  });

  it('should generate purpose-prefixed key for other purposes', () => {
    expect(makeMappingKey('discussion', 'weekly')).toBe('discussion-weekly');
  });
});

describe('purposeFromKey', () => {
  it('should return pr-review for pr- prefixed keys', () => {
    expect(purposeFromKey('pr-123')).toBe('pr-review');
    expect(purposeFromKey('pr-1')).toBe('pr-review');
  });

  it('should return prefix for other keys', () => {
    expect(purposeFromKey('discussion-weekly')).toBe('discussion');
  });

  it('should handle keys without hyphens', () => {
    expect(purposeFromKey('simple')).toBe('discussion');
  });
});
