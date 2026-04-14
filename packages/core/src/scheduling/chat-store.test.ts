/**
 * Unit tests for ChatStore
 *
 * Issue #1703: Phase 1 — Core data layer for temporary chat management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatStore, type TempChatResponse } from './chat-store.js';
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
  let store: ChatStore;
  let storeDir: string;

  beforeEach(() => {
    storeDir = '/tmp/test-temp-chats';
    store = new ChatStore({ storeDir });

    // Mock mkdir to succeed
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    // Mock readdir to return empty
    vi.mocked(fsPromises.readdir).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create a ChatStore', () => {
      expect(store).toBeDefined();
    });
  });

  describe('registerTempChat', () => {
    it('should register a temp chat and persist to file', async () => {
      await store.registerTempChat('oc_test1');

      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('oc_test1.json'),
        expect.stringContaining('"chatId": "oc_test1"'),
        'utf-8'
      );
    });

    it('should use provided expiresAt', async () => {
      const customExpiry = '2026-12-31T00:00:00.000Z';
      await store.registerTempChat('oc_test2', { expiresAt: customExpiry });

      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('oc_test2.json'),
        expect.stringContaining(customExpiry),
        'utf-8'
      );
    });

    it('should default to 24h expiry', async () => {
      const before = Date.now();
      await store.registerTempChat('oc_test3');
      const after = Date.now();

      const writeCall = vi.mocked(fsPromises.writeFile).mock.calls.find(
        call => call[0].toString().includes('oc_test3.json')
      );
      expect(writeCall).toBeDefined();

      const record = JSON.parse(writeCall![1] as string);
      const expiresTime = new Date(record.expiresAt).getTime();
      const expectedMin = before + 24 * 60 * 60 * 1000;
      const expectedMax = after + 24 * 60 * 60 * 1000;
      expect(expiresTime).toBeGreaterThanOrEqual(expectedMin);
      expect(expiresTime).toBeLessThanOrEqual(expectedMax);
    });

    it('should store creatorChatId and context', async () => {
      await store.registerTempChat('oc_test4', {
        creatorChatId: 'oc_original',
        context: { prNumber: 123 },
      });

      const writeCall = vi.mocked(fsPromises.writeFile).mock.calls.find(
        call => call[0].toString().includes('oc_test4.json')
      );
      expect(writeCall).toBeDefined();

      const record = JSON.parse(writeCall![1] as string);
      expect(record.creatorChatId).toBe('oc_original');
      expect(record.context).toEqual({ prNumber: 123 });
    });

    it('should handle writeFile errors gracefully', async () => {
      vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error('Write error'));
      // Should not throw
      await expect(store.registerTempChat('oc_test5')).resolves.not.toThrow();
    });

    it('should store triggerMode field (Issue #2291)', async () => {
      await store.registerTempChat('oc_test_tm', { triggerMode: 'always' });

      const writeCall = vi.mocked(fsPromises.writeFile).mock.calls.find(
        call => call[0].toString().includes('oc_test_tm.json')
      );
      expect(writeCall).toBeDefined();

      const record = JSON.parse(writeCall![1] as string);
      expect(record.triggerMode).toBe('always');
    });

    it('should persist triggerMode as undefined when not specified (Issue #2291)', async () => {
      await store.registerTempChat('oc_test_tm2');

      const writeCall = vi.mocked(fsPromises.writeFile).mock.calls.find(
        call => call[0].toString().includes('oc_test_tm2.json')
      );
      expect(writeCall).toBeDefined();

      const record = JSON.parse(writeCall![1] as string);
      expect(record.triggerMode).toBeUndefined();
    });
  });

  describe('getTempChat', () => {
    it('should return null for non-existent chat', async () => {
      const result = await store.getTempChat('oc_nonexistent');
      expect(result).toBeNull();
    });

    it('should return the registered record', async () => {
      await store.registerTempChat('oc_test1', { creatorChatId: 'oc_orig' });

      const result = await store.getTempChat('oc_test1');
      expect(result).not.toBeNull();
      expect(result!.chatId).toBe('oc_test1');
      expect(result!.creatorChatId).toBe('oc_orig');
    });
  });

  describe('listTempChats', () => {
    it('should return empty array when no chats registered', async () => {
      const result = await store.listTempChats();
      expect(result).toEqual([]);
    });

    it('should return all registered chats', async () => {
      await store.registerTempChat('oc_test1');
      await store.registerTempChat('oc_test2');

      const result = await store.listTempChats();
      expect(result).toHaveLength(2);
      expect(result.map(r => r.chatId)).toContain('oc_test1');
      expect(result.map(r => r.chatId)).toContain('oc_test2');
    });
  });

  describe('removeTempChat', () => {
    it('should return false for non-existent chat', async () => {
      const result = await store.removeTempChat('oc_nonexistent');
      expect(result).toBe(false);
    });

    it('should remove a registered chat and delete file', async () => {
      await store.registerTempChat('oc_test1');
      const result = await store.removeTempChat('oc_test1');

      expect(result).toBe(true);
      expect(fsPromises.unlink).toHaveBeenCalled();

      // Should no longer exist
      const chat = await store.getTempChat('oc_test1');
      expect(chat).toBeNull();
    });

    it('should handle unlink ENOENT gracefully', async () => {
      await store.registerTempChat('oc_test1');
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
      const response: TempChatResponse = {
        selectedValue: 'approve',
        responder: 'ou_xxx',
        repliedAt: new Date().toISOString(),
      };
      const result = await store.markTempChatResponded('oc_nonexistent', response);
      expect(result).toBe(false);
    });

    it('should update record with response and persist', async () => {
      await store.registerTempChat('oc_test1');

      const response: TempChatResponse = {
        selectedValue: 'approve',
        responder: 'ou_xxx',
        repliedAt: '2026-03-27T10:00:00.000Z',
      };
      const result = await store.markTempChatResponded('oc_test1', response);

      expect(result).toBe(true);

      // Verify persisted with response (use last call since register + markResponded both write)
      const writeCalls = vi.mocked(fsPromises.writeFile).mock.calls.filter(
        call => call[0].toString().includes('oc_test1.json')
      );
      expect(writeCalls.length).toBeGreaterThanOrEqual(2);
      const record = JSON.parse(writeCalls[writeCalls.length - 1][1] as string);
      expect(record.response.selectedValue).toBe('approve');
      expect(record.response.responder).toBe('ou_xxx');
    });

    it('should persist response even on writeFile error', async () => {
      await store.registerTempChat('oc_test1');

      // First call (register) succeeds, second call (markResponded) fails
      vi.mocked(fsPromises.writeFile).mockRejectedValueOnce(new Error('Persist error'));

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
      // Register with future expiry
      const futureExpiry = new Date(Date.now() + 60_000).toISOString();
      await store.registerTempChat('oc_test1', { expiresAt: futureExpiry });

      const expired = await store.getExpiredTempChats();
      expect(expired).toEqual([]);
    });

    it('should return chats that are expired and not responded', async () => {
      // Register with past expiry
      const pastExpiry = new Date(Date.now() - 60_000).toISOString();
      await store.registerTempChat('oc_expired1', { expiresAt: pastExpiry });

      const expired = await store.getExpiredTempChats();
      expect(expired).toHaveLength(1);
      expect(expired[0].chatId).toBe('oc_expired1');
    });

    it('should not return expired chats that have been responded', async () => {
      const pastExpiry = new Date(Date.now() - 60_000).toISOString();
      await store.registerTempChat('oc_expired1', { expiresAt: pastExpiry });

      // Mark as responded
      await store.markTempChatResponded('oc_expired1', {
        selectedValue: 'approve',
        responder: 'ou_xxx',
        repliedAt: new Date().toISOString(),
      });

      const expired = await store.getExpiredTempChats();
      expect(expired).toEqual([]);
    });

    it('should mix expired and non-expired correctly', async () => {
      const pastExpiry = new Date(Date.now() - 60_000).toISOString();
      const futureExpiry = new Date(Date.now() + 60_000).toISOString();

      await store.registerTempChat('oc_expired1', { expiresAt: pastExpiry });
      await store.registerTempChat('oc_active1', { expiresAt: futureExpiry });
      await store.registerTempChat('oc_expired2', { expiresAt: pastExpiry });

      const expired = await store.getExpiredTempChats();
      expect(expired).toHaveLength(2);
      expect(expired.map(r => r.chatId)).toContain('oc_expired1');
      expect(expired.map(r => r.chatId)).toContain('oc_expired2');
    });
  });

  describe('initialization', () => {
    it('should load existing records from disk', async () => {
      const record = {
        chatId: 'oc_existing',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        creatorChatId: 'oc_original',
      };

      vi.mocked(fsPromises.readdir).mockResolvedValue(['oc_existing.json'] as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue(JSON.stringify(record));

      const freshStore = new ChatStore({ storeDir });
      const chat = await freshStore.getTempChat('oc_existing');
      expect(chat).not.toBeNull();
      expect(chat!.chatId).toBe('oc_existing');
      expect(chat!.creatorChatId).toBe('oc_original');
    });

    it('should handle directory creation errors gracefully', async () => {
      vi.mocked(fsPromises.mkdir).mockRejectedValue(new Error('Permission denied'));

      // Should not throw — continues without persistence
      await store.registerTempChat('oc_test1');
      const result = await store.getTempChat('oc_test1');
      expect(result).not.toBeNull();
    });

    it('should load passiveMode from disk (Issue #2069)', async () => {
      const record = {
        chatId: 'oc_passive_off',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        passiveMode: false,
      };

      vi.mocked(fsPromises.readdir).mockResolvedValue(['oc_passive_off.json'] as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue(JSON.stringify(record));

      const freshStore = new ChatStore({ storeDir });
      const chat = await freshStore.getTempChat('oc_passive_off');
      expect(chat).not.toBeNull();
      expect(chat!.passiveMode).toBe(false);
    });
  });
});
