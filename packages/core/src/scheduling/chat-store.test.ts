/**
 * Unit tests for TempChatStore
 *
 * Issue #1703: Temporary chat lifecycle management.
 * Follows the CooldownManager test pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TempChatStore } from './chat-store.js';
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

describe('TempChatStore', () => {
  let store: TempChatStore;
  let tempChatsDir: string;

  beforeEach(() => {
    tempChatsDir = '/tmp/test-temp-chats';
    store = new TempChatStore({ tempChatsDir });

    // Mock mkdir to succeed
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    // Mock readdir to return empty
    vi.mocked(fsPromises.readdir).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create a TempChatStore', () => {
      expect(store).toBeDefined();
    });
  });

  describe('registerTempChat', () => {
    it('should register a temp chat with default expiry', async () => {
      const record = await store.registerTempChat({ chatId: 'oc_test1' });

      expect(record.chatId).toBe('oc_test1');
      expect(record.createdAt).toBeDefined();
      expect(record.expiresAt).toBeDefined();
      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('oc_test1.json'),
        expect.stringContaining('"chatId": "oc_test1"'),
        'utf-8'
      );
    });

    it('should register a temp chat with custom expiry', async () => {
      const expiresAt = '2026-12-31T00:00:00.000Z';
      const record = await store.registerTempChat({ chatId: 'oc_test2', expiresAt });

      expect(record.expiresAt).toBe(expiresAt);
    });

    it('should register a temp chat with creatorChatId and context', async () => {
      const record = await store.registerTempChat({
        chatId: 'oc_test3',
        creatorChatId: 'oc_creator',
        context: { prNumber: 123, type: 'review' },
      });

      expect(record.creatorChatId).toBe('oc_creator');
      expect(record.context).toEqual({ prNumber: 123, type: 'review' });
    });

    it('should throw on duplicate registration', async () => {
      await store.registerTempChat({ chatId: 'oc_dup' });
      await expect(store.registerTempChat({ chatId: 'oc_dup' })).rejects.toThrow(
        'Temp chat already registered: oc_dup'
      );
    });

    it('should handle writeFile errors gracefully', async () => {
      vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error('Write error'));
      // Should not throw — record still exists in memory
      const record = await store.registerTempChat({ chatId: 'oc_err' });
      expect(record.chatId).toBe('oc_err');
    });
  });

  describe('getTempChat', () => {
    it('should return null for non-existent chat', async () => {
      const result = await store.getTempChat('oc_nonexistent');
      expect(result).toBeNull();
    });

    it('should return the record for an existing chat', async () => {
      await store.registerTempChat({ chatId: 'oc_exists' });
      const result = await store.getTempChat('oc_exists');

      expect(result).not.toBeNull();
      expect(result!.chatId).toBe('oc_exists');
      expect(result!.createdAt).toBeDefined();
      expect(result!.expiresAt).toBeDefined();
    });
  });

  describe('listTempChats', () => {
    it('should return empty array when no chats are registered', async () => {
      const chats = await store.listTempChats();
      expect(chats).toEqual([]);
    });

    it('should return all registered chats', async () => {
      await store.registerTempChat({ chatId: 'oc_chat1' });
      await store.registerTempChat({ chatId: 'oc_chat2' });
      await store.registerTempChat({ chatId: 'oc_chat3' });

      const chats = await store.listTempChats();
      expect(chats).toHaveLength(3);
      expect(chats.map(c => c.chatId)).toEqual(['oc_chat1', 'oc_chat2', 'oc_chat3']);
    });
  });

  describe('removeTempChat', () => {
    it('should return false for non-existent chat', async () => {
      const result = await store.removeTempChat('oc_nonexistent');
      expect(result).toBe(false);
    });

    it('should remove an existing chat and return true', async () => {
      await store.registerTempChat({ chatId: 'oc_remove' });
      const result = await store.removeTempChat('oc_remove');

      expect(result).toBe(true);
      expect(fsPromises.unlink).toHaveBeenCalled();

      // Should no longer exist
      const get = await store.getTempChat('oc_remove');
      expect(get).toBeNull();
    });

    it('should handle unlink ENOENT gracefully', async () => {
      await store.registerTempChat({ chatId: 'oc_unlink' });
      const enoentError = new Error('Not found') as NodeJS.ErrnoException;
      enoentError.code = 'ENOENT';
      vi.mocked(fsPromises.unlink).mockRejectedValue(enoentError);

      // Should not throw, still removed from memory
      const result = await store.removeTempChat('oc_unlink');
      expect(result).toBe(true);
    });
  });

  describe('markTempChatResponded', () => {
    it('should return null for non-existent chat', async () => {
      const result = await store.markTempChatResponded('oc_nonexistent', {
        selectedValue: 'approve',
        responder: 'ou_user1',
        repliedAt: '2026-03-28T00:00:00.000Z',
      });
      expect(result).toBeNull();
    });

    it('should mark a chat as responded and persist', async () => {
      await store.registerTempChat({ chatId: 'oc_respond' });

      const response = {
        selectedValue: 'approve',
        responder: 'ou_user1',
        repliedAt: '2026-03-28T00:00:00.000Z',
      };
      const result = await store.markTempChatResponded('oc_respond', response);

      expect(result).not.toBeNull();
      expect(result!.response).toEqual(response);

      // Verify persisted
      expect(fsPromises.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('oc_respond.json'),
        expect.stringContaining('"selectedValue": "approve"'),
        'utf-8'
      );
    });

    it('should handle writeFile errors gracefully on mark', async () => {
      await store.registerTempChat({ chatId: 'oc_mark_err' });
      vi.mocked(fsPromises.writeFile).mockRejectedValue(new Error('Write error'));

      const result = await store.markTempChatResponded('oc_mark_err', {
        selectedValue: 'reject',
        responder: 'ou_user2',
        repliedAt: '2026-03-28T00:00:00.000Z',
      });

      // Should still update in memory
      expect(result).not.toBeNull();
      expect(result!.response?.selectedValue).toBe('reject');
    });
  });

  describe('getExpiredTempChats', () => {
    it('should return empty array when no chats are expired', async () => {
      await store.registerTempChat({ chatId: 'oc_active' });
      const expired = await store.getExpiredTempChats();
      expect(expired).toEqual([]);
    });

    it('should return expired chats', async () => {
      // Register a chat that already expired (past timestamp)
      const pastExpiry = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      await store.registerTempChat({ chatId: 'oc_expired', expiresAt: pastExpiry });

      // Register an active chat
      const futureExpiry = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
      await store.registerTempChat({ chatId: 'oc_active', expiresAt: futureExpiry });

      const expired = await store.getExpiredTempChats();
      expect(expired).toHaveLength(1);
      expect(expired[0].chatId).toBe('oc_expired');
    });

    it('should return all chats when all are expired', async () => {
      const pastExpiry = new Date(Date.now() - 1000).toISOString();
      await store.registerTempChat({ chatId: 'oc_exp1', expiresAt: pastExpiry });
      await store.registerTempChat({ chatId: 'oc_exp2', expiresAt: pastExpiry });

      const expired = await store.getExpiredTempChats();
      expect(expired).toHaveLength(2);
    });
  });

  describe('initialization', () => {
    it('should load existing records from disk', async () => {
      const record = {
        chatId: 'oc_loaded',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };

      vi.mocked(fsPromises.readdir).mockResolvedValue(['oc_loaded.json'] as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue(JSON.stringify(record));

      const freshStore = new TempChatStore({ tempChatsDir });
      const loaded = await freshStore.getTempChat('oc_loaded');
      expect(loaded).not.toBeNull();
      expect(loaded!.chatId).toBe('oc_loaded');
    });

    it('should handle directory creation errors gracefully', async () => {
      vi.mocked(fsPromises.mkdir).mockRejectedValue(new Error('Permission denied'));
      vi.mocked(fsPromises.readdir).mockRejectedValue(new Error('ENOENT'));

      // Should not throw — continues without persistence
      const result = await store.registerTempChat({ chatId: 'oc_perm_err' });
      expect(result.chatId).toBe('oc_perm_err');
    });
  });

  describe('DEFAULT_TTL_MS', () => {
    it('should be 24 hours', () => {
      expect(TempChatStore.DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
    });
  });
});
