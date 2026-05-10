/**
 * Unit tests for ChatArchiveStore
 *
 * Issue #2191: Unified group chat records — archive, summarize, and retrieve.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ChatArchiveStore,
  type ArchivedChatRecord,
} from './chat-archive-store.js';
import * as fsPromises from 'fs/promises';

vi.mock('fs/promises', () => ({
  default: {
    mkdir: vi.fn(),
    readdir: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
  mkdir: vi.fn(),
  readdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

describe('ChatArchiveStore', () => {
  let archiveDir: string;

  beforeEach(() => {
    archiveDir = '/tmp/test-chat-archives';
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: create a ChatArchiveStore pre-loaded with records.
   */
  async function createStoreWithRecords(
    records: ArchivedChatRecord[],
  ): Promise<ChatArchiveStore> {
    // Mock index loading
    if (records.length > 0) {
      const indexEntries = records.map((r) => ({
        chatId: r.chatId,
        topic: r.topic,
        purpose: r.purpose,
        createdAt: r.createdAt,
        closedAt: r.closedAt,
        status: r.status,
      }));
      vi.mocked(fsPromises.readFile).mockImplementation(
        (filePath: unknown) => {
          const pathStr = (filePath as string).toString();
          if (pathStr.endsWith('index.json')) {
            return Promise.resolve(JSON.stringify(indexEntries));
          }
          // Individual record files
          for (const record of records) {
            const safeId = record.chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
            if (pathStr.includes(safeId)) {
              return Promise.resolve(JSON.stringify(record));
            }
          }
          return Promise.reject(Object.assign(new Error('Not found'), { code: 'ENOENT' }));
        },
      );
    } else {
      const enoentError = new Error('Not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.mocked(fsPromises.readFile).mockRejectedValue(enoentError);
    }

    const store = new ChatArchiveStore({ archiveDir });
    // Trigger initialization
    await store.count();
    return store;
  }

  /**
   * Helper: create a minimal ArchivedChatRecord for testing.
   */
  function makeArchive(
    overrides: Partial<ArchivedChatRecord> & { chatId: string },
  ): ArchivedChatRecord {
    return {
      createdAt: '2026-05-10T08:00:00.000Z',
      closedAt: '2026-05-10T10:00:00.000Z',
      topic: 'Test discussion',
      purpose: 'discussion',
      participants: [],
      status: 'completed',
      ...overrides,
    };
  }

  // ---- Constructor ----

  describe('constructor', () => {
    it('should create a ChatArchiveStore', async () => {
      const store = await createStoreWithRecords([]);
      expect(store).toBeDefined();
    });
  });

  // ---- Archive ----

  describe('archive', () => {
    it('should write a record file and update index', async () => {
      const store = await createStoreWithRecords([]);
      const record = makeArchive({ chatId: 'oc_test1' });

      await store.archive(record);

      // Should have written the record file
      expect(fsPromises.writeFile).toHaveBeenCalled();
      const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls;
      const recordWrite = writeCalls.find((call) =>
        (call[0] as string).includes('oc_test1.json'),
      );
      expect(recordWrite).toBeDefined();

      // Should have written the index
      const indexWrite = writeCalls.find((call) =>
        (call[0] as string).endsWith('index.json'),
      );
      expect(indexWrite).toBeDefined();

      const indexData = JSON.parse(indexWrite![1] as string);
      expect(indexData).toHaveLength(1);
      expect(indexData[0].chatId).toBe('oc_test1');
    });

    it('should overwrite an existing archive', async () => {
      const store = await createStoreWithRecords([
        makeArchive({ chatId: 'oc_test1', topic: 'Old topic' }),
      ]);

      // Capture the new data written by archive()
      let lastWrittenRecord: string | null = null;
      vi.mocked(fsPromises.writeFile).mockImplementation((filePath, data) => {
        const pathStr = (filePath as string).toString();
        if (pathStr.includes('oc_test1.json')) {
          lastWrittenRecord = data as string;
        }
        return Promise.resolve();
      });

      const updated = makeArchive({ chatId: 'oc_test1', topic: 'New topic' });
      await store.archive(updated);

      // Update readFile mock to return the newly written data
      vi.mocked(fsPromises.readFile).mockImplementation((filePath) => {
        const pathStr = (filePath as string).toString();
        if (pathStr.includes('oc_test1.json') && lastWrittenRecord) {
          return Promise.resolve(lastWrittenRecord);
        }
        return Promise.reject(Object.assign(new Error('Not found'), { code: 'ENOENT' }));
      });

      // Should be able to retrieve the updated record
      const result = await store.getArchive('oc_test1');
      expect(result).not.toBeNull();
      expect(result!.topic).toBe('New topic');
    });

    it('should throw on write failure', async () => {
      const store = await createStoreWithRecords([]);
      vi.mocked(fsPromises.writeFile).mockRejectedValue(
        new Error('Disk full'),
      );

      const record = makeArchive({ chatId: 'oc_test1' });
      await expect(store.archive(record)).rejects.toThrow('Disk full');
    });
  });

  // ---- GetArchive ----

  describe('getArchive', () => {
    it('should return null for non-existent chat', async () => {
      const store = await createStoreWithRecords([]);
      const result = await store.getArchive('oc_nonexistent');
      expect(result).toBeNull();
    });

    it('should return the archived record', async () => {
      const store = await createStoreWithRecords([
        makeArchive({
          chatId: 'oc_test1',
          topic: 'PR Review Discussion',
          purpose: 'pr-review',
          summary: {
            topic: 'Review auth refactor',
            conclusions: ['Use JWT'],
            actionItems: ['Update middleware'],
            generatedAt: '2026-05-10T10:00:00.000Z',
          },
        }),
      ]);

      const result = await store.getArchive('oc_test1');
      expect(result).not.toBeNull();
      expect(result!.chatId).toBe('oc_test1');
      expect(result!.topic).toBe('PR Review Discussion');
      expect(result!.summary?.conclusions).toContain('Use JWT');
    });

    it('should return null when index says it exists but file is missing', async () => {
      // Create store with index entry but no file
      const indexEntries = [
        {
          chatId: 'oc_missing',
          topic: 'Missing',
          purpose: 'discussion',
          createdAt: '2026-05-10T08:00:00.000Z',
          closedAt: '2026-05-10T10:00:00.000Z',
          status: 'completed' as const,
        },
      ];
      const enoentError = new Error('Not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.mocked(fsPromises.readFile)
        .mockResolvedValueOnce(JSON.stringify(indexEntries))
        .mockRejectedValue(enoentError);

      const store = new ChatArchiveStore({ archiveDir });
      const result = await store.getArchive('oc_missing');
      expect(result).toBeNull();
    });
  });

  // ---- ListArchives ----

  describe('listArchives', () => {
    it('should return empty array when no archives', async () => {
      const store = await createStoreWithRecords([]);
      const result = await store.listArchives();
      expect(result).toEqual([]);
    });

    it('should list archives sorted by closedAt descending', async () => {
      const store = await createStoreWithRecords([
        makeArchive({ chatId: 'oc_old', closedAt: '2026-05-08T10:00:00.000Z' }),
        makeArchive({ chatId: 'oc_new', closedAt: '2026-05-10T10:00:00.000Z' }),
        makeArchive({ chatId: 'oc_mid', closedAt: '2026-05-09T10:00:00.000Z' }),
      ]);

      const result = await store.listArchives();
      expect(result).toHaveLength(3);
      expect(result[0].chatId).toBe('oc_new');
      expect(result[1].chatId).toBe('oc_mid');
      expect(result[2].chatId).toBe('oc_old');
    });

    it('should filter by status', async () => {
      const store = await createStoreWithRecords([
        makeArchive({ chatId: 'oc_completed', status: 'completed' }),
        makeArchive({ chatId: 'oc_expired', status: 'expired' }),
      ]);

      const result = await store.listArchives({ filter: 'expired' });
      expect(result).toHaveLength(1);
      expect(result[0].chatId).toBe('oc_expired');
    });

    it('should filter by purpose', async () => {
      const store = await createStoreWithRecords([
        makeArchive({ chatId: 'oc_pr', purpose: 'pr-review' }),
        makeArchive({ chatId: 'oc_disc', purpose: 'discussion' }),
      ]);

      const result = await store.listArchives({ purpose: 'pr-review' });
      expect(result).toHaveLength(1);
      expect(result[0].chatId).toBe('oc_pr');
    });

    it('should apply limit and offset', async () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        makeArchive({
          chatId: `oc_${i}`,
          closedAt: new Date(Date.now() + i * 60_000).toISOString(),
        }),
      );
      const store = await createStoreWithRecords(records);

      const page1 = await store.listArchives({ limit: 2, offset: 0 });
      expect(page1).toHaveLength(2);

      const page2 = await store.listArchives({ limit: 2, offset: 2 });
      expect(page2).toHaveLength(2);

      const page3 = await store.listArchives({ limit: 2, offset: 4 });
      expect(page3).toHaveLength(1);
    });
  });

  // ---- Search ----

  describe('search', () => {
    it('should find archives by topic', async () => {
      const store = await createStoreWithRecords([
        makeArchive({ chatId: 'oc_auth', topic: 'Auth refactor discussion' }),
        makeArchive({ chatId: 'oc_deploy', topic: 'Deployment pipeline' }),
      ]);

      const results = await store.search('auth');
      expect(results).toHaveLength(1);
      expect(results[0].chatId).toBe('oc_auth');
    });

    it('should find archives by purpose', async () => {
      const store = await createStoreWithRecords([
        makeArchive({ chatId: 'oc_pr1', purpose: 'pr-review' }),
        makeArchive({ chatId: 'oc_disc1', purpose: 'discussion' }),
      ]);

      const results = await store.search('pr-review');
      expect(results).toHaveLength(1);
      expect(results[0].chatId).toBe('oc_pr1');
    });

    it('should be case-insensitive', async () => {
      const store = await createStoreWithRecords([
        makeArchive({ chatId: 'oc_test', topic: 'AUTH Refactor' }),
      ]);

      const results = await store.search('auth');
      expect(results).toHaveLength(1);
    });

    it('should respect limit', async () => {
      const records = Array.from({ length: 5 }, (_, i) =>
        makeArchive({ chatId: `oc_${i}`, topic: `Deploy step ${i}` }),
      );
      const store = await createStoreWithRecords(records);

      const results = await store.search('deploy', { limit: 2 });
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  // ---- Count ----

  describe('count', () => {
    it('should return 0 for empty store', async () => {
      const store = await createStoreWithRecords([]);
      expect(await store.count()).toBe(0);
    });

    it('should return the total number of archives', async () => {
      const store = await createStoreWithRecords([
        makeArchive({ chatId: 'oc_1' }),
        makeArchive({ chatId: 'oc_2' }),
        makeArchive({ chatId: 'oc_3' }),
      ]);
      expect(await store.count()).toBe(3);
    });
  });

  // ---- DeleteArchive ----

  describe('deleteArchive', () => {
    it('should return false for non-existent archive', async () => {
      const store = await createStoreWithRecords([]);
      const result = await store.deleteArchive('oc_nonexistent');
      expect(result).toBe(false);
    });

    it('should delete the archive file and remove from index', async () => {
      const store = await createStoreWithRecords([
        makeArchive({ chatId: 'oc_test1' }),
      ]);

      const result = await store.deleteArchive('oc_test1');
      expect(result).toBe(true);
      expect(fsPromises.unlink).toHaveBeenCalled();

      // Should no longer exist
      const archive = await store.getArchive('oc_test1');
      expect(archive).toBeNull();

      // Count should be 0
      expect(await store.count()).toBe(0);
    });

    it('should handle unlink ENOENT gracefully', async () => {
      const store = await createStoreWithRecords([
        makeArchive({ chatId: 'oc_test1' }),
      ]);

      const enoentError = new Error('Not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.mocked(fsPromises.unlink).mockRejectedValue(enoentError);

      // Should still succeed (removed from index)
      const result = await store.deleteArchive('oc_test1');
      expect(result).toBe(true);
      expect(await store.count()).toBe(0);
    });
  });

  // ---- Initialization ----

  describe('initialization', () => {
    it('should handle directory creation errors gracefully', async () => {
      vi.mocked(fsPromises.mkdir).mockRejectedValue(
        new Error('Permission denied'),
      );
      const enoentError = new Error('Not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.mocked(fsPromises.readFile).mockRejectedValue(enoentError);

      const store = new ChatArchiveStore({ archiveDir });
      const count = await store.count();
      expect(count).toBe(0);
    });

    it('should handle corrupted index gracefully', async () => {
      vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
      vi.mocked(fsPromises.readFile).mockResolvedValue('not valid json');

      const store = new ChatArchiveStore({ archiveDir });
      // Should not throw
      const count = await store.count();
      // The store should start with empty index when index is corrupted
      expect(typeof count).toBe('number');
    });
  });
});
