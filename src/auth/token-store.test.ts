/**
 * Tests for auth/token-store.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { TokenStore } from './token-store.js';
import type { OAuthToken } from './types.js';

describe('TokenStore', () => {
  let tempDir: string;
  let store: TokenStore;

  beforeEach(async () => {
    // Create temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'token-store-test-'));
    const storagePath = path.join(tempDir, 'tokens.json');
    store = new TokenStore(storagePath);
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('setToken and getToken', () => {
    it('should store and retrieve a token', async () => {
      const token: OAuthToken = {
        accessToken: 'test-access-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await store.setToken('chat-1', 'github', token);
      const retrieved = await store.getToken('chat-1', 'github');

      expect(retrieved).not.toBeNull();
      expect(retrieved!.accessToken).toBe('test-access-token');
      expect(retrieved!.tokenType).toBe('Bearer');
    });

    it('should store multiple tokens for different providers', async () => {
      const githubToken: OAuthToken = {
        accessToken: 'github-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      const gitlabToken: OAuthToken = {
        accessToken: 'gitlab-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await store.setToken('chat-1', 'github', githubToken);
      await store.setToken('chat-1', 'gitlab', gitlabToken);

      const retrievedGithub = await store.getToken('chat-1', 'github');
      const retrievedGitlab = await store.getToken('chat-1', 'gitlab');

      expect(retrievedGithub!.accessToken).toBe('github-token');
      expect(retrievedGitlab!.accessToken).toBe('gitlab-token');
    });

    it('should store tokens for different chats', async () => {
      const token1: OAuthToken = {
        accessToken: 'token-chat-1',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      const token2: OAuthToken = {
        accessToken: 'token-chat-2',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await store.setToken('chat-1', 'github', token1);
      await store.setToken('chat-2', 'github', token2);

      const retrieved1 = await store.getToken('chat-1', 'github');
      const retrieved2 = await store.getToken('chat-2', 'github');

      expect(retrieved1!.accessToken).toBe('token-chat-1');
      expect(retrieved2!.accessToken).toBe('token-chat-2');
    });

    it('should return null for non-existent token', async () => {
      const retrieved = await store.getToken('unknown-chat', 'unknown-provider');
      expect(retrieved).toBeNull();
    });

    it('should update existing token', async () => {
      const token1: OAuthToken = {
        accessToken: 'old-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      const token2: OAuthToken = {
        accessToken: 'new-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await store.setToken('chat-1', 'github', token1);
      await store.setToken('chat-1', 'github', token2);

      const retrieved = await store.getToken('chat-1', 'github');
      expect(retrieved!.accessToken).toBe('new-token');
    });
  });

  describe('hasToken', () => {
    it('should return true for existing token', async () => {
      const token: OAuthToken = {
        accessToken: 'test-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await store.setToken('chat-1', 'github', token);

      expect(await store.hasToken('chat-1', 'github')).toBe(true);
    });

    it('should return false for non-existent token', async () => {
      expect(await store.hasToken('unknown-chat', 'github')).toBe(false);
    });
  });

  describe('deleteToken', () => {
    it('should delete an existing token', async () => {
      const token: OAuthToken = {
        accessToken: 'test-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await store.setToken('chat-1', 'github', token);
      const deleted = await store.deleteToken('chat-1', 'github');

      expect(deleted).toBe(true);
      expect(await store.getToken('chat-1', 'github')).toBeNull();
    });

    it('should return false for non-existent token', async () => {
      const deleted = await store.deleteToken('unknown-chat', 'github');
      expect(deleted).toBe(false);
    });
  });

  describe('listProviders', () => {
    it('should list all providers for a chat', async () => {
      const token: OAuthToken = {
        accessToken: 'test-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await store.setToken('chat-1', 'github', token);
      await store.setToken('chat-1', 'gitlab', token);
      await store.setToken('chat-2', 'notion', token);

      const providers = await store.listProviders('chat-1');

      expect(providers).toHaveLength(2);
      expect(providers).toContain('github');
      expect(providers).toContain('gitlab');
      expect(providers).not.toContain('notion');
    });

    it('should return empty array for chat with no tokens', async () => {
      const providers = await store.listProviders('unknown-chat');
      expect(providers).toEqual([]);
    });
  });

  describe('getAccessToken', () => {
    it('should return the access token', async () => {
      const token: OAuthToken = {
        accessToken: 'test-access-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };

      await store.setToken('chat-1', 'github', token);

      const accessToken = await store.getAccessToken('chat-1', 'github');
      expect(accessToken).toBe('test-access-token');
    });

    it('should return null for expired token', async () => {
      const token: OAuthToken = {
        accessToken: 'expired-token',
        tokenType: 'Bearer',
        createdAt: Date.now() - 7200000, // 2 hours ago
        expiresAt: Date.now() - 3600000, // Expired 1 hour ago
      };

      await store.setToken('chat-1', 'github', token);

      const accessToken = await store.getAccessToken('chat-1', 'github');
      expect(accessToken).toBeNull();
    });

    it('should return token for non-expired token', async () => {
      const token: OAuthToken = {
        accessToken: 'valid-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000, // Expires in 1 hour
      };

      await store.setToken('chat-1', 'github', token);

      const accessToken = await store.getAccessToken('chat-1', 'github');
      expect(accessToken).toBe('valid-token');
    });
  });

  describe('persistence', () => {
    it('should persist tokens across store instances', async () => {
      const storagePath = path.join(tempDir, 'persistent-tokens.json');

      // Create first store and save token
      const store1 = new TokenStore(storagePath);
      const token: OAuthToken = {
        accessToken: 'persistent-token',
        tokenType: 'Bearer',
        createdAt: Date.now(),
      };
      await store1.setToken('chat-1', 'github', token);

      // Create second store with same path
      const store2 = new TokenStore(storagePath);
      const retrieved = await store2.getToken('chat-1', 'github');

      expect(retrieved!.accessToken).toBe('persistent-token');
    });
  });
});
