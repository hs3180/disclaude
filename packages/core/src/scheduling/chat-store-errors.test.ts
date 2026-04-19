/**
 * Additional tests for ChatStore error handling paths
 *
 * Covers uncovered branches:
 * - Non-ENOENT errors during loadFromDisk (lines 159-162)
 * - Non-ENOENT errors during removeTempChat (lines 251-252)
 * - Individual file parse errors during loadFromDisk (lines 152-154)
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatStore } from './chat-store.js';
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

describe('ChatStore — error handling', () => {
  let store: ChatStore;
  const storeDir = '/tmp/test-chat-store-errors';

  beforeEach(() => {
    store = new ChatStore({ storeDir });
    vi.mocked(fsPromises.mkdir).mockResolvedValue(undefined);
    vi.mocked(fsPromises.readdir).mockResolvedValue([]);
    vi.mocked(fsPromises.writeFile).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('loadFromDisk error handling', () => {
    it('should handle non-ENOENT errors during directory read', async () => {
      const permissionError = new Error('Permission denied') as NodeJS.ErrnoException;
      permissionError.code = 'EACCES';
      vi.mocked(fsPromises.mkdir).mockRejectedValue(permissionError);

      const freshStore = new ChatStore({ storeDir });
      // Should not throw — store continues without persistence
      await freshStore.registerTempChat('oc_test');
      const result = await freshStore.getTempChat('oc_test');
      expect(result).not.toBeNull();
      expect(result!.chatId).toBe('oc_test');
    });

    it('should skip individual files with JSON parse errors', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue(['bad.json', 'good.json'] as any);
      vi.mocked(fsPromises.readFile)
        .mockRejectedValueOnce(new Error('Not found'))
        .mockResolvedValueOnce(JSON.stringify({
          chatId: 'oc_good',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        }));

      const freshStore = new ChatStore({ storeDir });
      const good = await freshStore.getTempChat('oc_good');
      expect(good).not.toBeNull();
      expect(good!.chatId).toBe('oc_good');

      // bad.json was skipped but didn't prevent loading
      const bad = await freshStore.getTempChat('oc_bad');
      expect(bad).toBeNull();
    });

    it('should skip files that contain invalid JSON', async () => {
      vi.mocked(fsPromises.readdir).mockResolvedValue(['invalid.json'] as any);
      vi.mocked(fsPromises.readFile).mockResolvedValue('not valid json');

      const freshStore = new ChatStore({ storeDir });
      // Should not throw — parse errors are caught per file
      const result = await freshStore.listTempChats();
      expect(result).toEqual([]);
    });
  });

  describe('removeTempChat error handling', () => {
    it('should handle non-ENOENT unlink errors gracefully', async () => {
      await store.registerTempChat('oc_test1');

      const permissionError = new Error('Permission denied') as NodeJS.ErrnoException;
      permissionError.code = 'EACCES';
      vi.mocked(fsPromises.unlink).mockRejectedValue(permissionError);

      // Should not throw
      const result = await store.removeTempChat('oc_test1');
      expect(result).toBe(true);

      // In-memory record should be removed even if file delete failed
      const chat = await store.getTempChat('oc_test1');
      expect(chat).toBeNull();
    });
  });
});
