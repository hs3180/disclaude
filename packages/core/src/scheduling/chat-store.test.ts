/**
 * Unit tests for ChatStore
 *
 * Issue #1703: Phase 1 — Core data layer for temporary chat management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatStore, type TempChatRecord, type TempChatResponse } from './chat-store.js';
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

describe('ChatStore', () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = '/tmp/test-temp-chats';
    // Mock mkdir to succeed
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    // Mock readdir to return empty by default
    vi.mocked(fsPromises.readdir).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: create a ChatStore pre-loaded with records by simulating file loading.
   */
  async function createStoreWithRecords(records: TempChatRecord[]): Promise<ChatStore> {
    if (records.length > 0) {
      const filenames = records.map(r =>
        `${r.chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`
      );
      vi.mocked(fsPromises.readdir).mockResolvedValue(filenames as any);
      vi.mocked(fsPromises.readFile).mockImplementation((filePath: unknown) => {
        const pathStr = (filePath as string).toString();
        for (const record of records) {
          const safeId = record.chatId.replace(/[^a-zA-Z0-9_-]/g, '_');
          if (pathStr.includes(safeId)) {
            return Promise.resolve(JSON.stringify(record));
          }
        }
        return Promise.reject(new Error('Not found'));
      });
    }

    const freshStore = new ChatStore({ storeDir });
    // Trigger initialization by calling any method
    await freshStore.listTempChats();
    return freshStore;
  }

  /**
   * Helper: create a minimal TempChatRecord for testing.
   */
  function makeRecord(overrides: Partial<TempChatRecord> & { chatId: string }): TempChatRecord {
    return {
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
  }

  describe('constructor', () => {
    it('should create a ChatStore', async () => {
      const store = await createStoreWithRecords([]);
      expect(store).toBeDefined();
    });

    it('should handle readdir permission error gracefully', async () => {
      // Simulate a non-ENOENT error (e.g., permission denied)
      const permError = new Error('Permission denied') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      vi.mocked(fsPromises.readdir).mockRejectedValue(permError);

      // Should not throw — the store initializes with empty cache
      const store = new ChatStore({ storeDir });
      const result = await store.listTempChats();
      expect(result).toEqual([]);
    });
  });

  describe('getTempChat', () => {
    it('should return null for non-existent chat', async () => {
      const store = await createStoreWithRecords([]);
      const result = await store.getTempChat('oc_nonexistent');
      expect(result).toBeNull();
    });

    it('should return the loaded record', async () => {
      const store = await createStoreWithRecords([
        makeRecord({ chatId: 'oc_test1', creatorChatId: 'oc_orig' }),
      ]);

      const result = await store.getTempChat('oc_test1');
      expect(result).not.toBeNull();
      expect(result!.chatId).toBe('oc_test1');
      expect(result!.creatorChatId).toBe('oc_orig');
    });
  });

  describe('listTempChats', () => {
    it('should return empty array when no chats registered', async () => {
      const store = await createStoreWithRecords([]);
      const result = await store.listTempChats();
      expect(result).toEqual([]);
    });

    it('should return all loaded chats', async () => {
      const store = await createStoreWithRecords([
        makeRecord({ chatId: 'oc_test1' }),
        makeRecord({ chatId: 'oc_test2' }),
      ]);

      const result = await store.listTempChats();
      expect(result).toHaveLength(2);
      expect(result.map(r => r.chatId)).toContain('oc_test1');
      expect(result.map(r => r.chatId)).toContain('oc_test2');
    });
  });

  describe('removeTempChat', () => {
    it('should return false for non-existent chat', async () => {
      const store = await createStoreWithRecords([]);
      const result = await store.removeTempChat('oc_nonexistent');
      expect(result).toBe(false);
    });

    it('should remove a loaded chat and delete file', async () => {
      const store = await createStoreWithRecords([
        makeRecord({ chatId: 'oc_test1' }),
      ]);

      const result = await store.removeTempChat('oc_test1');
      expect(result).toBe(true);
      expect(fsPromises.unlink).toHaveBeenCalled();

      // Should no longer exist
      const chat = await store.getTempChat('oc_test1');
      expect(chat).toBeNull();
    });

    it('should handle unlink ENOENT gracefully', async () => {
      const store = await createStoreWithRecords([
        makeRecord({ chatId: 'oc_test1' }),
      ]);

      const enoentError = new Error('Not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.mocked(fsPromises.unlink).mockRejectedValue(enoentError);

      // Should not throw, still returns true (removed from memory)
      const result = await store.removeTempChat('oc_test1');
      expect(result).toBe(true);
    });
  });

  describe('markTempChatResponded', () => {
    it('should return false for non-existent chat', async () => {
      const store = await createStoreWithRecords([]);
      const response: TempChatResponse = {
        selectedValue: 'approve',
        responder: 'ou_xxx',
        repliedAt: new Date().toISOString(),
      };
      const result = await store.markTempChatResponded('oc_nonexistent', response);
      expect(result).toBe(false);
    });

    it('should update record with response and persist', async () => {
      const store = await createStoreWithRecords([
        makeRecord({ chatId: 'oc_test1' }),
      ]);

      const response: TempChatResponse = {
        selectedValue: 'approve',
        responder: 'ou_xxx',
        repliedAt: '2026-03-27T10:00:00.000Z',
      };
      const result = await store.markTempChatResponded('oc_test1', response);
      expect(result).toBe(true);

      // Verify persisted with response
      const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls.filter(
        call => call[0].toString().includes('oc_test1.json')
      );
      expect(writeCalls.length).toBeGreaterThanOrEqual(1);
      const record = JSON.parse(writeCalls[writeCalls.length - 1][1] as string);
      expect(record.response.selectedValue).toBe('approve');
      expect(record.response.responder).toBe('ou_xxx');
    });

    it('should persist response even on writeFile error', async () => {
      const store = await createStoreWithRecords([
        makeRecord({ chatId: 'oc_test1' }),
      ]);

      vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error('Persist error'));

      const response: TempChatResponse = {
        selectedValue: 'reject',
        responder: 'ou_yyy',
        repliedAt: new Date().toISOString(),
      };
      const result = await store.markTempChatResponded('oc_test1', response);
      expect(result).toBe(true);

      // In-memory record should still be updated
      const chat = await store.getTempChat('oc_test1');
      expect(chat?.response?.selectedValue).toBe('reject');
    });
  });

  describe('getExpiredTempChats', () => {
    it('should return empty array when no chats are expired', async () => {
      const store = await createStoreWithRecords([
        makeRecord({
          chatId: 'oc_test1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
      ]);

      const expired = await store.getExpiredTempChats();
      expect(expired).toEqual([]);
    });

    it('should return chats that are expired and not responded', async () => {
      const store = await createStoreWithRecords([
        makeRecord({
          chatId: 'oc_expired1',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ]);

      const expired = await store.getExpiredTempChats();
      expect(expired).toHaveLength(1);
      expect(expired[0].chatId).toBe('oc_expired1');
    });

    it('should not return expired chats that have been responded', async () => {
      const store = await createStoreWithRecords([
        makeRecord({
          chatId: 'oc_expired1',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          response: {
            selectedValue: 'approve',
            responder: 'ou_xxx',
            repliedAt: new Date().toISOString(),
          },
        }),
      ]);

      const expired = await store.getExpiredTempChats();
      expect(expired).toEqual([]);
    });

    it('should mix expired and non-expired correctly', async () => {
      const store = await createStoreWithRecords([
        makeRecord({
          chatId: 'oc_expired1',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        makeRecord({
          chatId: 'oc_active1',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        makeRecord({
          chatId: 'oc_expired2',
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ]);

      const expired = await store.getExpiredTempChats();
      expect(expired).toHaveLength(2);
      expect(expired.map(r => r.chatId)).toContain('oc_expired1');
      expect(expired.map(r => r.chatId)).toContain('oc_expired2');
    });
  });

  describe('initialization', () => {
    it('should load existing records from disk', async () => {
      const store = await createStoreWithRecords([{
        chatId: 'oc_existing',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        creatorChatId: 'oc_original',
      }]);

      const chat = await store.getTempChat('oc_existing');
      expect(chat).not.toBeNull();
      expect(chat!.chatId).toBe('oc_existing');
      expect(chat!.creatorChatId).toBe('oc_original');
    });

    it('should handle directory creation errors gracefully', async () => {
      vi.mocked(fsPromises.mkdir).mockRejectedValue(new Error('Permission denied'));

      const store = new ChatStore({ storeDir });
      // Should not throw — continues without persistence
      const chats = await store.listTempChats();
      expect(chats).toEqual([]);
    });

    it('should load passiveMode from disk (Issue #2069)', async () => {
      const store = await createStoreWithRecords([{
        chatId: 'oc_passive_off',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        passiveMode: false,
      }]);

      const chat = await store.getTempChat('oc_passive_off');
      expect(chat).not.toBeNull();
      expect(chat!.passiveMode).toBe(false);
    });

    it('should load triggerMode from disk (Issue #2291)', async () => {
      const store = await createStoreWithRecords([{
        chatId: 'oc_trigger_always',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        triggerMode: 'always',
      }]);

      const chat = await store.getTempChat('oc_trigger_always');
      expect(chat).not.toBeNull();
      expect(chat!.triggerMode).toBe('always');
    });
  });
});
