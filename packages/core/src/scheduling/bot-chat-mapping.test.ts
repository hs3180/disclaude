/**
 * Unit tests for BotChatMapping
 *
 * Issue #2947: Bot 群映射表管理 — 维护 PR↔ChatId 对应关系
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BotChatMapping, type BotChatMappingEntry, type BotChatMappingTable } from './bot-chat-mapping.js';
import * as fsPromises from 'fs/promises';

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
  },
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

describe('BotChatMapping', () => {
  let mapping: BotChatMapping;
  const filePath = '/tmp/test-bot-chat-mapping.json';

  beforeEach(() => {
    mapping = new BotChatMapping({ filePath });

    // Mock mkdir to succeed
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    // Mock readFile to return empty file (ENOENT)
    const enoentError = new Error('Not found') as NodeJS.ErrnoException;
    enoentError.code = 'ENOENT';
    vi.mocked(fsPromises.readFile).mockRejectedValue(enoentError);
    // Mock writeFile to succeed
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create a BotChatMapping instance', () => {
      expect(mapping).toBeDefined();
    });
  });

  describe('set and get', () => {
    it('should set a mapping entry and retrieve it', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });

      const entry = await mapping.get('pr-123');
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe('oc_xxx');
      expect(entry!.purpose).toBe('pr-review');
      expect(entry!.createdAt).toBeDefined();
    });

    it('should auto-generate createdAt if not provided', async () => {
      const before = new Date();
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      const after = new Date();

      const entry = await mapping.get('pr-123');
      expect(entry).not.toBeNull();

      const createdAt = new Date(entry!.createdAt);
      expect(createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should use provided createdAt if specified', async () => {
      const customDate = '2026-04-28T10:00:00.000Z';
      await mapping.set('pr-456', { chatId: 'oc_yyy', purpose: 'pr-review', createdAt: customDate });

      const entry = await mapping.get('pr-456');
      expect(entry).not.toBeNull();
      expect(entry!.createdAt).toBe(customDate);
    });

    it('should overwrite an existing entry', async () => {
      await mapping.set('pr-123', { chatId: 'oc_old', purpose: 'pr-review' });
      await mapping.set('pr-123', { chatId: 'oc_new', purpose: 'pr-review' });

      const entry = await mapping.get('pr-123');
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe('oc_new');
    });

    it('should persist to file on set', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });

      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        filePath,
        expect.any(String),
        'utf-8'
      );

      // Verify JSON structure
      const writeCall = vi.mocked(fsPromises.writeFile).mock.calls.find(
        call => call[0] === filePath
      );
      expect(writeCall).toBeDefined();
      const content = JSON.parse(writeCall![1] as string);
      expect(content['pr-123']).toBeDefined();
      expect(content['pr-123'].chatId).toBe('oc_xxx');
    });

    it('should return null for non-existent key', async () => {
      const entry = await mapping.get('pr-nonexistent');
      expect(entry).toBeNull();
    });
  });

  describe('has', () => {
    it('should return true for existing key', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      expect(await mapping.has('pr-123')).toBe(true);
    });

    it('should return false for non-existent key', async () => {
      expect(await mapping.has('pr-nonexistent')).toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete an existing entry and return true', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      const result = await mapping.delete('pr-123');

      expect(result).toBe(true);
      const entry = await mapping.get('pr-123');
      expect(entry).toBeNull();
    });

    it('should return false for non-existent key', async () => {
      const result = await mapping.delete('pr-nonexistent');
      expect(result).toBe(false);
    });

    it('should persist to file after deletion', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      vi.mocked(fsPromises.writeFile).mockClear();
      await mapping.delete('pr-123');

      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        filePath,
        expect.any(String),
        'utf-8'
      );

      const writeCall = vi.mocked(fsPromises.writeFile).mock.calls.find(
        call => call[0] === filePath
      );
      expect(writeCall).toBeDefined();
      const content = JSON.parse(writeCall![1] as string);
      expect(content['pr-123']).toBeUndefined();
    });
  });

  describe('list', () => {
    it('should return empty array when no entries', async () => {
      const result = await mapping.list();
      expect(result).toEqual([]);
    });

    it('should return all entries', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await mapping.set('pr-456', { chatId: 'oc_yyy', purpose: 'pr-review' });

      const result = await mapping.list();
      expect(result).toHaveLength(2);

      const keys = result.map(r => r.key);
      expect(keys).toContain('pr-123');
      expect(keys).toContain('pr-456');
    });
  });

  describe('listByPurpose', () => {
    it('should filter entries by purpose', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await mapping.set('pr-456', { chatId: 'oc_yyy', purpose: 'pr-review' });
      await mapping.set('discussion-1', { chatId: 'oc_zzz', purpose: 'discussion' });

      const prReviews = await mapping.listByPurpose('pr-review');
      expect(prReviews).toHaveLength(2);
      expect(prReviews.every(r => r.entry.purpose === 'pr-review')).toBe(true);
    });

    it('should return empty array for non-existent purpose', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });

      const result = await mapping.listByPurpose('discussion');
      expect(result).toEqual([]);
    });
  });

  describe('findByChatId', () => {
    it('should find entry by chatId', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });

      const result = await mapping.findByChatId('oc_xxx');
      expect(result).not.toBeNull();
      expect(result!.key).toBe('pr-123');
      expect(result!.entry.chatId).toBe('oc_xxx');
    });

    it('should return null for non-existent chatId', async () => {
      const result = await mapping.findByChatId('oc_nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('rebuild', () => {
    it('should add new entries from rebuild data', async () => {
      const entries: Array<{ key: string; entry: BotChatMappingEntry }> = [
        {
          key: 'pr-100',
          entry: { chatId: 'oc_100', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
        },
        {
          key: 'pr-200',
          entry: { chatId: 'oc_200', createdAt: '2026-04-28T11:00:00Z', purpose: 'pr-review' },
        },
      ];

      const result = await mapping.rebuild(entries);

      expect(result.rebuilt).toBe(2);
      expect(result.kept).toBe(0);
      expect(result.total).toBe(2);

      const entry100 = await mapping.get('pr-100');
      expect(entry100).not.toBeNull();
      expect(entry100!.chatId).toBe('oc_100');
    });

    it('should keep existing entries with matching chatId', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });

      const entries: Array<{ key: string; entry: BotChatMappingEntry }> = [
        {
          key: 'pr-123',
          entry: { chatId: 'oc_xxx', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
        },
      ];

      const result = await mapping.rebuild(entries);

      expect(result.rebuilt).toBe(0);
      expect(result.kept).toBe(1);
      expect(result.total).toBe(1);
    });

    it('should update entries with different chatId', async () => {
      await mapping.set('pr-123', { chatId: 'oc_old', purpose: 'pr-review' });

      const entries: Array<{ key: string; entry: BotChatMappingEntry }> = [
        {
          key: 'pr-123',
          entry: { chatId: 'oc_new', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
        },
      ];

      const result = await mapping.rebuild(entries);

      expect(result.rebuilt).toBe(1);
      expect(result.total).toBe(1);

      const entry = await mapping.get('pr-123');
      expect(entry!.chatId).toBe('oc_new');
    });

    it('should not remove entries not in rebuild data', async () => {
      await mapping.set('pr-existing', { chatId: 'oc_existing', purpose: 'pr-review' });

      const entries: Array<{ key: string; entry: BotChatMappingEntry }> = [
        {
          key: 'pr-new',
          entry: { chatId: 'oc_new', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
        },
      ];

      const result = await mapping.rebuild(entries);

      expect(result.rebuilt).toBe(1);
      expect(result.total).toBe(2);

      // Original entry should still exist
      const existing = await mapping.get('pr-existing');
      expect(existing).not.toBeNull();
    });

    it('should persist after rebuild', async () => {
      const entries: Array<{ key: string; entry: BotChatMappingEntry }> = [
        {
          key: 'pr-100',
          entry: { chatId: 'oc_100', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
        },
      ];

      await mapping.rebuild(entries);

      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        filePath,
        expect.stringContaining('"pr-100"'),
        'utf-8'
      );
    });
  });

  describe('clear', () => {
    it('should remove all entries', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await mapping.set('pr-456', { chatId: 'oc_yyy', purpose: 'pr-review' });

      await mapping.clear();

      const size = await mapping.size();
      expect(size).toBe(0);

      const list = await mapping.list();
      expect(list).toEqual([]);
    });
  });

  describe('size', () => {
    it('should return 0 for empty mapping', async () => {
      const size = await mapping.size();
      expect(size).toBe(0);
    });

    it('should return correct count after entries added', async () => {
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      await mapping.set('pr-456', { chatId: 'oc_yyy', purpose: 'pr-review' });

      const size = await mapping.size();
      expect(size).toBe(2);
    });
  });

  describe('initialization', () => {
    it('should load existing entries from file', async () => {
      const table: BotChatMappingTable = {
        'pr-100': { chatId: 'oc_100', createdAt: '2026-04-28T10:00:00Z', purpose: 'pr-review' },
        'pr-200': { chatId: 'oc_200', createdAt: '2026-04-28T11:00:00Z', purpose: 'pr-review' },
      };

      vi.mocked(fsPromises.readFile).mockResolvedValue(JSON.stringify(table));

      const freshMapping = new BotChatMapping({ filePath });
      const entry = await freshMapping.get('pr-100');
      expect(entry).not.toBeNull();
      expect(entry!.chatId).toBe('oc_100');
    });

    it('should start with empty cache when file does not exist', async () => {
      const enoentError = new Error('Not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.mocked(fsPromises.readFile).mockRejectedValue(enoentError);

      const freshMapping = new BotChatMapping({ filePath });
      const size = await freshMapping.size();
      expect(size).toBe(0);
    });

    it('should handle directory creation errors gracefully', async () => {
      vi.mocked(fsPromises.mkdir).mockRejectedValue(new Error('Permission denied'));

      // Should not throw — continues without persistence
      await mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' });
      const entry = await mapping.get('pr-123');
      expect(entry).not.toBeNull();
    });

    it('should handle malformed JSON in mapping file', async () => {
      vi.mocked(fsPromises.readFile).mockResolvedValue('not valid json{{{');

      const freshMapping = new BotChatMapping({ filePath });
      const size = await freshMapping.size();
      expect(size).toBe(0);
    });

    it('should handle writeFile errors gracefully on set', async () => {
      vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error('Disk full'));

      // Should not throw — cache is still updated
      await expect(
        mapping.set('pr-123', { chatId: 'oc_xxx', purpose: 'pr-review' })
      ).resolves.not.toThrow();

      const entry = await mapping.get('pr-123');
      expect(entry).not.toBeNull();
    });
  });

  describe('use cases from Issue #2947', () => {
    it('should support PR review workflow: create → query → disband → delete', async () => {
      // 1. Create mapping when PR discussion group is created
      await mapping.set('pr-123', { chatId: 'oc_pr123_group', purpose: 'pr-review' });
      expect(await mapping.has('pr-123')).toBe(true);

      // 2. Query mapping to check if PR already has a group
      const entry = await mapping.get('pr-123');
      expect(entry!.chatId).toBe('oc_pr123_group');

      // 3. Reverse lookup from chatId (e.g., when receiving a message from Feishu)
      const found = await mapping.findByChatId('oc_pr123_group');
      expect(found!.key).toBe('pr-123');

      // 4. Delete mapping when group is disbanded
      const deleted = await mapping.delete('pr-123');
      expect(deleted).toBe(true);
      expect(await mapping.has('pr-123')).toBe(false);
    });

    it('should support listing all PR review groups', async () => {
      await mapping.set('pr-100', { chatId: 'oc_100', purpose: 'pr-review' });
      await mapping.set('pr-200', { chatId: 'oc_200', purpose: 'pr-review' });
      await mapping.set('discussion-1', { chatId: 'oc_disc1', purpose: 'discussion' });

      const prGroups = await mapping.listByPurpose('pr-review');
      expect(prGroups).toHaveLength(2);
    });

    it('should support rebuild from external data', async () => {
      // Simulate rebuilding from lark-cli chat list + naming convention parsing
      const rebuiltEntries: Array<{ key: string; entry: BotChatMappingEntry }> = [
        {
          key: 'pr-100',
          entry: {
            chatId: 'oc_rebuilt_100',
            createdAt: '2026-04-28T10:00:00Z',
            purpose: 'pr-review',
          },
        },
        {
          key: 'pr-200',
          entry: {
            chatId: 'oc_rebuilt_200',
            createdAt: '2026-04-28T11:00:00Z',
            purpose: 'pr-review',
          },
        },
      ];

      const result = await mapping.rebuild(rebuiltEntries);
      expect(result.rebuilt).toBe(2);
      expect(result.total).toBe(2);

      // Verify entries are accessible
      const entry100 = await mapping.get('pr-100');
      expect(entry100!.chatId).toBe('oc_rebuilt_100');
    });
  });
});
