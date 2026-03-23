/**
 * Tests for auth/token-store.ts
 *
 * Tests token storage CRUD operations:
 * - Store and retrieve tokens
 * - Delete tokens
 * - List providers
 * - Access token with expiry check
 * - Cache behavior
 * - Atomic file writes
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import { TokenStore } from './token-store.js';
import type { OAuthToken } from './types.js';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  mkdir: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock Config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/test/workspace',
  },
}));

describe('TokenStore', () => {
  let store: TokenStore;
  let mockReadFile: ReturnType<typeof vi.fn>;
  let mockWriteFile: ReturnType<typeof vi.fn>;
  let mockRename: ReturnType<typeof vi.fn>;
  let mockMkdir: ReturnType<typeof vi.fn>;

  const mockToken: OAuthToken = {
    accessToken: 'test-access-token',
    tokenType: 'Bearer',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3600000, // 1 hour from now
  };

  const expiredToken: OAuthToken = {
    accessToken: 'expired-access-token',
    tokenType: 'Bearer',
    createdAt: Date.now() - 7200000, // 2 hours ago
    expiresAt: Date.now() - 3600000, // 1 hour ago (expired)
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockReadFile = vi.mocked(fs.readFile);
    mockWriteFile = vi.mocked(fs.writeFile);
    mockRename = vi.mocked(fs.rename);
    mockMkdir = vi.mocked(fs.mkdir);

    // Default: no existing file
    mockReadFile.mockRejectedValue({ code: 'ENOENT' });
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);

    store = new TokenStore('/test/workspace/.auth-tokens.json');
  });

  describe('constructor', () => {
    it('should use provided storage path', () => {
      const customStore = new TokenStore('/custom/path/tokens.json');
      // Trigger a load to verify path is used
      mockReadFile.mockRejectedValue({ code: 'ENOENT' });
      return expect(customStore.hasToken('chat1', 'provider1')).resolves.toBe(false);
    });
  });

  describe('setToken / getToken', () => {
    it('should store and retrieve a token', async () => {
      await store.setToken('chat1', 'github', mockToken);
      const result = await store.getToken('chat1', 'github');

      expect(result).toBeTruthy();
      expect(result?.accessToken).toBe('test-access-token');
      expect(result?.tokenType).toBe('Bearer');
    });

    it('should return null for non-existent token', async () => {
      const result = await store.getToken('chat1', 'nonexistent');
      expect(result).toBeNull();
    });

    it('should use cache after first load', async () => {
      await store.setToken('chat1', 'github', mockToken);

      // getFile is called once during setToken
      const readFileCalls = mockReadFile.mock.calls.length;

      // Second call should use cache
      await store.getToken('chat1', 'github');
      expect(mockReadFile.mock.calls.length).toBe(readFileCalls);
    });

    it('should overwrite existing token', async () => {
      const newToken: OAuthToken = {
        accessToken: 'new-access-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await store.setToken('chat1', 'github', mockToken);
      await store.setToken('chat1', 'github', newToken);

      const result = await store.getToken('chat1', 'github');
      expect(result).not.toBeNull();
      expect(result?.accessToken).toBe('new-access-token');
    });

    it('should store tokens for different providers separately', async () => {
      await store.setToken('chat1', 'github', mockToken);
      await store.setToken('chat1', 'gitlab', {
        ...mockToken,
        accessToken: 'gitlab-token',
      });

      const githubToken = await store.getToken('chat1', 'github');
      const gitlabToken = await store.getToken('chat1', 'gitlab');

      expect(githubToken).not.toBeNull();
      expect(githubToken?.accessToken).toBe('test-access-token');
      expect(gitlabToken).not.toBeNull();
      expect(gitlabToken?.accessToken).toBe('gitlab-token');
    });
  });

  describe('hasToken', () => {
    it('should return true when token exists', async () => {
      await store.setToken('chat1', 'github', mockToken);
      expect(await store.hasToken('chat1', 'github')).toBe(true);
    });

    it('should return false when token does not exist', async () => {
      expect(await store.hasToken('chat1', 'nonexistent')).toBe(false);
    });
  });

  describe('deleteToken', () => {
    it('should delete an existing token', async () => {
      await store.setToken('chat1', 'github', mockToken);
      const deleted = await store.deleteToken('chat1', 'github');

      expect(deleted).toBe(true);
      expect(await store.hasToken('chat1', 'github')).toBe(false);
    });

    it('should return false when token does not exist', async () => {
      const deleted = await store.deleteToken('chat1', 'nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('listProviders', () => {
    it('should list all providers for a chat', async () => {
      await store.setToken('chat1', 'github', mockToken);
      await store.setToken('chat1', 'gitlab', mockToken);
      await store.setToken('chat1', 'notion', mockToken);

      const providers = await store.listProviders('chat1');

      expect(providers).toContain('github');
      expect(providers).toContain('gitlab');
      expect(providers).toContain('notion');
      expect(providers).toHaveLength(3);
    });

    it('should not include providers from other chats', async () => {
      await store.setToken('chat1', 'github', mockToken);
      await store.setToken('chat2', 'gitlab', mockToken);

      const chat1Providers = await store.listProviders('chat1');
      expect(chat1Providers).toEqual(['github']);
    });

    it('should return empty array when no tokens exist', async () => {
      const providers = await store.listProviders('chat1');
      expect(providers).toEqual([]);
    });
  });

  describe('getAccessToken', () => {
    it('should return access token for valid token', async () => {
      await store.setToken('chat1', 'github', mockToken);
      const token = await store.getAccessToken('chat1', 'github');

      expect(token).toBe('test-access-token');
    });

    it('should return null for non-existent token', async () => {
      const token = await store.getAccessToken('chat1', 'nonexistent');
      expect(token).toBeNull();
    });

    it('should return null for expired token', async () => {
      await store.setToken('chat1', 'github', expiredToken);
      const token = await store.getAccessToken('chat1', 'github');

      expect(token).toBeNull();
    });

    it('should return access token for token without expiresAt', async () => {
      const tokenNoExpiry: OAuthToken = {
        accessToken: 'no-expiry-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await store.setToken('chat1', 'github', tokenNoExpiry);
      const token = await store.getAccessToken('chat1', 'github');

      expect(token).toBe('no-expiry-token');
    });
  });

  describe('clearCache', () => {
    it('should clear the in-memory cache', async () => {
      await store.setToken('chat1', 'github', mockToken);
      store.clearCache();

      // After clearing cache, readFile should be called again
      mockReadFile.mockRejectedValueOnce({ code: 'ENOENT' });
      const result = await store.getToken('chat1', 'github');

      expect(result).toBeNull();
    });
  });

  describe('file operations', () => {
    it('should write atomically using temp file', async () => {
      await store.setToken('chat1', 'github', mockToken);

      expect(mockWriteFile).toHaveBeenCalledWith(
        '/test/workspace/.auth-tokens.json.tmp',
        expect.any(String),
        'utf-8'
      );
      expect(mockRename).toHaveBeenCalledWith(
        '/test/workspace/.auth-tokens.json.tmp',
        '/test/workspace/.auth-tokens.json'
      );
    });

    it('should create directory if it does not exist', async () => {
      await store.setToken('chat1', 'github', mockToken);

      expect(mockMkdir).toHaveBeenCalledWith(
        '/test/workspace',
        { recursive: true }
      );
    });

    it('should handle corrupted storage file gracefully', async () => {
      mockReadFile.mockResolvedValue('not-valid-json');

      await expect(store.getToken('chat1', 'github')).rejects.toThrow();
    });
  });
});
